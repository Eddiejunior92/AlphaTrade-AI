// =============================================================================
// Intelligence Council — 6 analyst roles + Judge synthesizer
// =============================================================================
// Replaces the flat 4-LLM ensemble for HIGH-STAKES calls (held positions,
// borderline statistical confidence, escalated regime/news/setup). Each role
// is a separately-prompted LLM call routed via llmRouterService:
//
//   ANALYSTS (6, parallel):
//     1. FUNDAMENTAL    — earnings, guidance, transcript, valuation, sector
//     2. TECHNICAL      — price action, indicators, patterns, intraday tape
//     3. RISK           — drawdown, correlation, hedging, capital capacity
//     4. DEEP_RESEARCH  — synthesises knowledge graph + macro + propagation
//     5. HISTORICAL     — 20y intel, similar-setup priors, regime outcomes
//     6. FUTURE         — scenario sim, macro forecast, IV/term structure
//
//   JUDGE (1, sequential after analysts return):
//     • Reads all 6 analyst verdicts + the statistical pre-score
//     • Issues final consensus: BUY / SELL / HOLD with calibrated confidence
//     • Returns optional `gateSuggestionDelta ∈ [-0.10, +0.10]` for the
//       Smart Safety Layer to apply (clamped 0.65-0.90 in dynamicGateService).
//
// SAFETY:
//   • Output is a standard signal shape — quorum (3-of-N analysts agreeing
//     with the Judge), confidence gate, daily-loss, breaker, kill switch
//     all enforced downstream BYTE-FOR-BYTE unchanged.
//   • Council CANNOT lower the gate below SAFETY_FLOOR (0.65). Its
//     suggestion is one input clamped at multiple layers.
//   • Failures degrade gracefully: < 3 analyst responses → return synthetic
//     HOLD with low confidence (the 3-of-N gate will reject any execution).
// =============================================================================

const axios = require('axios');
const router = require('./llmRouterService');
const costTracker = require('./llmCostTracker');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const TIMEOUT_MS = parseInt(process.env.COUNCIL_TIMEOUT_MS || '20000');

