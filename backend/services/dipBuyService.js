// =============================================================================
// Day-Trading Dip-Buy Priority Layer
// =============================================================================
//
// Strictly additive BUY-side filter for the DAY strategy only. Inspects the
// same bar/indicator/order-flow context the LLM ensemble already saw and
// asks: "Is this a dip-style entry, or is the agent buying into strength?"
//
// SAFETY CONTRACT
// ---------------
// • This layer can ONLY downgrade BUY → HOLD via TRADE_REJECTED audit.
// • It can NEVER upgrade HOLD → BUY, lift confidence, bypass the 3-of-4
//   quorum, relax the 75-85% confidence gate, alter the $100/day USD loss
//   budget, the 5% drawdown circuit breaker, the kill switch, the
//   trailing-stop ratchet, the no-averaging-in rule, or any sizing math.
// • Day strategy only. Swing & ASX-swing entries on 15-Min bars use a
//   different setup logic and are intentionally not gated here.
// • On insufficient data (missing bars / indicators / order-flow) the gate
//   FAILS OPEN — allowing the trade — so a transient data hiccup cannot
//   wedge entries. Same fail-safe pattern as the recovery buffer.
//
// STRICTNESS — DAY_TRADING_DIP_REQUIREMENT_STRICTNESS env var:
//   0 → DISABLED (gate is a no-op, every BUY allowed through)
//   1 → LOOSE    (any 1 of 5 conditions; widest thresholds)
//   2 → MEDIUM   (any 1 of 5 conditions; default thresholds — DEFAULT)
//   3 → STRICT   (≥2 of 5 conditions must be true)
//
// CONDITIONS (each independent, evaluated on the most recent context):
//   A. NEAR_SUPPORT       — latest close ≤ THRESH above the 20-bar swing low
//   B. VWAP_RECLAIM       — close ≤ VWAP (or barely above) AND cumulative
//                           delta slope > 0  ("positive flow on the dip")
//   C. RSI_OVERSOLD       — RSI < THRESH, OR rolling UP from oversold
//                           (prev_rsi < rsi AND prev_rsi < OVERSOLD+5)
//   D. PULLBACK_FROM_HIGH — close is in the THRESH-band below the 20-bar
//                           swing high (e.g. 0.8-2.5% below)
//   E. POSITIVE_FLOW_ON_DIP — recent 5-bar net price move ≤ 0 AND
//                             cumDeltaSlope > 0 (delta turning positive
//                             after a negative move)
// =============================================================================

// Lightweight Wilder RSI on a closes array. Pure-arithmetic, ~O(n), allocates
// nothing — used to derive the PRIOR-bar RSI without re-running the full
// indicator suite (EMA + MACD + volatility + volume) on N-1 bars every BUY
// tick. Identical formula to indicatorsService.rsi(); kept inline here so
// this module has no hot-path coupling to the broader indicator service.
function _wilderRsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  // Initial average over the first `period` deltas.
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += -d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // Wilder smoothing for the remaining bars.
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0,  d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

const STRICTNESS_DISABLED = 0;
const STRICTNESS_LOOSE    = 1;
const STRICTNESS_MEDIUM   = 2;
const STRICTNESS_STRICT   = 3;

// Per-strictness thresholds. Tuned conservatively — looser strictness uses
// wider bands; strict uses tighter ones AND requires ≥2 conditions.
const PROFILES = {
  [STRICTNESS_LOOSE]: {
    minConditions: 1,
    nearSupportPct:    1.5,        // close within 1.5% of swing low
    vwapBandPct:       0.30,       // close ≤ vwap × 1.003
    rsiOversold:       40,         // <40 counts as oversold
    pullbackMinPct:    0.5,        // 0.5-3.5% below swing high
    pullbackMaxPct:    3.5,
  },
  [STRICTNESS_MEDIUM]: {
    minConditions: 1,
    nearSupportPct:    1.0,
    vwapBandPct:       0.10,       // close ≤ vwap × 1.001
    rsiOversold:       35,
    pullbackMinPct:    0.8,
    pullbackMaxPct:    2.5,
  },
  [STRICTNESS_STRICT]: {
    minConditions: 2,
    nearSupportPct:    0.7,
    vwapBandPct:       0.0,        // close must be at-or-below VWAP
    rsiOversold:       32,
    pullbackMinPct:    1.0,
    pullbackMaxPct:    2.0,
  },
};

