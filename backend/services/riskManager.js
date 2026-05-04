const db = require('./db');

const MAX_DAILY_DRAWDOWN_PCT = parseFloat(process.env.MAX_DAILY_DRAWDOWN_PCT || '0.05');
const MAX_DAILY_LOSS_USD = parseFloat(process.env.MAX_DAILY_LOSS_USD || '100');

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

  if (lossUSD >= MAX_DAILY_LOSS_USD && !portfolio.circuit_breaker) {
    await db.updatePortfolio({ circuit_breaker: true });
    await db.recordAudit({
      event_type: 'CIRCUIT_BREAKER_TRIPPED',
      payload: { reason: 'daily_loss_budget', lossUSD, threshold: MAX_DAILY_LOSS_USD, dayStart, equity },
    });
    return { tripped: true, drawdown, lossUSD, reason: `Daily loss $${lossUSD.toFixed(2)} ≥ $${MAX_DAILY_LOSS_USD} budget` };
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

function checkQuorum(signal, sc) {
  if (signal.confidence < sc.confidenceThreshold) {
    return { ok: false, reason: `Avg confidence ${(signal.confidence * 100).toFixed(1)}% < ${(sc.confidenceThreshold * 100)}% gate` };
  }
  const agreement = signal.agreementCount ?? 0;
  if (agreement < sc.minDirectionalAgreement) {
    return { ok: false, reason: `Only ${agreement} models agree (need ${sc.minDirectionalAgreement}-of-${signal.totalModels || 4})` };
  }
  return { ok: true };
}

async function evaluateBuy({ symbol, signal, price, equity, cash, holdings, strategyConfig }) {
  const sc = strategyConfig;
  if (signal.consensus !== 'BUY') return { allow: false, reason: 'Not a BUY signal' };
  const q = checkQuorum(signal, sc);
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

  const qtyByRisk = Math.floor(sc.maxRiskUSD / riskPerShare);
  const maxPositionUSD = equity * sc.maxPositionPct;
  const remainingBudgetUSD = Math.min(maxPositionUSD, cash);
  const qtyByPosition = Math.floor(remainingBudgetUSD / price);

  const qty = Math.max(0, Math.min(qtyByRisk, qtyByPosition));
  if (qty < 1) {
    return { allow: false, reason: `Computed qty<1 (risk-cap=${qtyByRisk}, position-cap=${qtyByPosition})` };
  }

  const tradeRisk = qty * riskPerShare;
  if (tradeRisk < sc.minRiskUSD) {
    return { allow: false, reason: `Trade risk $${tradeRisk.toFixed(2)} < $${sc.minRiskUSD} minimum` };
  }
  if (tradeRisk > sc.maxRiskUSD + 0.01) {
    return { allow: false, reason: `Trade risk $${tradeRisk.toFixed(2)} > $${sc.maxRiskUSD} maximum` };
  }

  return {
    allow: true, qty,
    stop_loss: parseFloat(stopLossPrice.toFixed(2)),
    take_profit: parseFloat((price * (1 + sc.takeProfitPct)).toFixed(2)),
    notional: qty * price,
    riskUSD: parseFloat(tradeRisk.toFixed(2)),
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
    return { trigger: 'STOP_LOSS', qty: parseFloat(holding.qty), reason: `Price ${currentPrice} hit stop-loss ${stop}` };
  }
  if (target && currentPrice >= target) {
    return { trigger: 'TAKE_PROFIT', qty: parseFloat(holding.qty), reason: `Price ${currentPrice} hit take-profit ${target}` };
  }
  return null;
}

function getConfig() {
  return {
    maxDailyDrawdownPct: MAX_DAILY_DRAWDOWN_PCT,
    maxDailyLossUSD: MAX_DAILY_LOSS_USD,
  };
}

module.exports = {
  computeEquity, checkCircuitBreaker,
  evaluateBuy, evaluateSell, evaluateStops, getConfig,
};
