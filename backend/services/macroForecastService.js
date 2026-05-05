// Forward-looking macro-regime forecast layer.
//
// Consumes the cross-asset factor snapshot from macroFactorService and
// classifies BOTH the current macro regime AND the most likely regime over
// the next 24-48h, with a confidence score. From that it derives a SAFETY-
// PRESERVING set of adjustments the agent can apply downstream:
//
//   • confidenceBoost ≥ 0          — added to the strategy's confidenceThreshold.
//                                     Pure tightening. Stacks ADDITIVELY with
//                                     metaLearning's regimeBoost. Capped at
//                                     +5pp on its own (and the combined gate
//                                     is capped elsewhere).
//   • sizeMult ∈ [0.7, 1.0]        — sizing nudge. NEVER above 1.0 — macro can
//                                     only SHRINK position size, never amplify.
//   • modelWeightHints (advisory)  — qualitative per-role hint rendered into
//                                     the prompt. Quorum + ensemble voting
//                                     are NOT modified by this — purely a
//                                     suggestion the LLMs may consider.
//
// SAFETY CONTRACT
//   • Quorum gate (3-of-4), 85% base confidence threshold (per strategy),
//     $100/day USD loss budget, 5% drawdown circuit breaker, kill switch,
//     trailing-stop ratchet, no-averaging-in — ALL untouched. Each retains
//     full veto power.
//   • All adjustments are non-amplifying: confidenceBoost is non-negative,
//     sizeMult is upper-clamped at 1.0.
//   • Cold-start path returns identity {boost:0, mult:1.0, regime:'unknown'}.
//   • Every public method swallows errors — never breaks trading.
//
// Regimes classified (current AND forecast):
//   RISK_ON         — equities/credit/EM rising, vol falling, gold/USD weak
//   RISK_OFF        — equities/credit/EM falling, vol rising, gold/USD strong
//   VOL_SPIKE       — VXX 5d return ≥ +20% (regardless of equity direction)
//   RATE_SHOCK      — TLT 5d return ≤ -2% (long yields rising fast)
//   INFLATION_RISING — breakeven 20d ≥ +1.5pp AND commodities/oil rising
//   USD_STRONG      — UUP 20d ≥ +2.5pp (dollar wrecking ball — EM/commodity headwind)
//   GOLDILOCKS      — equities up modestly, vol low, rates stable, USD stable
//   STAGFLATION     — equities + bonds both falling, commodities + USD up
//   NEUTRAL         — fallback (no strong signal)
//
// Forecast = simple momentum extrapolation: a regime that's been trending
// the same way for ≥10 trading days OR has accelerated in the last 5d gets
// projected forward. Confidence reflects strength of signal alignment.

const macroFactor = require('./macroFactorService');

const TTL_MS = 30 * 60 * 1000;        // 30-min cache (factors refresh hourly)
const MAX_BOOST_PP = 0.05;            // hard cap on this layer's confidence tightening
const MIN_SIZE_MULT = 0.70;           // floor on sizing nudge
const MAX_SIZE_MULT = 1.00;           // CEILING — macro can never amplify

