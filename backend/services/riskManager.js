const db = require('./db');

const MAX_POSITION_PCT = parseFloat(process.env.MAX_POSITION_PCT || '0.03');
const MAX_DAILY_DRAWDOWN_PCT = parseFloat(process.env.MAX_DAILY_DRAWDOWN_PCT || '0.05');
const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '0.005');
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || '0.01');
const MAX_HOLDINGS = parseInt(process.env.MAX_HOLDINGS || '4');
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.85');
const MAX_DAILY_LOSS_USD = parseFloat(process.env.MAX_DAILY_LOSS_USD || '100');
const MAX_RISK_PER_TRADE_USD = parseFloat(process.env.MAX_RISK_PER_TRADE_USD || '100');
const MIN_RISK_PER_TRADE_USD = parseFloat(process.env.MIN_RISK_PER_TRADE_USD || '50');
const MIN_DIRECTIONAL_AGREEMENT = parseInt(process.env.MIN_DIRECTIONAL_AGREEMENT || '3');

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

function checkQuorum(signal) {
  if (signal.confidence < CONFIDENCE_THRESHOLD) {
    return { ok: false, reason: `Avg confidence ${(signal.confidence * 100).toFixed(1)}% < ${(CONFIDENCE_THRESHOLD * 100)}% gate` };
  }
  const agreement = signal.agreementCount ?? 0;
  if (agreement < MIN_DIRECTIONAL_AGREEMENT) {
    return { ok: false, reason: `Only ${agreement} models agree (need ${MIN_DIRECTIONAL_AGREEMENT}-of-${signal.totalModels || 4})` };
  }
  return { ok: true };
}

async function evaluateBuy({ symbol, signal, price, equity, cash, holdings }) {
  if (signal.consensus !== 'BUY') return { allow: false, reason: 'Not a BUY signal' };
  const q = checkQuorum(signal);
  if (!q.ok) return { allow: false, reason: q.reason };
  if (holdings.length >= MAX_HOLDINGS && !holdings.find(h => h.symbol === symbol)) {
    return { allow: false, reason: `Max holdings (${MAX_HOLDINGS}) reached — diversification limit` };
  }

  const stopLossPrice = price * (1 - STOP_LOSS_PCT);
  const riskPerShare = price - stopLossPrice;
  if (riskPerShare <= 0) return { allow: false, reason: 'Invalid risk-per-share' };

  const qtyByRisk = Math.floor(MAX_RISK_PER_TRADE_USD / riskPerShare);
  const maxPositionUSD = equity * MAX_POSITION_PCT;
  const existing = holdings.find(h => h.symbol === symbol);
  const existingValue = existing ? parseFloat(existing.qty) * price : 0;
  const remainingBudgetUSD = Math.min(maxPositionUSD - existingValue, cash);
  const qtyByPosition = Math.floor(remainingBudgetUSD / price);

  const qty = Math.max(0, Math.min(qtyByRisk, qtyByPosition));
  if (qty < 1) {
    return { allow: false, reason: `Computed qty<1 (risk-cap=${qtyByRisk}, position-cap=${qtyByPosition})` };
  }

  const tradeRisk = qty * riskPerShare;
  if (tradeRisk < MIN_RISK_PER_TRADE_USD) {
    return { allow: false, reason: `Trade risk $${tradeRisk.toFixed(2)} < $${MIN_RISK_PER_TRADE_USD} minimum` };
  }
  if (tradeRisk > MAX_RISK_PER_TRADE_USD + 0.01) {
    return { allow: false, reason: `Trade risk $${tradeRisk.toFixed(2)} > $${MAX_RISK_PER_TRADE_USD} maximum` };
  }

  return {
    allow: true,
    qty,
    stop_loss: parseFloat(stopLossPrice.toFixed(2)),
    take_profit: parseFloat((price * (1 + TAKE_PROFIT_PCT)).toFixed(2)),
    notional: qty * price,
    riskUSD: parseFloat(tradeRisk.toFixed(2)),
  };
}

async function evaluateSell({ symbol, signal, holdings }) {
  if (signal.consensus !== 'SELL') return { allow: false, reason: 'Not a SELL signal' };
  const q = checkQuorum(signal);
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
    maxPositionPct: MAX_POSITION_PCT,
    maxDailyDrawdownPct: MAX_DAILY_DRAWDOWN_PCT,
    stopLossPct: STOP_LOSS_PCT,
    takeProfitPct: TAKE_PROFIT_PCT,
    maxHoldings: MAX_HOLDINGS,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    maxDailyLossUSD: MAX_DAILY_LOSS_USD,
    maxRiskPerTradeUSD: MAX_RISK_PER_TRADE_USD,
    minRiskPerTradeUSD: MIN_RISK_PER_TRADE_USD,
    minDirectionalAgreement: MIN_DIRECTIONAL_AGREEMENT,
    strategy: 'day-trading',
  };
}

module.exports = {
  computeEquity,
  checkCircuitBreaker,
  evaluateBuy,
  evaluateSell,
  evaluateStops,
  getConfig,
};
