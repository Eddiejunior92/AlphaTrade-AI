// =============================================================================
// Meta-Review Service — daily after-close council deliberation
// =============================================================================
// Triggered after the daily P&L report is sent. Runs the Intelligence Council
// against the day's actual trade outcomes + portfolio state + cost ledger to
// produce a small set of SCORED, NUMBERED suggestions for the operator. Each
// suggestion targets ONE config parameter from discordApprovalService.SAFE_KEYS
// — anything else is descriptive only and won't be approvable from Discord.
//
// Suggestions land in `pending_suggestions` table and are posted to Discord
// with their numeric IDs so the operator can reply "Approve #N" / "Reject #N".
//
// SAFETY: this service is INFORMATIONAL. It can ONLY add rows to
// pending_suggestions; it cannot change config itself. The
// discordApprovalService gates every actual change behind its SAFE_KEYS
// allowlist + audit row.
// =============================================================================

const axios = require('axios');
const db = require('./db');
const router = require('./llmRouterService');
const dynamicGate = require('./dynamicGateService');
const approval = require('./discordApprovalService');
const discord = require('./discordService');
const costTracker = require('./llmCostTracker');
const calibration = require('./calibrationService');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const TIMEOUT_MS = parseInt(process.env.META_REVIEW_TIMEOUT_MS || '45000');

const MODEL_REGISTRY = {
  gemini: { provider: 'openrouter', model: 'google/gemini-2.0-flash-001' },
  grok:   { provider: 'xai',        model: 'grok-4-fast-non-reasoning' },
  claude: { provider: 'openrouter', model: 'anthropic/claude-3.7-sonnet' },
  gpt4o:  { provider: 'openrouter', model: 'openai/gpt-4o' },
};

const REVIEW_POOL = ['claude', 'gpt4o', 'gemini', 'grok'];

function _extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function _callModel(modelId, systemPrompt, userPrompt, market) {
  const model = MODEL_REGISTRY[modelId];
  if (!model) return { ok: false, reason: 'unknown_model' };
  const key = model.provider === 'xai'
    ? (process.env.XAI_API_KEY || process.env.GROK_API_KEY)
    : process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, reason: 'missing_api_key' };
  const url = model.provider === 'xai' ? XAI_URL : OPENROUTER_URL;
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (model.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://alphatrade.ai';
    headers['X-Title'] = 'AlphaTrade Meta-Review';
  }
  try {
    const r = await axios.post(url, {
      model: model.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: 1400,
      response_format: { type: 'json_object' },
    }, { headers, timeout: TIMEOUT_MS });
    try { costTracker.recordUsage({ service: 'meta_review', market: market || 'SHARED', modelId: model.model, response: r.data }); } catch (_) {}
    const text = r.data?.choices?.[0]?.message?.content || '';
    const parsed = _extractJson(text);
    return parsed ? { ok: true, parsed } : { ok: false, reason: 'parse_failed' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Pull yesterday's-day's facts from the DB so the council has hard numbers.
async function _gatherFacts(market) {
  const tz = market === 'ASX' ? 'Australia/Sydney' : 'America/New_York';
  const facts = {};
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE won)::int AS w,
             COALESCE(SUM(pnl_usd), 0)::float AS pnl,
             COALESCE(AVG(pnl_usd), 0)::float AS avg_pnl
      FROM trade_memory
      WHERE market = $1 AND (created_at AT TIME ZONE $2)::date = NOW() AT TIME ZONE $2
    `.replace('NOW() AT TIME ZONE $2', `(NOW() AT TIME ZONE $2)::date`), [market, tz]);
    facts.today = r.rows[0];
  } catch (_) { facts.today = null; }
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE won)::int AS w,
             COALESCE(SUM(pnl_usd), 0)::float AS pnl
      FROM trade_memory
      WHERE market = $1 AND created_at >= NOW() - INTERVAL '7 days'
    `, [market]);
    facts.week = r.rows[0];
  } catch (_) { facts.week = null; }
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE won)::int AS w
      FROM trade_memory
      WHERE market = $1 AND created_at >= NOW() - INTERVAL '3 days'
    `, [market]);
    facts.three_day = r.rows[0];
  } catch (_) { facts.three_day = null; }
  try {
    const r = await db.query(`
      SELECT event_type, COUNT(*)::int AS n
      FROM audit_log
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND event_type IN ('TRADE_REJECTED','CIRCUIT_BREAKER_TRIPPED','DYNAMIC_GATE_PIN_CHANGE','DYNAMIC_GATE_ADJUSTED','SIGNAL')
      GROUP BY event_type
    `);
    facts.audit_24h = r.rows;
  } catch (_) { facts.audit_24h = []; }
  facts.gate = await dynamicGate.getStatus();
  facts.allowed_keys = Object.keys(approval.SAFE_KEYS).map(k => ({
    key: k, description: approval.SAFE_KEYS[k].description,
  }));
  return facts;
}

const SYSTEM_PROMPT = `You are the META-REVIEW JUDGE for an autonomous trading system. After every trading day you read the day's outcomes + 7-day stats + 3-day rolling win rate + recent audit events + the CURRENT effective dynamic gate.