let _cache = { ts: 0, data: null };
let _inflight = null;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Score each regime against the factor snapshot. Returns {regime, score, reasons}.
// Multiple regimes can score positively — we pick the highest, with ties
// broken by the SAFETY-PRIORITY order (vol/rate/risk-off > risk-on/goldilocks).
function classifyRegime(factors, composites) {
  const scores = [];

  const vix5  = factors.vix?.ret5d;
  const tlt5  = factors.rate_long?.ret5d;
  const uup20 = factors.usd?.ret20d;
  const spy5  = factors.equity?.ret5d;
  const eem5  = factors.em?.ret5d;
  const hyg5  = factors.credit?.ret5d;
  const dbc20 = factors.commod?.ret20d;
  const oil20 = factors.oil?.ret20d;
  const breakeven = composites.breakevenChg20d;
  const riskOnOff = composites.riskOnOff5d;
  const creditDiv = composites.creditEquityDiv5d;

  // VOL_SPIKE — high priority, vol-management dominates
  if (vix5 != null && vix5 >= 20) {
    scores.push({ regime: 'VOL_SPIKE', score: Math.min(1, vix5 / 50),
                  reasons: [`VXX +${vix5.toFixed(1)}% over 5d`] });
  }
  // RATE_SHOCK — long bonds selling off hard
  if (tlt5 != null && tlt5 <= -2) {
    scores.push({ regime: 'RATE_SHOCK', score: Math.min(1, Math.abs(tlt5) / 5),
                  reasons: [`TLT ${tlt5.toFixed(1)}% over 5d (long yields rising)`] });
  }
  // RISK_OFF
  if (riskOnOff != null && riskOnOff <= -1.0) {
    const r = [`Risk-on/off composite ${riskOnOff.toFixed(2)}pp (5d)`];
    if (creditDiv != null && creditDiv < -0.5) r.push(`credit underperforming equity by ${Math.abs(creditDiv).toFixed(2)}pp`);
    scores.push({ regime: 'RISK_OFF', score: Math.min(1, Math.abs(riskOnOff) / 3), reasons: r });
  }
  // INFLATION_RISING
  if (breakeven != null && breakeven >= 1.5 && (dbc20 != null && dbc20 >= 2 || oil20 != null && oil20 >= 5)) {
    scores.push({ regime: 'INFLATION_RISING', score: Math.min(1, breakeven / 3),
                  reasons: [`Breakeven proxy +${breakeven.toFixed(1)}pp (20d)`,
                            `commodities ${dbc20 != null ? `${dbc20.toFixed(1)}%` : 'n/a'} / oil ${oil20 != null ? `${oil20.toFixed(1)}%` : 'n/a'} (20d)`] });
  }
  // USD_STRONG
  if (uup20 != null && uup20 >= 2.5) {
    scores.push({ regime: 'USD_STRONG', score: Math.min(1, uup20 / 6),
                  reasons: [`UUP +${uup20.toFixed(1)}% over 20d`] });
  }
  // STAGFLATION — equities AND bonds both down, commodities + USD up
  if (spy5 != null && spy5 < 0 && tlt5 != null && tlt5 < 0 &&
      dbc20 != null && dbc20 > 0 && uup20 != null && uup20 > 0) {
    scores.push({ regime: 'STAGFLATION', score: 0.7,
                  reasons: [`SPY ${spy5.toFixed(1)}% + TLT ${tlt5.toFixed(1)}% (5d) with commodities/USD bid`] });
  }
  // RISK_ON
  if (riskOnOff != null && riskOnOff >= 1.0) {
    const r = [`Risk-on/off composite +${riskOnOff.toFixed(2)}pp (5d)`];
    if (eem5 != null && eem5 > 1) r.push(`EM +${eem5.toFixed(1)}% (5d)`);
    scores.push({ regime: 'RISK_ON', score: Math.min(1, riskOnOff / 3), reasons: r });
  }
  // GOLDILOCKS — modest equity gain, low vol, rates stable, USD stable
  if (spy5 != null && spy5 > 0 && spy5 < 2.5 &&
      vix5 != null && vix5 < 5 &&
      tlt5 != null && Math.abs(tlt5) < 1 &&
      uup20 != null && Math.abs(uup20) < 1.5) {
    scores.push({ regime: 'GOLDILOCKS', score: 0.6,
                  reasons: [`SPY +${spy5.toFixed(1)}% with vol/rate/USD all stable`] });
  }

  if (!scores.length) return { regime: 'NEUTRAL', score: 0.3, reasons: ['No strong cross-asset signal'] };

  // Safety-priority tiebreak: vol/rate/risk-off regimes outrank constructive ones at equal score.
  const PRIORITY = { VOL_SPIKE: 5, RATE_SHOCK: 5, RISK_OFF: 4, STAGFLATION: 4,
                     INFLATION_RISING: 3, USD_STRONG: 3, RISK_ON: 2, GOLDILOCKS: 2, NEUTRAL: 1 };
  scores.sort((a, b) => (b.score - a.score) || (PRIORITY[b.regime] - PRIORITY[a.regime]));
  return scores[0];
}

