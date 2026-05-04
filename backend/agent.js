require('dotenv').config();
const llmService = require('./services/llmService');
const alpacaService = require('./services/alpacaService');
const discordService = require('./services/discordService');
const riskManager = require('./services/riskManager');
const db = require('./services/db');

const WATCHLIST = (process.env.WATCHLIST || 'AAPL,NVDA,TSLA,MSFT,AMZN,META,GOOGL,SPY')
  .split(',').map(s => s.trim()).filter(Boolean);
const TRADING_MODE = process.env.TRADING_MODE || 'paper';
const STRATEGY = 'day-trading';
const INTERVAL_SECONDS = Math.max(30, parseInt(process.env.AGENT_INTERVAL_SECONDS || '60'));
const BAR_TIMEFRAME = process.env.BAR_TIMEFRAME || '1Min';
const BAR_LOOKBACK = parseInt(process.env.BAR_LOOKBACK || '30');
const FORCE_FLATTEN_MINUTES_BEFORE_CLOSE = parseInt(process.env.FORCE_FLATTEN_MINUTES_BEFORE_CLOSE || '5');

let memoryState = {
  lastRun: null,
  lastSignals: {},
  lastError: null,
  startTime: Date.now(),
  cycleCount: 0,
  marketOpen: false,
  nextOpen: null,
  nextClose: null,
  lastFlatten: null,
};

let intervalHandle = null;
let dailyResetHandle = null;
let cycleInProgress = false;
let flattenInProgress = false;

async function buildPriceLookup(holdings) {
  const lookup = {};
  const stale = {};
  await Promise.all(holdings.map(async h => {
    const bars = await alpacaService.getBars(h.symbol, '1Min', 1);
    if (bars.length) {
      lookup[h.symbol] = bars[bars.length - 1].c;
    } else {
      lookup[h.symbol] = parseFloat(h.avg_cost);
      stale[h.symbol] = true;
    }
  }));
  return { lookup, stale };
}

async function executeOrder({ symbol, side, qty, price, signal, stop_loss, take_profit, reason }) {
  let order = { id: `mock-${Date.now()}`, status: 'mock_filled' };

  try {
    if (alpacaService.isConfigured()) {
      order = await alpacaService.placeOrder({ symbol, qty, side: side.toLowerCase() });
    }
  } catch (e) {
    await db.recordTrade({
      symbol, side, qty, price, confidence: signal?.confidence,
      consensus: signal?.consensus, status: 'error',
      reason: `Order failed: ${e.message}`,
    });
    await db.recordAudit({
      event_type: 'TRADE_ERROR', symbol, decision: side,
      payload: { error: e.message, qty, price },
    });
    return null;
  }

  const cost = qty * price;
  let pnl = null;

  if (side === 'BUY') {
    await db.adjustCash(-cost);
    await db.upsertHolding({ symbol, qty, avg_cost: price, stop_loss, take_profit });
  } else {
    const existing = await db.getHolding(symbol);
    if (existing) {
      pnl = (price - parseFloat(existing.avg_cost)) * qty;
      await db.deleteHolding(symbol);
    }
    await db.adjustCash(cost);
  }

  const trade = await db.recordTrade({
    symbol, side, qty, price,
    confidence: signal?.confidence,
    consensus: signal?.consensus,
    order_id: order.id, status: order.status || 'submitted',
    pnl, reason,
  });

  await db.recordAudit({
    event_type: 'TRADE_EXECUTED', symbol, decision: side,
    confidence: signal?.confidence,
    models: signal?.models,
    payload: { qty, price, stop_loss, take_profit, pnl, reason },
  });

  await discordService.sendTradeAlert({
    symbol, action: side, qty, price: price.toFixed(2),
    confidence: signal?.confidence || 1, reason,
  });

  return trade;
}

async function evaluateExistingPositions({ lookup, stale }, holdings, equity) {
  for (const h of holdings) {
    const price = lookup[h.symbol];
    if (!price || stale[h.symbol]) continue;
    const trigger = await riskManager.evaluateStops({ symbol: h.symbol, currentPrice: price, holding: h });
    if (trigger) {
      await db.recordAudit({
        event_type: trigger.trigger, symbol: h.symbol, decision: 'SELL',
        payload: { price, ...trigger },
      });
      await executeOrder({
        symbol: h.symbol, side: 'SELL', qty: parseFloat(h.qty), price,
        signal: { consensus: 'SELL', confidence: 1.0, models: [] },
        reason: trigger.reason,
      });
    }
  }
}

