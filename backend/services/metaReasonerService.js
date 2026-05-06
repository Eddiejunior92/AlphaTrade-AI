// Meta-Reasoner Layer.
//
// After the 4 ensemble models vote, we run a single FINAL synthesiser pass
// that's given the raw votes + dynamic weights + key context, and asked to
// produce one calibrated "meta opinion" (action + confidence + rationale).
//
// SAFETY CONTRACT: this output is STRICTLY INFORMATIONAL. It is surfaced
// in the audit log, the dashboard, and (next cycle) injected as a prompt
// block so the 4 voters can see/disagree with the prior meta-take. It does
// NOT replace the raw quorum decision and does NOT loosen the gate. The
// risk manager's 3-of-4 quorum + 85% confidence threshold + $100/day USD
// loss budget + 5% drawdown breaker + kill switch all retain full veto.
//
// Implementation notes:
//   • Uses the existing OpenRouter pipeline (Claude 3.7 Sonnet by default,
//     overridable via META_REASONER_MODEL env). Same 20s timeout + same
//     output shape parser as the ensemble voters.
//   • Lower max_tokens (200) and slightly lower temperature (0.2) for a
//     more deterministic synthesis.
//   • Returns null on ANY failure — caller must treat null as "no meta
//     opinion this cycle" and proceed with raw quorum unchanged.

const axios = require('axios');
const costTracker = require('./llmCostTracker');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const META_MODEL = process.env.META_REASONER_MODEL || 'anthropic/claude-3.7-sonnet';
const META_TIMEOUT_MS = parseInt(process.env.META_REASONER_TIMEOUT_MS || '15000');

function parseMetaResponse(text) {
  const decisionMatch = text.match(/DECISION:\s*(BUY|SELL|HOLD)/i);
  const confidenceMatch = text.match(/CONFIDENCE:\s*(\d+(?:\.\d+)?)/i);
  const rationaleMatch = text.match(/RATIONALE:\s*([\s\S]+)/i);
  if (!decisionMatch) return null;
  return {
    action: decisionMatch[1].toUpperCase(),
    confidence: confidenceMatch ? Math.min(100, parseFloat(confidenceMatch[1])) / 100 : 0.5,
    rationale: rationaleMatch ? rationaleMatch[1].trim().slice(0, 400) : text.slice(0, 200),
  };
}

function buildMetaPrompt({ symbol, strategy, regime, market, votes, weights, modelResults }) {
  const w = weights?.weights || {};
  const lines = modelResults.map(r => {
    const wt = w[r.model]?.weight ?? 1.0;
    const conf = (r.confidence * 100).toFixed(0);
    const tag = r.error ? ' [ERROR]' : '';
    return `  • ${r.label} (id=${r.model}, weight=${wt.toFixed(2)}): ${r.action} @ ${conf}%${tag} — ${r.rationale.slice(0, 220)}`;
  }).join('\n');

  const voteTally = `BUY=${votes.BUY || 0} · SELL=${votes.SELL || 0} · HOLD=${votes.HOLD || 0}`;
  const ctx = `strategy=${strategy} · regime=${regime?.primary || 'unknown'} · market=${market || 'US'}`;

  return `You are the META-REASONER. Four AI models have just voted on whether to trade ${symbol}. Your job is to synthesise one calibrated opinion that a human risk manager could act on.

CONTEXT: ${ctx}
RAW VOTE TALLY: ${voteTally}

INDIVIDUAL VOTES (with their dynamic ensemble weights, learned from each model's historical track record in this context):
${lines}

SYNTHESIS RULES:
  • Consider each model's weight — a higher weight means the model has been more accurate in this context. But the rationale matters more than the vote count: a single well-argued contrarian view from a high-weight model can override numerical majority.
  • Calibrate your confidence: if the models broadly agree AND high-weight models are on the majority side, confidence should be high. If they conflict OR low-weight models drive the majority, confidence should be lower.
  • Be HONEST — if the case is weak, say HOLD with low confidence. Do NOT manufacture conviction.
  • Your output is informational; the human's quorum + confidence-gate + safety rules decide whether to actually trade. So you can be candid.

You must respond in EXACTLY this format (no markdown, no extra text):
DECISION: BUY|SELL|HOLD
CONFIDENCE: <integer 0-100>
RATIONALE: <one or two sentences explaining the synthesis — cite which models you weighted and why>`;
}

// Public: synthesize. Returns { action, confidence, rationale, model, ts } or null.
async function synthesize({ symbol, strategy, regime, market, votes, weights, modelResults }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  if (!Array.isArray(modelResults) || modelResults.length === 0) return null;
  // Need at least 2 valid votes for synthesis to be meaningful.
  const valid = modelResults.filter(r => !r.error);
  if (valid.length < 2) return null;
  try {
    const prompt = buildMetaPrompt({ symbol, strategy, regime, market, votes, weights, modelResults });
    const res = await axios.post(
      OPENROUTER_URL,
      {
        model: META_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://alphatrade.replit.app',
          'X-Title': 'AlphaTrade AI Meta-Reasoner',
          'Content-Type': 'application/json',
        },
        timeout: META_TIMEOUT_MS,
      }
    );
    costTracker.recordUsage({ service: 'meta_reasoner', market: market || 'SHARED', modelId: META_MODEL, response: res.data });
    const text = res.data?.choices?.[0]?.message?.content || '';
    const parsed = parseMetaResponse(text);
    if (!parsed) return null;
    return { ...parsed, model: META_MODEL, ts: Date.now() };
  } catch (e) {
    console.error('[MetaReasoner] synthesis failed (swallowed):', e.response?.data?.error?.message || e.message);
    return null;
  }
}

// Render the prior cycle's meta opinion for injection into the NEXT cycle's
// per-model prompts so each LLM can see (and disagree with) the prior take.
function renderForPrompt(meta) {
  if (!meta) return null;
  const conf = (meta.confidence * 100).toFixed(0);
  return [
    `Prior meta-reasoner opinion (informational — feel free to disagree with reasoning):`,
    `  ${meta.action} @ ${conf}% — ${meta.rationale}`,
  ].join('\n');
}

// In-memory cache of the most recent meta opinion per (strategy:symbol). Used
// by agent.js to inject the prior meta into the NEXT cycle's per-model prompts.
const _last = new Map();
function rememberLast(key, meta) { if (meta) _last.set(key, meta); }
function getLast(key) {
  const m = _last.get(key);
  if (!m) return null;
  // Stale after 30 min — older opinions aren't actionable context anymore.
  if (Date.now() - m.ts > 30 * 60 * 1000) return null;
  return m;
}

module.exports = {
  synthesize, renderForPrompt, rememberLast, getLast,
  META_MODEL,
};
