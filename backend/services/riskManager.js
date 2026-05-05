const db = require('./db');
const { getRiskScale, DEFAULT_RISK_SCALE } = require('../strategies');

const MAX_DAILY_DRAWDOWN_PCT = parseFloat(process.env.MAX_DAILY_DRAWDOWN_PCT || '0.05');
// Hard env-level ceiling on daily $ loss. The active risk scale provides its own
// (typically smaller) budget; we always use the MIN of the two so env can cap
// even an Aggressive scale during early testing.
const MAX_DAILY_LOSS_USD_ENV = parseFloat(process.env.MAX_DAILY_LOSS_USD || '0') || null;

// --- Compounding scaling tunables -------------------------------------------
// Account-growth: every +GROWTH_STEP equity → +GROWTH_BUMP risk multiplier.
const GROWTH_STEP = 0.10;   // 10% growth per step
const GROWTH_BUMP = 0.05;   // +5% per step
const GROWTH_MIN  = 0.50;   // shrink to 50% on deep drawdown
const GROWTH_MAX  = 2.00;   // never exceed 2× base sizing from growth alone
// Performance curve: last-N closed trades, net PnL as % of starting balance.
const PERF_TRADE_WINDOW = 20;
const PERF_GAIN_GAIN    = 2.0;  // 1 + 2× pnl_pct → e.g. +5% → +10% sizing
const PERF_MIN          = 0.80;
const PERF_MAX          = 1.20;
// Confidence weighting: confidence in [threshold, 1] → fraction in [0, 1].
// Final per-trade $ risk = lerp(min, max, fraction) × growth × performance.
const ABS_RISK_CEILING_MULT = 2.0; // hard ceiling vs scale.maxRiskUSD

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function effectiveDailyLossBudget(portfolio) {
  const scale = getRiskScale(portfolio?.risk_scale || DEFAULT_RISK_SCALE);
  const scaleBudget = scale.maxDailyLossUSD;
  return MAX_DAILY_LOSS_USD_ENV ? Math.min(scaleBudget, MAX_DAILY_LOSS_USD_ENV) : scaleBudget;
}

async function computeEquity(holdings, priceLookup) {
  const portfolio = await db.getPortfolio();
  let equity = parseFloat(portfolio.cash_balance);
  for (const h of holdings) {
    const price = priceLookup[h.symbol] || parseFloat(h.avg_cost);
    equity += parseFloat(h.qty) * price;
  }
  return { equity, cash: parseFloat(portfolio.cash_balance), portfolio };
}

async function checkCircuitBreaker(equity) {
  const portfolio = await db.getPortfolio();
  const dayStart = parseFloat(portfolio.day_start_equity);
  const drawdown = (dayStart - equity) / dayStart;
  const lossUSD = dayStart - equity;
  const dailyLossBudget = effectiveDailyLossBudget(portfolio);

  if (lossUSD >= dailyLossBudget && !portfolio.circuit_breaker) {
    await db.updatePortfolio({ circuit_breaker: true });
    await db.recordAudit({
      event_type: 'CIRCUIT_BREAKER_TRIPPED',
      payload: { reason: 'daily_loss_budget', lossUSD, threshold: dailyLossBudget, riskScale: portfolio.risk_scale, dayStart, equity },
    });
    return { tripped: true, drawdown, lossUSD, reason: `Daily loss $${lossUSD.toFixed(2)} ≥ $${dailyLossBudget} budget (${portfolio.risk_scale})` };
  }
  if (drawdown >= MAX_DAILY_DRAWDOWN_PCT && !portfolio.circuit_breaker) {
    await db.updatePortfolio({ circuit_breaker: true });
    await db.recordAudit({
      event_type: 'CIRCUIT_BREAKER_TRIPPED',
      payload: { reason: 'drawdown_pct', drawdown, dayStart, equity, threshold: MAX_DAILY_DRAWDOWN_PCT },
    });
    return { tripped: true, drawdown, lossUSD, reason: `Drawdown ${(drawdown * 100).toFixed(2)}% ≥ ${(MAX_DAILY_DRAWDOWN_PCT * 100).toFixed(0)}%` };
  }
  return { tripped: portfolio.circuit_breaker, drawdown, lossUSD };
}