async function flattenAllPositions(reason = 'End-of-day flatten') {
  if (flattenInProgress) return;
  flattenInProgress = true;
  try {
    const holdings = await db.getHoldings();
    if (!holdings.length) {
      flattenInProgress = false;
      return;
    }
    console.log(`[Agent] Flattening ${holdings.length} positions — ${reason}`);
    await db.recordAudit({ event_type: 'FORCE_FLATTEN_START', payload: { reason, count: holdings.length } });

    const brokerConfigured = alpacaService.isConfigured();
    let brokerOk = !brokerConfigured;
    if (brokerConfigured) {
      try {
        await alpacaService.closeAllPositions();
        await new Promise(r => setTimeout(r, 1500));
        const remaining = await alpacaService.getPositions();
        brokerOk = remaining.length === 0;
        if (!brokerOk) {
          await db.recordAudit({
            event_type: 'FORCE_FLATTEN_BROKER_FAIL',
            payload: { reason, remaining: remaining.map(p => p.symbol) },
          });
          await discordService.sendCircuitBreakerAlert(
            `⚠ FLATTEN INCOMPLETE — broker still holds: ${remaining.map(p => p.symbol).join(', ')}. Local state NOT cleared. Investigate immediately.`
          );
          console.error('[Agent] Broker flatten incomplete — local state preserved for reconciliation');
          return;
        }
      } catch (e) {
        await db.recordAudit({ event_type: 'FORCE_FLATTEN_BROKER_FAIL', payload: { reason, error: e.message } });
        await discordService.sendCircuitBreakerAlert(`⚠ FLATTEN ERROR — ${e.message}. Local state NOT cleared.`);
        console.error('[Agent] Broker flatten threw — local state preserved:', e.message);
        return;
      }
    }

    const priceMap = await buildPriceLookup(holdings);
    for (const h of holdings) {
      const price = priceMap.lookup[h.symbol] || parseFloat(h.avg_cost);
      const qty = parseFloat(h.qty);
      const pnl = (price - parseFloat(h.avg_cost)) * qty;
      await db.adjustCash(qty * price);
      await db.deleteHolding(h.symbol);
      await db.recordTrade({
        symbol: h.symbol, side: 'SELL', qty, price,
        confidence: 1.0, consensus: 'SELL',
        order_id: `flatten-${Date.now()}`, status: 'flattened',
        pnl, reason,
      });
      await db.recordAudit({
        event_type: 'FORCE_FLATTEN', symbol: h.symbol, decision: 'SELL',
        payload: { qty, price, pnl, reason },
      });
    }
    memoryState.lastFlatten = new Date().toISOString();
    await discordService.sendCircuitBreakerAlert(`End-of-day flatten complete — ${holdings.length} positions closed`);
  } catch (e) {
    console.error('[Agent] flatten error:', e.message);
  } finally {
    flattenInProgress = false;
  }
}

async function analyzeAndTradeSymbol(symbol, portfolio, holdings, equity, cash) {
  const bars = await alpacaService.getBars(symbol, BAR_TIMEFRAME, BAR_LOOKBACK);
  if (!bars.length) return null;
  const prices = bars.map(b => b.c);
  const latest = prices[prices.length - 1];
  const change = ((latest - prices[0]) / prices[0] * 100).toFixed(2);
  const sentiment = parseFloat(change) > 0.5 ? 'bullish' : parseFloat(change) < -0.5 ? 'bearish' : 'neutral';

  const priceData = {
    symbol, latest, change: `${change}%`,
    high: Math.max(...prices).toFixed(2),
    low: Math.min(...prices).toFixed(2),
    bars: bars.slice(-5).map(b => ({ t: b.t, c: b.c, v: b.v })),
    timeframe: BAR_TIMEFRAME,
    strategy: 'intraday day-trading',
  };

  const holding = holdings.find(h => h.symbol === symbol) || null;
  const signal = await llmService.getEnsembleDecision({ symbol, priceData, sentiment, holding, portfolio });

  await db.recordAudit({
    event_type: 'SIGNAL', symbol,
    decision: signal.consensus, confidence: signal.confidence,
    models: signal.models,
    payload: { priceData, sentiment, votes: signal.votes, reason: signal.reason },
  });

  memoryState.lastSignals[symbol] = {
    symbol, timestamp: new Date().toISOString(),
    price: latest, change: `${change}%`,
    signal: signal.consensus, confidence: signal.confidence,
    votes: signal.votes, models: signal.models, reason: signal.reason,
  };

  if (signal.consensus === 'BUY') {
    const eval_ = await riskManager.evaluateBuy({ symbol, signal, price: latest, equity, cash, holdings });
    if (eval_.allow) {
      await executeOrder({
        symbol, side: 'BUY', qty: eval_.qty, price: latest,
        signal, stop_loss: eval_.stop_loss, take_profit: eval_.take_profit,
        reason: `${signal.reason} | risk $${eval_.riskUSD}`,
      });
    } else {
      await db.recordAudit({
        event_type: 'TRADE_REJECTED', symbol, decision: 'BUY',
        confidence: signal.confidence,
        payload: { reason: eval_.reason },
      });
    }
  } else if (signal.consensus === 'SELL') {
    const eval_ = await riskManager.evaluateSell({ symbol, signal, holdings });
    if (eval_.allow) {
      await executeOrder({
        symbol, side: 'SELL', qty: eval_.qty, price: latest,
        signal, reason: signal.reason,
      });
    } else {
      await db.recordAudit({
        event_type: 'TRADE_REJECTED', symbol, decision: 'SELL',
        confidence: signal.confidence,
        payload: { reason: eval_.reason },
      });
    }
  }

  return signal;
}

