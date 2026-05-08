// positionSizingService — asymmetric per-name position cap by Council
// confidence. Phase B — May 2026.
//
// Surface:
//   computeAsymmetricSize(confidence, baseStrategyConfig)
//     → { maxPositionPct, baseMaxPct, multiplier, clamped, violatedBound }
//
// Formula (day strategies only — swing strategies pass-through):
//   raw = baseMaxPct * (1 + 2 * (clamp(conf, 0.65, 0.90) - 0.65) / 0.25)
//   pct = clamp(raw, ABS_FLOOR=0.005, ABS_CEIL=0.05)
//
// At conf=0.65 → 1.0× base. At conf=0.90 → 3.0× base. With base=0.01 the
// effective range is exactly [0.01, 0.03] for the typical day cap; with
// the current 4% day base, it is [0.04, 0.05] (cap-bound at high conf).
//
// SAFETY:
//   • Hard absolute ceiling 0.05 == discordApproval SAFE_KEY upper bound.
//   • Hard absolute floor 0.005 == strategy minimum (defence-in-depth).
//   • If raw exceeds [0.005, 0.05], `violatedBound:true` so agent.js can
//     emit a SIZING_BOUND_VIOLATED audit row (the clamped value is still
//     used — this ONLY shrinks size relative to the formula intent).
//   • Pure function — never mutates the input strategyConfig.
//   • CANNOT bypass quorum, gate, daily-loss, breaker, kill switch, or
//     riskManager.evaluateBuy's qty=min(qtyByRisk, qtyByPosition) gate.

const ABS_FLOOR = 0.005;
const ABS_CEIL  = 0.05;
const CONF_FLOOR = 0.65;
const CONF_CEIL  = 0.90;

function _isDayStrategy(name) { return name === 'day' || name === 'asx_day'; }

function computeAsymmetricSize(confidence, baseStrategyConfig) {
  const sc = baseStrategyConfig || {};
  const baseMaxPct = Number.isFinite(sc.maxPositionPct) ? sc.maxPositionPct : null;
  if (baseMaxPct == null) {
    return { maxPositionPct: null, baseMaxPct: null, multiplier: 1.0, clamped: false, violatedBound: false, applied: false, reason: 'no_base_max_pct' };
  }
  if (!_isDayStrategy(sc.name)) {
    // Swing strategies pass-through unchanged.
    return { maxPositionPct: baseMaxPct, baseMaxPct, multiplier: 1.0, clamped: false, violatedBound: false, applied: false, reason: 'non_day_strategy' };
  }
  const conf = Number.isFinite(confidence) ? Math.min(CONF_CEIL, Math.max(CONF_FLOOR, confidence)) : CONF_FLOOR;
  const multiplier = 1.0 + 2.0 * ((conf - CONF_FLOOR) / (CONF_CEIL - CONF_FLOOR));
  const raw = baseMaxPct * multiplier;
  const violatedBound = raw < ABS_FLOOR || raw > ABS_CEIL;
  const maxPositionPct = Math.min(ABS_CEIL, Math.max(ABS_FLOOR, raw));
  const clamped = maxPositionPct !== raw;
  return {
    maxPositionPct: +maxPositionPct.toFixed(6),
    baseMaxPct,
    multiplier: +multiplier.toFixed(4),
    confidence: conf,
    rawPct: +raw.toFixed(6),
    clamped,
    violatedBound,
    applied: true,
  };
}

// Build a NEW strategyConfig clone with the asymmetric maxPositionPct.
// Never mutates the input.
function withAsymmetricSizing(baseStrategyConfig, confidence) {
  const out = computeAsymmetricSize(confidence, baseStrategyConfig);
  if (!out.applied) return { sc: baseStrategyConfig, sizing: out };
  return {
    sc: { ...baseStrategyConfig, maxPositionPct: out.maxPositionPct },
    sizing: out,
  };
}

module.exports = {
  computeAsymmetricSize,
  withAsymmetricSizing,
  ABS_FLOOR, ABS_CEIL, CONF_FLOOR, CONF_CEIL,
};