function getStrictness() {
  const raw = process.env.DAY_TRADING_DIP_REQUIREMENT_STRICTNESS;
  if (raw === undefined || raw === null || raw === '') return STRICTNESS_MEDIUM;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 3) return STRICTNESS_MEDIUM;
  return n;
}

// Pure: takes the same context the BUY-path already has, returns a verdict.
// `verdict.allow === true` means "let the BUY through". `false` means the
// caller should reject with reason='dip_required' and the returned `details`
// payload should be stamped on the TRADE_REJECTED audit.
function checkDipConditions({ bars, indicators, orderFlow, strictness }) {
  const s = Number.isFinite(strictness) ? strictness : getStrictness();

  // Disabled — no-op gate. Surface the fact in details so audits/dashboards
  // can tell "buyer was strong" from "gate was off".
  if (s === STRICTNESS_DISABLED) {
    return { allow: true, strictness: s, disabled: true, conditions: {}, conditionsMet: 0, requiredConditions: 0 };
  }
  const profile = PROFILES[s] || PROFILES[STRICTNESS_MEDIUM];

  // FAIL-OPEN on insufficient data. We need at least 20 bars to compute the
  // swing-low / swing-high band; RSI requires 15+; orderFlow requires 25+.
  // Any missing piece → allow the trade and stamp the reason.
  if (!Array.isArray(bars) || bars.length < 20) {
    return { allow: true, strictness: s, failOpen: true, reason: 'insufficient_bars', conditions: {}, conditionsMet: 0, requiredConditions: profile.minConditions };
  }
  const last = bars[bars.length - 1];
  const close = Number(last?.c);
  if (!Number.isFinite(close) || close <= 0) {
    return { allow: true, strictness: s, failOpen: true, reason: 'invalid_close', conditions: {}, conditionsMet: 0, requiredConditions: profile.minConditions };
  }

  // Build the 20-bar swing range from the EXCLUDING-LAST window so the
  // current bar's own extreme doesn't get used as its own reference.
  const window = bars.slice(-21, -1);
  let swingHigh = -Infinity, swingLow = Infinity;
  for (const b of window) {
    const h = Number(b.h), l = Number(b.l);
    if (Number.isFinite(h) && h > swingHigh) swingHigh = h;
    if (Number.isFinite(l) && l < swingLow)  swingLow = l;
  }

  // ---- Condition A: NEAR_SUPPORT ----
  // Distance above the swing-low as a percentage of close.
  const distFromLowPct = (Number.isFinite(swingLow) && swingLow > 0)
    ? ((close - swingLow) / close) * 100
    : null;
  const nearSupport = distFromLowPct != null && distFromLowPct >= 0 && distFromLowPct <= profile.nearSupportPct;

  // ---- Condition B: VWAP_RECLAIM ----
  // Close at-or-just-above VWAP (within band) WITH positive cum-delta slope.
  // The slope requirement is what makes this a "reclaim" rather than just
  // "below VWAP" — it captures the dip-buying that's already underway.
  const vwap = orderFlow?.ok && Number.isFinite(orderFlow.vwap) ? orderFlow.vwap : null;
  const cdSlope = orderFlow?.ok && Number.isFinite(orderFlow.cumDeltaSlope) ? orderFlow.cumDeltaSlope : null;
  const vwapBand = vwap != null ? vwap * (1 + profile.vwapBandPct / 100) : null;
  const vwapReclaim = vwap != null && cdSlope != null && close <= vwapBand && cdSlope > 0;

  // ---- Condition C: RSI_OVERSOLD or rolling up from oversold ----
  // Use the indicators.rsi already computed by the agent for the current
  // bar; derive the PRIOR-bar RSI via a tiny inline Wilder calc on
  // closes.slice(0, -1). Avoids re-running the full indicator suite (EMA,
  // MACD, volatility, volume) on every BUY tick — single-pass O(n) instead.
  const rsiNow = indicators?.ok && Number.isFinite(indicators.rsi) ? indicators.rsi : null;
  let rsiPrev = null;
  if (rsiNow != null && bars.length >= 16) {
    const prevCloses = bars.slice(0, -1).map(b => Number(b.c)).filter(Number.isFinite);
    rsiPrev = _wilderRsi(prevCloses, 14);
  }
  const rsiOversoldFlat   = rsiNow != null && rsiNow < profile.rsiOversold;
  const rsiRollingUp      = rsiNow != null && rsiPrev != null && rsiPrev < rsiNow && rsiPrev < (profile.rsiOversold + 5);
  const rsiOversold = rsiOversoldFlat || rsiRollingUp;

  // ---- Condition D: PULLBACK_FROM_HIGH ----
  // Close sits inside the [pullbackMin, pullbackMax]% band BELOW swing high.
  // Outside the band on either side fails: too small = buying strength,
  // too large = catching a knife.
  const distBelowHighPct = (Number.isFinite(swingHigh) && swingHigh > 0)
    ? ((swingHigh - close) / swingHigh) * 100
    : null;
  const pullback = distBelowHighPct != null
    && distBelowHighPct >= profile.pullbackMinPct
    && distBelowHighPct <= profile.pullbackMaxPct;

  // ---- Condition E: POSITIVE_FLOW_ON_DIP ----
  // Recent 5-bar net price change ≤ 0 (i.e. there WAS a dip) AND cumulative
  // delta slope is positive (i.e. flow turning to accumulation).
  const recent5 = bars.slice(-5);
  let recentMovePct = null;
  if (recent5.length === 5) {
    const o = Number(recent5[0].o);
    if (Number.isFinite(o) && o > 0) recentMovePct = ((close - o) / o) * 100;
  }
  const positiveFlowOnDip = recentMovePct != null && cdSlope != null && recentMovePct <= 0 && cdSlope > 0;

  const conditions = {
    near_support:         nearSupport,
    vwap_reclaim:         vwapReclaim,
    rsi_oversold:         rsiOversold,
    pullback_from_high:   pullback,
    positive_flow_on_dip: positiveFlowOnDip,
  };
  const conditionsMet = Object.values(conditions).filter(Boolean).length;
  const allow = conditionsMet >= profile.minConditions;

  // Mean-reversion amplifier signal: how far below VWAP the current close
  // sits, in percent. Positive = price below VWAP. The agent uses this
  // (paired with positive cumDeltaSlope = sellers exhausted, buyers
  // stepping in) to slightly UPSIZE the textbook dip-buy. NEVER used to
  // override any safety gate — only feeds a clamped sizing multiplier in
  // riskManager.evaluateBuy.
  const pctBelowVwap = (vwap != null && vwap > 0)
    ? +(((vwap - close) / vwap) * 100).toFixed(3)
    : null;

  return {
    allow,
    strictness: s,
    requiredConditions: profile.minConditions,
    conditionsMet,
    conditions,
    pctBelowVwap,
    cumDeltaSlope: cdSlope,
    metrics: {
      close: +close.toFixed(4),
      swing_low:  Number.isFinite(swingLow)  ? +swingLow.toFixed(4)  : null,
      swing_high: Number.isFinite(swingHigh) ? +swingHigh.toFixed(4) : null,
      dist_from_low_pct:    distFromLowPct    != null ? +distFromLowPct.toFixed(2)    : null,
      dist_below_high_pct:  distBelowHighPct  != null ? +distBelowHighPct.toFixed(2)  : null,
      recent5_move_pct:     recentMovePct     != null ? +recentMovePct.toFixed(2)     : null,
      pct_below_vwap:       pctBelowVwap,
      vwap, cum_delta_slope: cdSlope,
      rsi_now: rsiNow != null ? +rsiNow.toFixed(1) : null,
      rsi_prev: rsiPrev != null ? +rsiPrev.toFixed(1) : null,
    },
    profile: { ...profile },
  };
}

module.exports = {
  checkDipConditions,
  getStrictness,
  STRICTNESS_DISABLED, STRICTNESS_LOOSE, STRICTNESS_MEDIUM, STRICTNESS_STRICT,
};