function minutesUntilClose(clock) {
  if (!clock?.is_open || !clock.next_close) return Infinity;
  const now = new Date(clock.timestamp || Date.now());
  const close = new Date(clock.next_close);
  return Math.max(0, (close - now) / 60000);
}

async function runCycle() {
  if (cycleInProgress) {
    console.log('[Agent] Cycle already in progress, skipping');
    return;
  }
  cycleInProgress = true;
  memoryState.lastRun = new Date().toISOString();
  memoryState.cycleCount++;

  try {
    const portfolio = await db.getPortfolio();
    if (portfolio.emergency_pause) {
      console.log('[Agent] Emergency pause — cycle skipped');
      return;
    }
    if (!portfolio.agent_running) return;

    const clock = await alpacaService.getClock();
    memoryState.marketOpen = clock.is_open;
    memoryState.nextOpen = clock.next_open;
    memoryState.nextClose = clock.next_close;

    if (!clock.is_open) {
      console.log(`[Agent] Market closed — cycle skipped (next open: ${clock.next_open})`);
      return;
    }

    const minsLeft = minutesUntilClose(clock);
    if (minsLeft <= FORCE_FLATTEN_MINUTES_BEFORE_CLOSE) {
      console.log(`[Agent] ${minsLeft.toFixed(1)}m to close — flattening, no new entries`);
      await flattenAllPositions(`Auto-flatten ${FORCE_FLATTEN_MINUTES_BEFORE_CLOSE}m before close`);
      return;
    }

    const holdings = await db.getHoldings();
    const priceMap = await buildPriceLookup(holdings);
    const { equity } = await riskManager.computeEquity(holdings, priceMap.lookup);

    const cb = await riskManager.checkCircuitBreaker(equity);
    if (cb.tripped) {
      console.log(`[Agent] Circuit breaker active — ${cb.reason || 'tripped'}`);
      await discordService.sendCircuitBreakerAlert(cb.reason || `Drawdown ${(cb.drawdown * 100).toFixed(2)}%`);
      await flattenAllPositions(cb.reason || 'Circuit breaker tripped');
      return;
    }

    await evaluateExistingPositions(priceMap, holdings, equity);

    for (const symbol of WATCHLIST) {
      try {
        const liveHoldings = await db.getHoldings();
        const live = await riskManager.computeEquity(liveHoldings, priceMap.lookup);
        const cb2 = await riskManager.checkCircuitBreaker(live.equity);
        if (cb2.tripped) {
          console.log(`[Agent] CB tripped mid-cycle — halting further entries`);
          break;
        }
        await analyzeAndTradeSymbol(symbol, portfolio, liveHoldings, live.equity, live.cash);
      } catch (e) {
        console.error(`[Agent] ${symbol} error:`, e.message);
      }
    }

    memoryState.lastError = null;
    console.log(`[Agent] Cycle ${memoryState.cycleCount} complete (${minsLeft.toFixed(0)}m to close)`);
  } catch (e) {
    memoryState.lastError = e.message;
    console.error('[Agent] Cycle error:', e);
    await db.recordAudit({ event_type: 'CYCLE_ERROR', payload: { error: e.message, stack: e.stack } });
  } finally {
    cycleInProgress = false;
  }
}

async function startAgent() {
  await db.updatePortfolio({ agent_running: true });
  await db.recordAudit({ event_type: 'AGENT_STARTED', payload: { mode: TRADING_MODE, strategy: STRATEGY, intervalSeconds: INTERVAL_SECONDS } });
  if (!intervalHandle) {
    intervalHandle = setInterval(runCycle, INTERVAL_SECONDS * 1000);
  }
  console.log(`[Agent] Started — ${STRATEGY}, ${INTERVAL_SECONDS}s interval, mode ${TRADING_MODE}`);
  runCycle();
}

async function stopAgent() {
  await db.updatePortfolio({ agent_running: false });
  await db.recordAudit({ event_type: 'AGENT_STOPPED' });
  console.log('[Agent] Stopped');
}