// Forecast = momentum extrapolation. If the same regime is supported by both
// 5d AND 20d windows in alignment (e.g. VXX rising on BOTH timeframes for
// VOL_SPIKE), we project it forward with higher confidence. If only short-
// term momentum supports it, we project it but with lower confidence and
// flag potential mean-reversion risk.
function forecastNext(factors, composites, current) {
  const reasons = [];
  let nextRegime = current.regime;
  let confidence = current.score;

  const vix5  = factors.vix?.ret5d,  vix20 = factors.vix?.ret20d;
  const tlt5  = factors.rate_long?.ret5d, tlt20 = factors.rate_long?.ret20d;
  const spy5  = factors.equity?.ret5d, spy20 = factors.equity?.ret20d;

  if (current.regime === 'VOL_SPIKE') {
    // If 20d VXX is also up, vol regime likely persists.
    if (vix20 != null && vix20 > 10) { confidence = Math.min(1, confidence + 0.15); reasons.push('vol bid on both 5d AND 20d → expected to persist'); }
    else { confidence = Math.max(0.2, confidence - 0.2); reasons.push('5d-only vol pop — mean reversion possible in 24-48h'); }
  } else if (current.regime === 'RATE_SHOCK') {
    if (tlt20 != null && tlt20 < -3) { confidence = Math.min(1, confidence + 0.15); reasons.push('long-end weakness extends through 20d'); }
    else { reasons.push('5d-only move — watch for stabilisation'); }
  } else if (current.regime === 'RISK_OFF' || current.regime === 'STAGFLATION') {
    if (spy20 != null && spy20 < 0) { confidence = Math.min(1, confidence + 0.10); reasons.push('equity weakness confirmed on 20d'); }
    else { reasons.push('20d equity still positive — could be short-term shake-out'); }
  } else if (current.regime === 'RISK_ON' || current.regime === 'GOLDILOCKS') {
    if (spy20 != null && spy20 > 1.5 && (vix20 == null || vix20 < 5)) {
      confidence = Math.min(1, confidence + 0.10); reasons.push('20d trend confirms risk appetite');
    } else {
      reasons.push('constructive but watch for vol expansion');
    }
  }
  return { regime: nextRegime, confidence: +clamp(confidence, 0, 1).toFixed(2), reasons };
}

// Map (regime, forecast confidence) → safety-preserving adjustments.
// Sizing is ALWAYS ≤ 1.0 (no amplification) and confidence boost is ALWAYS
// ≥ 0 (only ever tightens the gate).
function deriveAdjustments(current, forecast) {
  const r = forecast.regime;
  const c = forecast.confidence;
  let boost = 0;
  let sizeMult = 1.0;
  let modelHints = [];

  if (r === 'VOL_SPIKE')        { boost = 0.04 * c; sizeMult = 1.0 - 0.30 * c; modelHints = ['risk-manager voice gets priority — vol regime']; }
  else if (r === 'RATE_SHOCK')  { boost = 0.04 * c; sizeMult = 1.0 - 0.25 * c; modelHints = ['favour duration-sensitive analysis (rate-sensitive sectors)']; }
  else if (r === 'RISK_OFF')    { boost = 0.05 * c; sizeMult = 1.0 - 0.30 * c; modelHints = ['defensive bias — sentiment + risk manager voices weighted higher']; }
  else if (r === 'STAGFLATION') { boost = 0.05 * c; sizeMult = 1.0 - 0.30 * c; modelHints = ['most adverse macro mix — fundamentals + risk manager dominant']; }
  else if (r === 'INFLATION_RISING') { boost = 0.02 * c; sizeMult = 1.0 - 0.10 * c; modelHints = ['inflation-beneficiary tilt (energy, materials) plausible']; }
  else if (r === 'USD_STRONG')  { boost = 0.02 * c; sizeMult = 1.0 - 0.10 * c; modelHints = ['headwind for multinationals & EM names']; }
  else if (r === 'RISK_ON')     { boost = 0; sizeMult = 1.0; modelHints = ['constructive backdrop — momentum/quant voice may be trusted']; }
  else if (r === 'GOLDILOCKS')  { boost = 0; sizeMult = 1.0; modelHints = ['quiet tape — strategy generalist + sentiment can lead']; }
  else                          { boost = 0; sizeMult = 1.0; modelHints = []; }

  return {
    confidenceBoost: +clamp(boost, 0, MAX_BOOST_PP).toFixed(4),
    sizeMult: +clamp(sizeMult, MIN_SIZE_MULT, MAX_SIZE_MULT).toFixed(4),
    modelHints,
  };
}

