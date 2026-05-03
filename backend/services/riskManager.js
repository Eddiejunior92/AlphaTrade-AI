const db = require('./db');

const MAX_POSITION_PCT = parseFloat(process.env.MAX_POSITION_PCT || '0.03');
const MAX_DAILY_DRAWDOWN_PCT = parseFloat(process.env.MAX_DAILY_DRAWDOWN_PCT || '0.05');
const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '0.03');
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || '0.06');
const MAX_HOLDINGS = parseInt(process.env.MAX_HOLDINGS || '8');
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.85');

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
  if (drawdown >= MAX_DAILY_DRAWDOWN_PCT && !portfolio.circuit_breaker) {
    await db.updatePortfolio({ circuit_breaker: true });
    await db.recordAudit({
      event_type: 'CIRCUIT_BREAKER_TRIPPED',
      payload: { drawdown, dayStart, equity, threshold: MAX_DAILY_DRAWDOWN_PCT },
    });
    return { tripped: true, drawdown };
  }
  return { tripped: portfolio.circuit_breaker, drawdown };
}

async function evaluateBuy({ symbol, signal, price, equity, cash, holdings }) {
  if (signal.consensus !== 'BUY') return { allow: false, reason: 'Not a BUY signal' };
  if (signal.confidence < CONFIDENCE_THRESHOLD) {
    return { allow: false, reason: `Confidence ${(signal.confidence * 100).toFixed(1)}% < ${(CONFIDENCE_THRESHOLD * 100)}% threshold` };
  }
  if (holdings.length >= MAX_HOLDINGS && !holdings.find(h => h.symbol === symbol)) {
    return { allow: false, reason: `Max holdings (${MAX_HOLDINGS}) reached — diversification limit` };
  }

  const maxPositionUSD = equity * MAX_POSITION_PCT;
  const existing = holdings.find(h => h.symbol === symbol);
  const existingValue = existing ? parseFloat(existing.qty) * price : 0;
  const remainingBudget = Math.min(maxPositionUSD - existingValue, cash);

  if (remainingBudget <= price) {
    return { allow: false, reason: 'Insufficient cash or position-size limit reached' };
  }

  const qty = Math.floor(remainingBudget / price);
  if (qty < 1) return { allow: false, reason: 'Computed quantity < 1 share' };

  return {
    allow: true,
    qty,
    stop_loss: parseFloat((price * (1 - STOP_LOSS_PCT)).toFixed(2)),
    take_profit: parseFloat((price * (1 + TAKE_PROFIT_PCT)).toFixed(2)),
    notional: qty * price,
  };
}

async function evaluateSell({ symbol, signal, holdings }) {
  if (signal.consensus !== 'SELL') return { allow: false, reason: 'Not a SELL signal' };
  if (signal.confidence < CONFIDENCE_THRESHOLD) {
    return { allow: false, reason: `Confidence ${(signal.confidence * 100).toFixed(1)}% < ${(CONFIDENCE_THRESHOLD * 100)}% threshold` };
  }
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