function checkQuorum(signal, sc, opts = {}) {
  // Regime meta layer can ONLY tighten — never lower — the confidence gate.
  // We take max(base, base + boost) with boost ≥ 0 enforced at the source
  // (metaLearningService returns boost in [0, 0.10]). This double-defense
  // means a buggy upstream value can't accidentally relax safety.
  const boost = Math.max(0, Number(opts.confidenceBoost) || 0);
  const effectiveThreshold = sc.confidenceThreshold + boost;
  if (signal.confidence < effectiveThreshold) {
    const tag = boost > 0 ? ` (regime +${(boost * 100).toFixed(0)}pp)` : '';
    return { ok: false, reason: `Avg confidence ${(signal.confidence * 100).toFixed(1)}% < ${(effectiveThreshold * 100).toFixed(1)}% gate${tag}` };
  }
  const agreement = signal.agreementCount ?? 0;
  if (agreement < sc.minDirectionalAgreement) {
    return { ok: false, reason: `Only ${agreement} models agree (need ${sc.minDirectionalAgreement}-of-${signal.totalModels || 4})` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Compounding-confidence scaling. Pure function — deterministic given inputs.
//   growthMult: account-growth scaling. Steps every 10% of starting equity.
//   perfMult:   performance curve from recent closed PnL.
//   confFraction: where in the [min, max] risk band this trade lands.
// ---------------------------------------------------------------------------
function computeDynamicScaling({ equity, startingBalance, recentClosedTrades = [] }) {
  // Growth multiplier — discrete steps so it's predictable, not jittery.
  // Symmetric stepping: only count a step when a FULL ±10% move has occurred.
  // Math.trunc rounds toward zero so a -0.1% dip doesn't immediately step down.
  const growthRatio = startingBalance > 0 ? (equity / startingBalance - 1) : 0;
  const growthSteps = Math.trunc(growthRatio / GROWTH_STEP);
  const growthMult = clamp(1 + growthSteps * GROWTH_BUMP, GROWTH_MIN, GROWTH_MAX);

  // Performance multiplier — last N closed trades' net PnL as % of starting balance.
  const closed = recentClosedTrades
    .filter(t => t.pnl !== null && t.pnl !== undefined)
    .slice(0, PERF_TRADE_WINDOW);
  const netPnL = closed.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
  const perfPct = startingBalance > 0 ? (netPnL / startingBalance) : 0;
  const perfMult = clamp(1 + PERF_GAIN_GAIN * perfPct, PERF_MIN, PERF_MAX);

  return {
    growthMult: +growthMult.toFixed(4),
    growthSteps,
    growthRatio: +growthRatio.toFixed(4),
    perfMult: +perfMult.toFixed(4),
    perfNetPnL: +netPnL.toFixed(2),
    perfTradesUsed: closed.length,
    compoundMult: +(growthMult * perfMult).toFixed(4),
  };
}

function confidenceFraction(confidence, threshold) {
  if (threshold >= 1) return 1;
  return clamp((confidence - threshold) / (1 - threshold), 0, 1);
}

// Returns the dynamic per-trade target $-risk for a given signal under the
// active scale + dynamic multipliers. Pure function — caller still applies
// position-cap and cash limits.
function computeTargetRisk({ scale, signal, dynamic }) {
  const frac = confidenceFraction(signal.confidence, scale.confidenceThreshold);
  const baseRisk = scale.minRiskUSD + (scale.maxRiskUSD - scale.minRiskUSD) * frac;
  const target = baseRisk * dynamic.growthMult * dynamic.perfMult;
  const ceiling = scale.maxRiskUSD * ABS_RISK_CEILING_MULT;
  const floor = scale.minRiskUSD * 0.5; // never below half the floor
  return {
    confFraction: +frac.toFixed(4),
    baseRiskUSD: +baseRisk.toFixed(2),
    targetRiskUSD: +clamp(target, floor, ceiling).toFixed(2),
    ceilingUSD: ceiling,
  };
}

async function evaluateBuy({ symbol, signal, price, equity, cash, holdings, strategyConfig, dynamic }) {
  const sc = strategyConfig;
  if (signal.consensus !== 'BUY') return { allow: false, reason: 'Not a BUY signal' };
  // Regime meta layer can tighten the confidence threshold by up to +10pp.
  // boost is sanitized & non-negative inside checkQuorum.
  const dynForGate = dynamic || {};
  const regimeBoost = Math.max(0, Number(dynForGate.regimeAdjust?.confidenceBoost) || 0);
  // Macro-forecast layer can ALSO tighten the gate (additively with regime).
  // Source clamps boost to ≤5pp; we re-floor at 0 here as defence-in-depth so
  // a buggy upstream value can never RELAX the threshold.
  const macroBoost = Math.max(0, Number(dynForGate.macroAdjust?.confidenceBoost) || 0);
  const q = checkQuorum(signal, sc, { confidenceBoost: regimeBoost + macroBoost });
  if (!q.ok) return { allow: false, reason: q.reason };
  // Reject averaging-in: if symbol already held in this strategy, force a new
  // sell-or-hold cycle before re-entering. Avoids local-state corruption from
  // upsertHolding (which replaces qty rather than accumulating).
  if (holdings.find(h => h.symbol === symbol)) {
    return { allow: false, reason: 'Already long in this strategy — no averaging-in' };
  }
  if (holdings.length >= sc.maxHoldings) {
    return { allow: false, reason: `Max ${sc.label || sc.name} holdings (${sc.maxHoldings}) reached` };
  }

  const stopLossPrice = price * (1 - sc.stopLossPct);
  const riskPerShare = price - stopLossPrice;
  if (riskPerShare <= 0) return { allow: false, reason: 'Invalid risk-per-share' };

  // Dynamic target: confidence-weighted and compounding-scaled.
  const dyn = dynamic || { growthMult: 1, perfMult: 1, compoundMult: 1 };
  // Adaptive (own track-record) and portfolio (correlation/concentration)
  // multipliers. Both are clamped at the source: adaptive ∈ [0.7, 1.2],
  // portfolio ∈ [0.5, 1.0]. Pure SIZING modifiers — never relax the quorum,
  // confidence gate, daily caps, or circuit breaker.
  const adaptiveMult  = Number.isFinite(dyn.adaptiveMult)  ? dyn.adaptiveMult  : 1.0;
  const portfolioMult = Number.isFinite(dyn.portfolioMult) ? dyn.portfolioMult : 1.0;
  // ML adaptive multiplier from mlAdaptiveService.predict(). Clamped at the
  // source to [0.85, 1.15] — a tighter band than legacy adaptiveMult so the
  // composite stack can never expand the existing safety envelope. Defaults
  // to 1.0 when the model is in cold-start or the prediction is unavailable.
  const mlMult = Number.isFinite(dyn.mlMult) ? Math.max(0.85, Math.min(1.15, dyn.mlMult)) : 1.0;
  // Regime-aware sizing nudge. Asymmetric clamp [0.85, 1.10] — easier to
  // shrink than to grow. Defaults to 1.0 when regime stats haven't met
  // META_MIN_SAMPLES yet (cold-start = identity).
  const regimeMult = Number.isFinite(dyn.regimeAdjust?.regimeMult)
    ? Math.max(0.85, Math.min(1.10, dyn.regimeAdjust.regimeMult)) : 1.0;
  // Macro-forecast sizing nudge. Hard ceiling of 1.0 — macro can ONLY shrink
  // size, never amplify. Floor at 0.7. This is the strongest tightener in
  // the stack because cross-asset stress is the broadest risk signal we have.
  const macroMult = Number.isFinite(dyn.macroAdjust?.sizeMult)
    ? Math.max(0.70, Math.min(1.00, dyn.macroAdjust.sizeMult)) : 1.0;
  const target = computeTargetRisk({ scale: sc, signal, dynamic: dyn });
  const adjustedRiskUSD = +(target.targetRiskUSD * adaptiveMult * portfolioMult * mlMult * regimeMult * macroMult).toFixed(2);

  const qtyByRisk = Math.floor(adjustedRiskUSD / riskPerShare);
  const maxPositionUSD = equity * sc.maxPositionPct;
  const remainingBudgetUSD = Math.min(maxPositionUSD, cash);
  const qtyByPosition = Math.floor(remainingBudgetUSD / price);

  const qty = Math.max(0, Math.min(qtyByRisk, qtyByPosition));
  if (qty < 1) {
    return { allow: false, reason: `Computed qty<1 (target=$${target.targetRiskUSD}, adj=$${adjustedRiskUSD}, risk-cap=${qtyByRisk}, position-cap=${qtyByPosition})` };
  }

  const tradeRisk = qty * riskPerShare;
  // Hard absolute ceiling — should never be hit thanks to target clamp, but defends
  // against future param changes.
  if (tradeRisk > target.ceilingUSD + 0.01) {
    return { allow: false, reason: `Trade risk $${tradeRisk.toFixed(2)} > absolute ceiling $${target.ceilingUSD}` };
  }

  return {
    allow: true, qty,
    stop_loss: parseFloat(stopLossPrice.toFixed(2)),
    take_profit: parseFloat((price * (1 + sc.takeProfitPct)).toFixed(2)),
    notional: qty * price,
    riskUSD: parseFloat(tradeRisk.toFixed(2)),
    sizing: {
      targetRiskUSD: target.targetRiskUSD,
      adjustedRiskUSD,
      baseRiskUSD: target.baseRiskUSD,
      confFraction: target.confFraction,
      growthMult: dyn.growthMult,
      perfMult: dyn.perfMult,
      compoundMult: dyn.compoundMult,
      adaptiveMult,
      portfolioMult,
      mlMult,
      regimeMult,
      regimeBoost,
      regime: dyn.regimeAdjust?.regime || null,
      macroMult,
      macroBoost,
      macroRegime: dyn.macroAdjust?.regime || null,
      macroForecast: dyn.macroAdjust?.forecastRegime || null,
    },
  };
}

async function evaluateSell({ symbol, signal, holdings, strategyConfig }) {
  if (signal.consensus !== 'SELL') return { allow: false, reason: 'Not a SELL signal' };
  const q = checkQuorum(signal, strategyConfig);
  if (!q.ok) return { allow: false, reason: q.reason };
  const holding = holdings.find(h => h.symbol === symbol);
  if (!holding || parseFloat(holding.qty) <= 0) {
    return { allow: false, reason: 'No open position to sell' };
  }
  return { allow: true, qty: parseFloat(holding.qty) };
}

async function evaluateStops({ symbol, currentPrice, holding }) {
  const stop = parseFloat(holding.stop_loss);
  const target = parseFloat(holding.take_profit);
  if (stop && currentPrice <= stop) {
    const trailing = !!holding.trailing_armed;
    return { trigger: trailing ? 'TRAILING_STOP' : 'STOP_LOSS', qty: parseFloat(holding.qty),
      reason: `Price ${currentPrice} hit ${trailing ? 'trailing' : 'stop'}-loss ${stop}` };
  }
  if (target && currentPrice >= target) {
    return { trigger: 'TAKE_PROFIT', qty: parseFloat(holding.qty), reason: `Price ${currentPrice} hit take-profit ${target}` };
  }
  return null;
}

// Trailing-stop ratchet — pure compute, returns the new trailing state for a
// holding given the current price and strategy config. Caller persists.
//   - Only ratchets stops UP, never down.
//   - Arms only after price reaches entry × (1 + trailingActivatePct).
//   - Returns null if strategy doesn't use trailing or no change is needed.
function computeTrailingUpdate({ holding, currentPrice, strategyConfig }) {
  const trailPct = strategyConfig?.trailingStopPct;
  const armPct = strategyConfig?.trailingActivatePct;
  if (!trailPct || !armPct) return null;
  if (!currentPrice || currentPrice <= 0) return null;
  const entry = parseFloat(holding.avg_cost);
  if (!entry || entry <= 0) return null;

  const prevPeak = parseFloat(holding.highest_price) || entry;
  const newPeak = Math.max(prevPeak, currentPrice);
  const armed = !!holding.trailing_armed;
  const shouldArm = armed || currentPrice >= entry * (1 + armPct);
  if (!shouldArm) {
    // Just track the peak so when we DO arm, we use the right anchor.
    if (newPeak > prevPeak) return { highest_price: +newPeak.toFixed(4) };
    return null;
  }
  const trailingStop = +(newPeak * (1 - trailPct)).toFixed(2);
  const currentStop = parseFloat(holding.stop_loss) || 0;
  const newStop = Math.max(currentStop, trailingStop);

  const update = {};
  if (newPeak > prevPeak) update.highest_price = +newPeak.toFixed(4);
  if (!armed) update.trailing_armed = true;
  if (newStop > currentStop + 0.0001) update.stop_loss = newStop;
  return Object.keys(update).length ? update : null;
}

function getConfig(portfolio) {
  return {
    maxDailyDrawdownPct: MAX_DAILY_DRAWDOWN_PCT,
    maxDailyLossUSD: effectiveDailyLossBudget(portfolio),
    envCapUSD: MAX_DAILY_LOSS_USD_ENV,
  };
}

module.exports = {
  computeEquity, checkCircuitBreaker,
  evaluateBuy, evaluateSell, evaluateStops, getConfig,
  effectiveDailyLossBudget,
  computeDynamicScaling, computeTargetRisk,
  computeTrailingUpdate,
  // tunables exported for UI introspection
  tunables: { GROWTH_STEP, GROWTH_BUMP, GROWTH_MIN, GROWTH_MAX, PERF_TRADE_WINDOW, PERF_GAIN_GAIN, PERF_MIN, PERF_MAX, ABS_RISK_CEILING_MULT },
};