Your job: emit 3-5 SCORED, NUMBERED suggestions for the operator. Each must target ONE parameter from the allowlist provided. Anything not in the allowlist will be auto-rejected, so don't propose changes outside it.

Score each suggestion on:
  • impact: H / M / L  (expected effect on win rate or P&L)
  • effort: E (easy)  / M / H  (operator effort to evaluate)
  • confidence: 0..1   (your conviction this is correct)

NEVER suggest changes to: kill switch, circuit breaker, max position pct, daily loss budget, drawdown breaker, recovery buffer, quorum count, safety floor (0.65), atomic cash math, audit chain. The operator cannot apply these via Discord regardless.

Respond with valid JSON:
{
  "summary": "<1 paragraph about the day>",
  "suggestions": [
    {
      "title": "<short title>",
      "target_key": "<one of the allowed keys>",
      "target_value": "<the proposed new value as a string>",
      "impact": "H|M|L",
      "effort": "E|M|H",
      "confidence": 0..1,
      "rationale": "<2-3 sentences explaining WHY>"
    }
  ]
}`;

async function runReview(market = 'US') {
  const facts = await _gatherFacts(market);
  // Phase B: run calibration audit FIRST so its output can be added to the
  // facts the council reads + posted in the Discord summary. Best-effort.
  let calibrationAudit = null;
  try { calibrationAudit = await calibration.runDailyCalibrationAudit({ market }); } catch (_) {}
  facts.calibration = calibrationAudit;
  const userPrompt = `MARKET: ${market}
FACTS:
${JSON.stringify(facts, null, 2)}

ALLOWED KEYS (you must target one of these per suggestion):
${facts.allowed_keys.map(k => `  • ${k.key} — ${k.description}`).join('\n')}

CURRENT EFFECTIVE GATE: ${(facts.gate.effective_gate*100).toFixed(0)}%  (base ${(facts.gate.base_gate*100).toFixed(0)}%, council Δ ${(facts.gate.council_delta*100).toFixed(1)}pp, pinned: ${facts.gate.pinned})

