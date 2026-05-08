// =============================================================================
// Hybrid Signal Service — Statistical-first decision routing
// =============================================================================
// Computes a 0..1 numeric "edge score" from PURE-CODE signals (no LLM):
// indicators (RSI/MACD/volume), patterns (breakout/trend/support), intraday
// (VWAP/orderflow), regime, and news-sentiment polarity. The 60/30/10
// weighting model:
//
//   • 60% Statistical   — indicators + patterns + intraday + regime fitness
//   • 30% Council       — Intelligence Council deliberation (LLM, only when
//                         statistical is borderline OR escalation reasons fire)
//   • 10% Sentiment     — cached news/social polarity (no fresh LLM call)
//
// Routing decision returned by `decideRoute()`:
//   • 'STATISTICAL_ONLY' → statistical confidence ≥ STAT_HIGH_CONF AND no
//                          escalate reasons → skip LLM entirely, emit signal
//                          from stats alone (huge cost saver in trending tape).
//   • 'COUNCIL'          → borderline (STAT_LOW_CONF ≤ stat < STAT_HIGH_CONF)
//                          OR escalate=true → call Intelligence Council.
//   • 'HOLD'             → statistical confidence < STAT_LOW_CONF AND not
//                          escalated → emit synthetic HOLD, skip LLM.
//
// SAFETY: this module produces SIGNALS only. It NEVER touches quorum, the
// confidence gate, the daily-loss budget, the circuit breaker, the kill
// switch, or atomic cash math. The 3-of-N quorum rule still applies to
// every emitted signal via riskManager.evaluateBuy → checkQuorum.
// Statistical-only signals are emitted as a 1-voter "consensus" with
// `_statisticalOnly:true` audit tag so downstream review can distinguish
// them from full council deliberations.
// =============================================================================

const STAT_HIGH_CONF = parseFloat(process.env.HYBRID_STAT_HIGH_CONF || '0.78');
const STAT_LOW_CONF  = parseFloat(process.env.HYBRID_STAT_LOW_CONF  || '0.55');

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function isFin(v) { return Number.isFinite(v); }

// ---------------------------------------------------------------------------
// Per-component sub-scores. Each returns { score: -1..+1, weight, reason }.
// Negative score = bearish lean, positive = bullish, 0 = neutral. Weight is
// each component's share of the statistical composite (sum to ~1.0).
// ---------------------------------------------------------------------------

function scoreIndicators(indicators) {
  if (!indicators || indicators.ok === false) return { score: 0, weight: 0.30, reason: 'no indicators' };
  let s = 0, n = 0;
  // RSI: <30 oversold (bullish mean-rev), >70 overbought (bearish), 40-60 neutral.
  const rsi = indicators.rsi;
  if (isFin(rsi)) {
    if (rsi < 30) s += 0.7;
    else if (rsi < 40) s += 0.3;
    else if (rsi > 70) s -= 0.7;
    else if (rsi > 60) s -= 0.3;
    n++;
  }
  // MACD histogram: positive = bullish momentum, negative = bearish.
  const mh = indicators.macd?.histogram;
  if (isFin(mh)) { s += Math.tanh(mh * 5); n++; }
  // Volume ratio: >1.5 unusual = magnify whatever direction price is going,
  // captured later via patterns. Here just record participation.
  const vr = indicators.volume?.ratio;
  if (isFin(vr) && vr > 1.5) { s += 0.1; n++; }
  return { score: n > 0 ? s / n : 0, weight: 0.30, reason: `rsi=${rsi?.toFixed(0)} macd=${mh?.toFixed(3)}` };
}

function scorePatterns(patterns) {
  if (!patterns || patterns.ok === false) return { score: 0, weight: 0.25, reason: 'no patterns' };
  let s = 0;
  if (patterns.breakout === 'up') s += 0.6;
  else if (patterns.breakout === 'down') s -= 0.6;
  if (patterns.trend === 'up' || patterns.trend === 'higher_highs') s += 0.4;
  else if (patterns.trend === 'down' || patterns.trend === 'lower_lows') s -= 0.4;
  if (patterns.support_held) s += 0.2;
  if (patterns.resistance_rejected) s -= 0.2;
  return { score: clamp01((s + 1) / 2) * 2 - 1, weight: 0.25, reason: `breakout=${patterns.breakout} trend=${patterns.trend}` };
}

function scoreIntraday(intraday) {
  if (!intraday || intraday.ok === false) return { score: 0, weight: 0.15, reason: 'no intraday' };
  let s = 0;
  // pctBelowVwap > 0.5% with positive cumDelta = mean-reversion bullish setup
  if (isFin(intraday.pctBelowVwap) && intraday.pctBelowVwap >= 0.5
      && isFin(intraday.cumDeltaSlope) && intraday.cumDeltaSlope > 0) s += 0.6;
  if (intraday.vwapBreakout === 'up') s += 0.4;
  else if (intraday.vwapBreakout === 'down') s -= 0.4;
  if (intraday.orSetup === 'long') s += 0.3;
  else if (intraday.orSetup === 'short') s -= 0.3;
  return { score: Math.max(-1, Math.min(1, s)), weight: 0.15, reason: `vwap-pct=${intraday.pctBelowVwap?.toFixed(2)}` };
}