async function emergencyPause(pause = true) {
  await db.updatePortfolio({ emergency_pause: pause, agent_running: pause ? false : (await db.getPortfolio()).agent_running });
  await db.recordAudit({ event_type: pause ? 'EMERGENCY_PAUSE' : 'EMERGENCY_RESUME' });
  if (pause) await discordService.sendCircuitBreakerAlert('Emergency pause activated by operator');
}

async function resetCircuitBreaker() {
  const holdings = await db.getHoldings();
  const priceMap = await buildPriceLookup(holdings);
  const { equity } = await riskManager.computeEquity(holdings, priceMap.lookup);
  await db.updatePortfolio({
    circuit_breaker: false,
    day_start_equity: equity.toFixed(2),
  });
  await db.recordAudit({ event_type: 'CIRCUIT_BREAKER_RESET', payload: { newDayStart: equity } });
}

async function dailyReset() {
  const holdings = await db.getHoldings();
  const priceMap = await buildPriceLookup(holdings);
  const { equity } = await riskManager.computeEquity(holdings, priceMap.lookup);
  await db.updatePortfolio({ day_start_equity: equity.toFixed(2), circuit_breaker: false });
  await db.recordAudit({ event_type: 'DAILY_RESET', payload: { dayStartEquity: equity } });
  console.log(`[Agent] Daily reset — new day-start equity: $${equity.toFixed(2)}`);
}

function scheduleDailyReset() {
  if (dailyResetHandle) clearTimeout(dailyResetHandle);
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(13, 30, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const ms = next - now;
  dailyResetHandle = setTimeout(async () => {
    await dailyReset();
    scheduleDailyReset();
  }, ms);
}

async function getAgentSnapshot() {
  const portfolio = await db.getPortfolio();
  const holdings = await db.getHoldings();
  const priceMap = await buildPriceLookup(holdings);
  const lookup = priceMap.lookup;
  const { equity } = holdings.length ? await riskManager.computeEquity(holdings, lookup) : { equity: parseFloat(portfolio.cash_balance) };
  const dayStart = parseFloat(portfolio.day_start_equity);
  const dailyPnL = equity - dayStart;
  const totalPnL = equity - parseFloat(portfolio.starting_balance);
  const dailyLossUSD = Math.max(0, -dailyPnL);

  return {
    mode: TRADING_MODE,
    strategy: STRATEGY,
    running: portfolio.agent_running,
    emergencyPause: portfolio.emergency_pause,
    circuitBreakerTripped: portfolio.circuit_breaker,
    cash: parseFloat(portfolio.cash_balance),
    equity,
    dayStartEquity: dayStart,
    startingBalance: parseFloat(portfolio.starting_balance),
    dailyPnL,
    totalPnL,
    dailyPnLPct: dayStart ? (dailyPnL / dayStart * 100) : 0,
    dailyLossUSD,
    market: {
      open: memoryState.marketOpen,
      nextOpen: memoryState.nextOpen,
      nextClose: memoryState.nextClose,
    },
    holdings: holdings.map(h => ({
      symbol: h.symbol,
      qty: parseFloat(h.qty),
      avgCost: parseFloat(h.avg_cost),
      currentPrice: lookup[h.symbol] || parseFloat(h.avg_cost),
      stopLoss: h.stop_loss ? parseFloat(h.stop_loss) : null,
      takeProfit: h.take_profit ? parseFloat(h.take_profit) : null,
      marketValue: parseFloat(h.qty) * (lookup[h.symbol] || parseFloat(h.avg_cost)),
      unrealizedPnL: (lookup[h.symbol] - parseFloat(h.avg_cost)) * parseFloat(h.qty),
    })),
    signals: memoryState.lastSignals,
    lastRun: memoryState.lastRun,
    lastFlatten: memoryState.lastFlatten,
    cycleCount: memoryState.cycleCount,
    lastError: memoryState.lastError,
    risk: riskManager.getConfig(),
    providers: llmService.getProviderStatus(),
    watchlist: WATCHLIST,
    intervalSeconds: INTERVAL_SECONDS,
    barTimeframe: BAR_TIMEFRAME,
    forceFlattenMinutesBeforeClose: FORCE_FLATTEN_MINUTES_BEFORE_CLOSE,
  };
}

scheduleDailyReset();

(async () => {
  try {
    const portfolio = await db.getPortfolio();
    if (portfolio.agent_running && !intervalHandle) {
      console.log('[Agent] Auto-resuming from previous session');
      intervalHandle = setInterval(runCycle, INTERVAL_SECONDS * 1000);
      runCycle();
    }
  } catch (e) {
    console.error('[Agent] Auto-resume check failed:', e.message);
  }
})();

module.exports = {
  startAgent, stopAgent, runCycle, getAgentSnapshot,
  emergencyPause, resetCircuitBreaker, flattenAllPositions, WATCHLIST,
};