// Available models by id. Mirror of llmService.MODELS but kept local so
// the council can route independently. provider chooses transport.
const MODEL_REGISTRY = {
  gemini: { provider: 'openrouter', model: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
  grok:   { provider: 'xai',        model: 'grok-4-fast-non-reasoning',   label: 'Grok 4 Fast' },
  claude: { provider: 'openrouter', model: 'anthropic/claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
  gpt4o:  { provider: 'openrouter', model: 'openai/gpt-4o',               label: 'GPT-4o' },
};

const DEFAULT_POOL = ['gemini', 'grok', 'claude', 'gpt4o'];

const ROLES = [
  { id: 'fundamental', task: 'council_fundamental',
    pool: ['claude', 'gpt4o', 'gemini', 'grok'],
    prompt: (ctx) => `You are the FUNDAMENTAL ANALYST on a trading council. Evaluate ${ctx.symbol} (strategy=${ctx.strategy}) on:
- Earnings, guidance, transcript tone (if present)
- Valuation context (sector peers, fwd PE if knowable)
- Catalyst calendar
Answer JSON: {"vote":"BUY|SELL|HOLD","confidence":0..1,"reason":"<1-2 sentences>","key_risk":"<1 sentence>"}` },
  { id: 'technical', task: 'council_technical',
    pool: ['gemini', 'grok', 'gpt4o', 'claude'],
    prompt: (ctx) => `You are the TECHNICAL ANALYST. Read price/indicators/patterns/intraday tape for ${ctx.symbol}.
${ctx.mtfConsensusBlock ? ctx.mtfConsensusBlock + '\n' : ''}Answer JSON: {"vote":"BUY|SELL|HOLD","confidence":0..1,"reason":"<1-2 sentences>","setup":"<dip/breakout/range/exhaustion/none>","mtf_aligned":<true|false|null>}` },
  { id: 'risk', task: 'council_risk',
    pool: ['claude', 'gpt4o', 'grok', 'gemini'],
    prompt: (ctx) => `You are the RISK MANAGER. Focus on downside, correlation, drawdown, capital usage. ${ctx.symbol}.
Answer JSON: {"vote":"BUY|SELL|HOLD","confidence":0..1,"reason":"<1-2 sentences>","capital_at_risk":"low|medium|high"}` },
  { id: 'deep_research', task: 'council_deep_research',
    pool: ['claude', 'gpt4o', 'gemini', 'grok'],
    prompt: (ctx) => `You are DEEP RESEARCH. Synthesise the knowledge-graph, macro forecast, propagation edges, news context for ${ctx.symbol}. What does the LONG-TERM picture argue for here?
Answer JSON: {"vote":"BUY|SELL|HOLD","confidence":0..1,"reason":"<2 sentences>","horizon":"intraday|days|weeks"}` },
  { id: 'historical_research', task: 'council_historical',
    pool: ['gemini', 'gpt4o', 'claude', 'grok'],
    prompt: (ctx) => `You are HISTORICAL RESEARCH. Use the 20y intel + similar past setups + regime priors for ${ctx.symbol}. What did historically-similar setups produce?
Answer JSON: {"vote":"BUY|SELL|HOLD","confidence":0..1,"reason":"<2 sentences>","prior_win_rate":<0..1 or null>}` },
  { id: 'future_prediction', task: 'council_future',
    pool: ['grok', 'gpt4o', 'claude', 'gemini'],
    prompt: (ctx) => `You are FUTURE PREDICTION. Use the scenario simulator + macro forecast + IV/options structure to estimate the 1-3d distribution for ${ctx.symbol}.
Answer JSON: {"vote":"BUY|SELL|HOLD","confidence":0..1,"reason":"<2 sentences>","upside_pct":<num or null>,"downside_pct":<num or null>}` },
  // Phase B (May 2026): 8th role — ADVERSARIAL. The other 7 analysts can
  // suffer from confirmation bias toward the statistical pre-score and the
  // regime-tagged base case. The Adversarial analyst is REQUIRED to argue
  // the opposite case and surface failure modes the council might be
  // dismissing. Cost: +1 LLM call per Council deliberation (~$0.001-0.003
  // depending on routed model). Quorum threshold rises to 4-of-8 below.
  { id: 'adversarial', task: 'council_adversarial',
    pool: ['claude', 'gpt4o', 'grok', 'gemini'],
    prompt: (ctx) => `You are the ADVERSARIAL ANALYST. Your sole job is to ARGUE THE OPPOSITE of the obvious tape read for ${ctx.symbol}. If the stat score and indicators lean BUY, find the strongest BEAR/HOLD case and explicitly name the failure modes (liquidity trap, headline risk, exhaustion, regime change, factor crowding). If the read leans SELL, find the strongest BUY/HOLD case. NEVER simply mirror the consensus — your value is friction.
Answer JSON: {"vote":"BUY|SELL|HOLD","confidence":0..1,"reason":"<2 sentences naming the strongest counter-thesis>","failure_modes":["<mode 1>","<mode 2>"]}` },
];

const JUDGE = {
  task: 'council_judge',
  pool: ['claude', 'gpt4o', 'gemini', 'grok'],
};

function _extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function _callModel({ modelId, prompt, systemPrompt, market, taskType }) {
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
    headers['X-Title'] = 'AlphaTrade Council';
  }
  const body = {
    model: model.model,
    messages: [
      { role: 'system', content: systemPrompt || 'You are part of an institutional trading council. Be calibrated and concise. Always reply with valid JSON.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 280,
    response_format: { type: 'json_object' },
  };
  const startTs = Date.now();
  try {
    const r = await axios.post(url, body, { headers, timeout: TIMEOUT_MS });
    const text = r.data?.choices?.[0]?.message?.content || '';
    const parsed = _extractJson(text);
    const latencyMs = Date.now() - startTs;
    // Cost tracking — best-effort.
    try { costTracker.recordUsage({ service: 'council', market, modelId: model.model, response: r.data }); } catch (_) {}
    if (!parsed) {
      router.recordOutcome({ taskType, modelId, success: false, quality: 0.2, latencyMs }).catch(() => {});
      return { ok: false, reason: 'parse_failed', latencyMs };
    }
    router.recordOutcome({ taskType, modelId, success: true, quality: 0.85, latencyMs }).catch(() => {});
    return { ok: true, parsed, latencyMs };
  } catch (e) {
    router.recordOutcome({ taskType, modelId, success: false, quality: 0.0, latencyMs: Date.now() - startTs }).catch(() => {});
    return { ok: false, reason: e.message };
  }
}

function _normaliseVote(v) {
  const s = String(v || '').toUpperCase().trim();
  if (s === 'BUY' || s === 'SELL' || s === 'HOLD') return s;
  return 'HOLD';
}

function _renderContextBlock(ctx) {
  // Compact one-block prompt context — every analyst sees the same baseline.
  // Most blocks are pre-rendered text; we just join non-null ones.
  const parts = [];
  parts.push(`SYMBOL: ${ctx.symbol}  PRICE: ${ctx.priceData?.latest}  CHANGE: ${ctx.priceData?.change}`);
  parts.push(`STRATEGY: ${ctx.strategy}  MARKET: ${ctx.market}`);
  if (ctx.statisticalScore) parts.push(`STAT_SCORE: blended=${ctx.statisticalScore.blended} conf=${ctx.statisticalScore.confidence.toFixed(2)} verdict=${ctx.statisticalScore.consensus}`);
  if (ctx.indicators) parts.push(`INDICATORS: rsi=${ctx.indicators.rsi?.toFixed(1)} macd_h=${ctx.indicators.macd?.histogram?.toFixed(3)} vol_ratio=${ctx.indicators.volume?.ratio?.toFixed(2)}`);
  if (ctx.patterns) parts.push(`PATTERNS: trend=${ctx.patterns.trend} breakout=${ctx.patterns.breakout}`);
  if (ctx.intraday && ctx.intraday.ok !== false) parts.push(`INTRADAY: vwap_pct=${ctx.intraday.pctBelowVwap?.toFixed(2)} cumDelta=${ctx.intraday.cumDeltaSlope?.toFixed(3)}`);
  if (ctx.regimeContext) parts.push(ctx.regimeContext);
  if (ctx.macroForecast) parts.push(ctx.macroForecast);
  if (ctx.knowledgeContext) parts.push(ctx.knowledgeContext);
  if (ctx.historical) parts.push(ctx.historical);
  if (ctx.scenarioSim) parts.push(ctx.scenarioSim);
  if (ctx.earningsSignal) parts.push(ctx.earningsSignal);
  if (ctx.earningsTranscript) parts.push(ctx.earningsTranscript);
  if (ctx.optionsFlow) parts.push(ctx.optionsFlow);
  if (ctx.newsSentiment) parts.push(`NEWS: score=${ctx.newsSentiment.score} ${ctx.newsSentiment.summary || ''}`);
  if (ctx.holding) parts.push(`POSITION: long ${ctx.holding.qty} @ ${ctx.holding.avg_cost}`);
  return parts.join('\n');
}

// Fan out N analysts in parallel, then run Judge.
async function deliberate(ctx) {
  const market = ctx.market || 'US';
  // Phase B: compute MTF consensus block once and inject only into the
  // Technical analyst's prompt context. Pure function; ok:false degrades
  // gracefully (the prompt simply omits the block).
  try {
    const mtfSvc = require('./mtfConsensusService');
    const mtf = mtfSvc.computeMtfConsensus({
      tf5m: ctx.indicators_5m, tf15m: ctx.indicators_15m, tf1h: ctx.indicators_1h,
    });
    ctx.mtfConsensus = mtf;
    ctx.mtfConsensusBlock = mtfSvc.renderForPrompt(mtf);
  } catch (_) { /* swallow — mtf is informational only */ }
  const baselineBlock = _renderContextBlock(ctx);
  const analystPromises = ROLES.map(async (role) => {
    const pick = await router.pickModel(role.task, role.pool);
    const fullPrompt = `${baselineBlock}\n\nYOUR ROLE: ${role.id.toUpperCase()}\n${role.prompt(ctx)}`;
    const r = await _callModel({ modelId: pick.modelId, prompt: fullPrompt, market, taskType: role.task });
    return { role: role.id, modelId: pick.modelId, ...r };
  });
  const results = await Promise.all(analystPromises);
  const verdicts = results.filter(r => r.ok && r.parsed).map(r => ({
    role: r.role, modelId: r.modelId,
    vote: _normaliseVote(r.parsed.vote),
    confidence: Math.max(0, Math.min(1, parseFloat(r.parsed.confidence) || 0)),
    reason: String(r.parsed.reason || '').slice(0, 280),
    extras: { ...r.parsed, vote: undefined, confidence: undefined, reason: undefined },
  }));
  const failed = results.filter(r => !r.ok).map(r => ({ role: r.role, modelId: r.modelId, reason: r.reason }));

  // Vote tally.
  const tally = { BUY: 0, SELL: 0, HOLD: 0 };
  let confSum = { BUY: 0, SELL: 0, HOLD: 0 };
  for (const v of verdicts) {
    tally[v.vote]++;
    confSum[v.vote] += v.confidence;
  }
  const votes = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const leadingVote = votes[0][0];
  const agreementCount = votes[0][1];

  // Phase B (May 2026): with 8 roles we need at least Math.ceil(8/2)=4 to
  // proceed to Judge, so a degraded run with only 3 analysts no longer pads
  // through. Math.ceil keeps the formula correct if a future task adds/
  // removes a role.
  const MIN_ANALYSTS_FOR_JUDGE = Math.ceil(ROLES.length / 2);
  if (verdicts.length < MIN_ANALYSTS_FOR_JUDGE) {
    return {
      consensus: 'HOLD',
      confidence: 0.50,
      rawConfidence: 0.50,
      agreementCount: verdicts.length,
      totalModels: verdicts.length || 1,
      votes: tally,
      models: verdicts.map(v => ({ id: v.modelId, label: `${v.role}/${v.modelId}`, vote: v.vote, confidence: v.confidence })),
      reason: `[council] insufficient analyst quorum (${verdicts.length}/${ROLES.length} responded). Failures: ${failed.map(f => f.role + ':' + f.reason).slice(0, 3).join(', ')}`,
      pool: 'council',
      routingReason: 'council_degraded',
      _councilFailed: true,
      _councilAnalysts: verdicts,
      _councilFailures: failed,
    };
  }

  // Judge — sees all analyst verdicts + statistical pre-score.
  const judgePool = JUDGE.pool;
  const judgePick = await router.pickModel(JUDGE.task, judgePool);
  const judgePrompt = `${baselineBlock}

ANALYST VERDICTS:
${verdicts.map(v => `• ${v.role.toUpperCase()} (${v.modelId}): ${v.vote} @ ${(v.confidence*100).toFixed(0)}% — ${v.reason}`).join('\n')}

You are the JUDGE. Synthesise the ${ROLES.length} analyst verdicts above (FUNDAMENTAL, TECHNICAL, RISK, DEEP_RESEARCH, HISTORICAL, FUTURE, ADVERSARIAL) and the statistical pre-score. Weight DEEP_RESEARCH, HISTORICAL, FUTURE heavily for borderline calls — they carry the long-horizon/distribution view. The RISK analyst's veto matters for high capital-at-risk reads. The ADVERSARIAL analyst's failure modes MUST be addressed in your reason — if the counter-thesis is plausible, lower confidence or vote HOLD.

Respond JSON: {
  "consensus":"BUY|SELL|HOLD",
  "confidence":0..1,                    // calibrated, not max-of
  "reason":"<2-3 sentences explaining the synthesis>",
  "gate_suggestion_delta": <-0.10..+0.10 or 0>,   // suggest tightening (+) or loosening (-) the gate
  "gate_reason":"<1 sentence why>"
}`;
  const judgeRes = await _callModel({ modelId: judgePick.modelId, prompt: judgePrompt, market, taskType: JUDGE.task });
  let judgeVerdict = null;
  if (judgeRes.ok && judgeRes.parsed) {
    judgeVerdict = {
      consensus: _normaliseVote(judgeRes.parsed.consensus),
      confidence: Math.max(0, Math.min(1, parseFloat(judgeRes.parsed.confidence) || 0)),
      reason: String(judgeRes.parsed.reason || '').slice(0, 400),
      gateSuggestionDelta: Math.max(-0.10, Math.min(0.10, parseFloat(judgeRes.parsed.gate_suggestion_delta) || 0)),
      gateReason: String(judgeRes.parsed.gate_reason || '').slice(0, 200),
      modelId: judgePick.modelId,
    };
  }

  // Final consensus = Judge's call. Confidence = Judge's confidence.
  // Agreement count = how many analysts voted the SAME WAY as the Judge.
  const finalConsensus = judgeVerdict?.consensus || leadingVote;
  const analystAgreement = verdicts.filter(v => v.vote === finalConsensus).length;
  const finalConfidence = judgeVerdict?.confidence ?? (confSum[finalConsensus] / Math.max(1, tally[finalConsensus]));

  return {
    consensus: finalConsensus,
    confidence: +finalConfidence.toFixed(3),
    rawConfidence: +finalConfidence.toFixed(3),
    // Quorum surface for riskManager — Judge counts as 1 voter, plus all
    // analyst voters. Total = analysts + 1 (judge).
    agreementCount: analystAgreement + (judgeVerdict?.consensus === finalConsensus ? 1 : 0),
    totalModels: verdicts.length + (judgeVerdict ? 1 : 0),
    votes: tally,
    models: [
      ...verdicts.map(v => ({ id: v.modelId, label: `${v.role}/${v.modelId}`, vote: v.vote, confidence: v.confidence })),
      ...(judgeVerdict ? [{ id: judgeVerdict.modelId, label: `judge/${judgeVerdict.modelId}`, vote: judgeVerdict.consensus, confidence: judgeVerdict.confidence }] : []),
    ],
    reason: `[council] ${finalConsensus} via Judge (${judgeVerdict?.modelId || 'fallback'}): ${judgeVerdict?.reason || 'analyst-leading vote'}`,
    pool: 'council',
    routingReason: ctx.routingReason || 'council_full',
    _council: {
      analysts: verdicts,
      judge: judgeVerdict,
      tally,
      failures: failed,
      gateSuggestionDelta: judgeVerdict?.gateSuggestionDelta || 0,
      gateReason: judgeVerdict?.gateReason || null,
    },
  };
}

module.exports = { deliberate, ROLES, MODEL_REGISTRY, _callModel };