function scoreRegime(regime) {
  if (!regime) return { score: 0, weight: 0.15, reason: 'no regime' };
  // Statistical fitness: trending favours BUY entries, mean-revert favours
  // dip-buys (also bullish in our day-strategy framing). High-vol & news
  // regimes get neutral score (let the LLM decide). Low-liquidity = penalty.
  let s = 0;
  switch (regime.primary) {
    case 'trending_up':       s = +0.6; break;
    case 'mean_reverting':    s = +0.3; break;
    case 'trending_down':     s = -0.6; break;
    case 'low_liquidity':     s = -0.3; break;
    case 'high_vol':
    case 'news_driven':       s =  0.0; break;
    default:                  s =  0.0;
  }
  return { score: s, weight: 0.15, reason: `regime=${regime.primary}` };
}

function scoreSentiment(newsSentiment) {
  if (!newsSentiment) return { score: 0, weight: 0.15, reason: 'no sentiment' };
  const pol = isFin(newsSentiment.score) ? newsSentiment.score
            : isFin(newsSentiment.polarity) ? newsSentiment.polarity
            : isFin(newsSentiment) ? newsSentiment : 0;
  return { score: Math.max(-1, Math.min(1, pol)), weight: 0.15, reason: `polarity=${pol.toFixed(2)}` };
}

// ---------------------------------------------------------------------------
// Composite statistical score → signal preview.
// ---------------------------------------------------------------------------
function computeStatisticalSignal({ indicators, patterns, intraday, regime, newsSentiment }) {
  const subs = [
    scoreIndicators(indicators),
    scorePatterns(patterns),
    scoreIntraday(intraday),
    scoreRegime(regime),
    scoreSentiment(newsSentiment),
  ];
  const totalWeight = subs.reduce((s, c) => s + c.weight, 0) || 1;
  const blended = subs.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight; // -1..+1
  const consensus = blended >  0.20 ? 'BUY'
                  : blended < -0.20 ? 'SELL'
                  : 'HOLD';
  // Confidence = magnitude of blended score, scaled. A blended score of
  // ±0.50 maps to ~0.75 confidence; ±0.80 maps to ~0.90. Capped 0.95.
  const confidence = Math.min(0.95, 0.50 + Math.abs(blended) * 0.50);
  return {
    consensus, confidence,
    blended: +blended.toFixed(3),
    breakdown: subs.map(s => ({ ...s, score: +s.score.toFixed(3), weight: +s.weight.toFixed(2) })),
  };
}

// ---------------------------------------------------------------------------
// Routing decision. `escalate` is the existing agent flag set by
// computeRoutingReasons (held position, swing/ASX strategy, high-vol/news,
// strong setup, breakout). When true we ALWAYS run the council regardless of
// statistical confidence — those are the high-stakes calls.
// ---------------------------------------------------------------------------
function decideRoute({ stat, escalate, holding }) {
  // Holding open: always go to council so SELL/HOLD reasoning gets full
  // depth (we never want to exit on a stats-only quirky read).
  if (holding) return { route: 'COUNCIL', reason: 'open_position' };
  if (escalate) return { route: 'COUNCIL', reason: 'escalate_flagged' };
  if (stat.confidence >= STAT_HIGH_CONF) {
    return { route: 'STATISTICAL_ONLY', reason: `stat_conf=${stat.confidence.toFixed(2)}≥${STAT_HIGH_CONF}` };
  }
  if (stat.confidence < STAT_LOW_CONF) {
    return { route: 'HOLD', reason: `stat_conf=${stat.confidence.toFixed(2)}<${STAT_LOW_CONF}` };
  }
  return { route: 'COUNCIL', reason: `borderline_stat_conf=${stat.confidence.toFixed(2)}` };
}

// Build a synthetic signal shape compatible with riskManager.evaluateBuy.
// Statistical-only signals get totalModels=1, agreementCount=1 — but the
// downstream `minDirectionalAgreement` config (default 3) means they will
// FAIL the quorum gate by design unless an operator explicitly lowers it.
// In practice statistical-only signals are emitted for the audit/dashboard
// and to skip the LLM cost; trade execution still requires council/ensemble
// quorum unless the operator opts into a "stat-execution" mode in future.
function buildStatisticalSignal(stat, symbol) {
  return {
    consensus: stat.consensus,
    confidence: +stat.confidence.toFixed(3),
    rawConfidence: +stat.confidence.toFixed(3),
    agreementCount: 1,
    totalModels: 1,
    votes: { [stat.consensus]: 1 },
    models: [{ id: 'statistical', label: 'Statistical (60% layer)', vote: stat.consensus, confidence: stat.confidence }],
    reason: `[stat] ${stat.consensus} via blended=${stat.blended} (${stat.breakdown.map(b => b.reason).join(' | ')})`,
    pool: 'statistical',
    routingReason: 'hybrid_statistical_only',
    _statisticalOnly: true,
    _statBreakdown: stat.breakdown,
  };
}

// Build a synthetic HOLD when statistical confidence is too low to bother
// the council. Same shape as a regular HOLD verdict.
function buildHoldSignal(stat, reason) {
  return {
    consensus: 'HOLD',
    confidence: +Math.max(0.50, stat.confidence).toFixed(3),
    rawConfidence: +stat.confidence.toFixed(3),
    agreementCount: 1,
    totalModels: 1,
    votes: { HOLD: 1 },
    models: [{ id: 'statistical', label: 'Statistical (60% layer)', vote: 'HOLD', confidence: stat.confidence }],
    reason: `[hybrid-hold] ${reason} | blended=${stat.blended}`,
    pool: 'statistical',
    routingReason: 'hybrid_low_conviction',
    _statisticalOnly: true,
    _hybridHold: true,
  };
}

module.exports = {
  computeStatisticalSignal,
  decideRoute,
  buildStatisticalSignal,
  buildHoldSignal,
  STAT_HIGH_CONF, STAT_LOW_CONF,
};