Produce 3-5 numbered suggestions in JSON.`;

  // Pick best model for this task via the router.
  const pick = await router.pickModel('meta_review', REVIEW_POOL);
  let res = await _callModel(pick.modelId, SYSTEM_PROMPT, userPrompt, market);
  if (!res.ok && pick.modelId !== 'grok') {
    // Fallback to Grok (xAI billing path is usually healthier).
    res = await _callModel('grok', SYSTEM_PROMPT, userPrompt, market);
  }
  if (!res.ok) {
    return { ok: false, reason: res.reason };
  }
  const out = res.parsed;
  const summary = String(out.summary || '').slice(0, 800);
  const sugs = Array.isArray(out.suggestions) ? out.suggestions.slice(0, 8) : [];
  const stored = [];
  for (const s of sugs) {
    try {
      const id = await approval.addSuggestion({
        title: s.title,
        target_key: s.target_key,
        target_value: s.target_value,
        impact: s.impact, effort: s.effort, confidence: s.confidence,
        rationale: s.rationale,
        source: `meta_review_${market}`,
      });
      stored.push({ id, ...s });
    } catch (e) {
      // skip individual broken suggestion
    }
  }
  // Auto-apply council gate suggestion as a delta (still clamped 0.65-0.90).
  // The meta-review is allowed to nudge the gate ±5pp / day max.
  // (Operator can also Approve a confidence_gate_base suggestion to set it explicitly.)
  // — left out by default to keep this a pure proposal layer; the per-cycle
  //   council deliberation is the live adjustment path.

  // Phase B: if calibration audit flagged a chronically miscalibrated bucket,
  // synthesize a numbered suggestion targeting confidence_gate_base. This is
  // ALWAYS gated through the same Discord Approve flow — never auto-applied.
  if (calibrationAudit && calibrationAudit.ok && calibrationAudit.flagged_buckets?.length) {
    try {
      const flagged = calibrationAudit.flagged_buckets[0];
      // Direction: realized < predicted → over-confident → RAISE the gate.
      // Realized > predicted → under-confident → keep gate (no relax suggested).
      const realized = parseFloat(flagged.realized_wr);
      const predicted = parseFloat(flagged.predicted_avg);
      const gateNow = parseFloat(facts.gate?.base_gate || 0.80);
      let suggestedGate = gateNow;
      if (Number.isFinite(realized) && Number.isFinite(predicted) && realized < predicted) {
        // Tighten by 2pp — bounded by SAFETY_CEIL (0.90) inside dynamicGate.
        suggestedGate = Math.min(0.90, +(gateNow + 0.02).toFixed(2));
      }
      if (suggestedGate !== gateNow) {
        const id = await approval.addSuggestion({
          title: `Calibration miscalibration in ${flagged.bucket} bucket → tighten gate`,
          target_key: 'confidence_gate_base',
          target_value: String(suggestedGate),
          impact: 'M', effort: 'E', confidence: 0.7,
          rationale: `${calibrationAudit.flag_required_days}+ consecutive days of |gap|>${(calibrationAudit.gap_threshold*100).toFixed(0)}pp in the ${flagged.bucket} confidence bucket. Realized WR ${(realized*100).toFixed(0)}% vs predicted ${(predicted*100).toFixed(0)}%. Tightening base gate +2pp to demand more conviction.`,
          source: `calibration_${market}`,
        });
        stored.push({ id, title: `Calibration: tighten gate to ${suggestedGate}`, target_key: 'confidence_gate_base', target_value: String(suggestedGate), impact: 'M', effort: 'E', confidence: 0.7, rationale: 'see audit table' });
      }
    } catch (_) {}
  }

  // Post to Discord.
  await _postReviewToDiscord(market, summary, stored, facts, calibrationAudit);
  return { ok: true, summary, suggestions: stored, facts, calibration: calibrationAudit };
}

async function _postReviewToDiscord(market, summary, suggestions, facts, calibrationAudit) {
  const flag = market === 'ASX' ? '🇦🇺' : '🇺🇸';
  const lines = [
    `🧠 **${flag} ${market} Daily Meta-Review**`,
    '─────────────────────────────',
    `**Summary**: ${summary}`,
    '',
    `**3-day win rate**: ${facts.three_day && facts.three_day.n > 0 ? `${(facts.three_day.w/facts.three_day.n*100).toFixed(0)}% (${facts.three_day.w}/${facts.three_day.n})` : 'insufficient data'}`,
    `**Effective gate**: ${(facts.gate.effective_gate*100).toFixed(0)}%${facts.gate.pinned ? ` (PINNED — ${facts.gate.pin_reason})` : ''}`,
    '',
    `📋 **Scored Suggestions** (${suggestions.length})`,
  ];
  for (const s of suggestions) {
    lines.push(`**#${s.id}** [${s.impact}/${s.effort}, conf ${(parseFloat(s.confidence)*100).toFixed(0)}%] ${s.title}`);
    lines.push(`   → \`${s.target_key}\` = \`${s.target_value}\``);
    lines.push(`   _${s.rationale}_`);
  }
  // Phase B: append calibration markdown table if audit ran.
  if (calibrationAudit && calibrationAudit.ok) {
    const md = calibration.renderCalibrationMarkdown(calibrationAudit);
    if (md) lines.push(md);
  }
  lines.push('');
  lines.push('Reply `Approve #N` to apply, `Reject #N` to dismiss, or `Status` to list pending.');
  try {
    await discord.sendAlert({
      title: `${flag} ${market} Meta-Review`,
      description: lines.join('\n').slice(0, 3500),
      color: 0x9b59b6,
      fields: [],
    });
  } catch (e) { /* webhook failure is non-fatal */ }
}

module.exports = { runReview };