// Public: compute a full forecast bundle. Cached; falls back to identity on
// any failure so trading is never blocked.
async function getForecast() {
  if (_cache.data && Date.now() - _cache.ts < TTL_MS) return _cache.data;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const snap = await macroFactor.getFactors();
      if (!snap || !snap.factors) throw new Error('no-factor-snap');
      const current  = classifyRegime(snap.factors, snap.composites);
      const forecast = forecastNext(snap.factors, snap.composites, current);
      const adjust   = deriveAdjustments(current, forecast);
      const out = { ts: Date.now(), current, forecast, adjust,
                    composites: snap.composites,
                    factorsTs: snap.ts };
      _cache = { ts: Date.now(), data: out };
      return out;
    } catch (e) {
      console.warn('[MacroForecast] getForecast failed:', e.message);
      return identity();
    }
  })();
  try { return await _inflight; } finally { _inflight = null; }
}

function identity() {
  return {
    ts: Date.now(),
    current:  { regime: 'NEUTRAL', score: 0, reasons: ['cold-start / unavailable'] },
    forecast: { regime: 'NEUTRAL', confidence: 0, reasons: [] },
    adjust:   { confidenceBoost: 0, sizeMult: 1.0, modelHints: [] },
    composites: {},
    cold: true,
  };
}

// TTL-enforced read. Returns null when entry is missing OR stale, so the
// prompt path never injects stale macro forecasts.
function getCached() {
  if (!_cache.data) return null;
  if (Date.now() - _cache.ts >= TTL_MS) return null;
  return _cache.data;
}
function getCachedRaw() {
  if (!_cache.data) return null;
  return { ..._cache.data, _ageMs: Date.now() - _cache.ts, _stale: Date.now() - _cache.ts >= TTL_MS };
}

// Compact 3-5 line prompt block. Returns null when nothing meaningful.
function renderForPrompt(d) {
  if (!d || d.cold) return null;
  const lines = [];
  lines.push(`Macro regime: NOW = ${d.current.regime} (conf ${(d.current.score * 100).toFixed(0)}%) → 24-48H FORECAST = ${d.forecast.regime} (conf ${(d.forecast.confidence * 100).toFixed(0)}%)`);
  if (d.current.reasons?.length) lines.push(`  Why now: ${d.current.reasons.slice(0, 2).join(' · ')}`);
  if (d.forecast.reasons?.length) lines.push(`  Forecast basis: ${d.forecast.reasons.slice(0, 2).join(' · ')}`);
  const adj = d.adjust || {};
  if (adj.confidenceBoost > 0 || adj.sizeMult < 1) {
    lines.push(`  Risk posture: gate +${(adj.confidenceBoost * 100).toFixed(1)}pp · sizing ×${adj.sizeMult.toFixed(2)} (informational — quorum/breaker untouched)`);
  }
  if (adj.modelHints?.length) lines.push(`  Voice hints (advisory): ${adj.modelHints[0]}`);
  return lines.join('\n');
}

module.exports = {
  getForecast, getCached, getCachedRaw, renderForPrompt,
  classifyRegime, forecastNext, deriveAdjustments,
  MAX_BOOST_PP, MIN_SIZE_MULT, MAX_SIZE_MULT,
};
