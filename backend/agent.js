require('dotenv').config();
const llmService = require('./services/llmService');
const alpacaService = require('./services/alpacaService');
const discordService = require('./services/discordService');
const riskManager = require('./services/riskManager');
const db = require('./services/db');
const { STRATEGIES, listStrategies, getStrategy } = require('./strategies');

const WATCHLIST = (process.env.WATCHLIST || 'AAPL,NVDA,TSLA,MSFT,AMZN,META,GOOGL,SPY')
  .split(',').map(s => s.trim()).filter(Boolean);
const BASE_INTERVAL_SECONDS = Math.max(30, parseInt(process.env.AGENT_INTERVAL_SECONDS || '60'));
const FORCE_FLATTEN_MINUTES_BEFORE_CLOSE = parseInt(process.env.FORCE_FLATTEN_MINUTES_BEFORE_CLOSE || '5');

const memoryState = {
  lastRun: null,
  lastSignals: {},
  lastError: null,
  startTime: Date.now(),
  cycleCount: 0,
  marketOpen: false,
  nextOpen: null,
  nextClose: null,
  lastFlatten: null,
  strategyLastRun: {},
  strategyCycles: {},
};

let intervalHandle = null;
let dailyResetHandle = null;
let cycleInProgress = false;
let flattenInProgress = false;
let tradingLock = false; // global lock — flatten / mode-switch / cycle cannot overlap

async function withTradingLock(label, fn) {
  const start = Date.now();
  while (tradingLock) {
    if (Date.now() - start > 30000) throw new Error(`Trading lock timeout while waiting for ${label}`);
    await new Promise(r => setTimeout(r, 100));
  }
  tradingLock = true;
  try { return await fn(); }
  finally { tradingLock = false; }
}

async function buildPriceLookup(holdings) {
  const lookup = {};
  const stale = {};
  await Promise.all(holdings.map(async h => {
    const bars = await alpacaService.getBars(h.symbol, '1Min', 1);
    if (bars.length) lookup[h.symbol] = bars[bars.length - 1].c;
    else { lookup[h.symbol] = parseFloat(h.avg_cost); stale[h.symbol] = true; }
  }));
  return { lookup, stale };
}

async function executeOrder({ symbol, side, qty, price, signal, stop_loss, take_profit, reason, strategy }) {
  let order = { id: `mock-${Date.now()}`, status: 'mock_filled' };
  try {
    if (alpacaService.isConfigured()) {
      order = await alpacaService.placeOrder({ symbol, qty, side: side.toLowerCase() });
    }
  } catch (e) {
    await db.recordTrade({
      symbol, side, qty, price, confidence: signal?.confidence,
      consensus: signal?.consensus, status: 'error',
      reason: `Order failed: ${e.message}`, strategy,
    });
    await db.recordAudit({ event_type: 'TRADE_ERROR', symbol, decision: side, payload: { error: e.message, qty, price, strategy } });
    return null;
  }

  const cost = qty * price;
  let pnl = null;

  if (side === 'BUY') {
    await db.adjustCash(-cost);
    await db.upsertHolding({ symbol, strategy, qty, avg_cost: price, stop_loss, take_profit });
  } else {
    const existing = await db.getHolding(symbol, strategy);
    if (existing) {
      pnl = (price - parseFloat(existing.avg_cost)) * qty;
      await db.deleteHolding(symbol, strategy);
    }
    await db.adjustCash(cost);
  }

  const trade = await db.recordTrade({
    symbol, side, qty, price,
    confidence: signal?.confidence, consensus: signal?.consensus,
    order_id: order.id, status: order.status || 'submitted',
    pnl, reason, strategy,
  });

  await db.recordAudit({
    event_type: 'TRADE_EXECUTED', symbol, decision: side,
    confidence: signal?.confidence, models: signal?.models,
    payload: { qty, price, stop_loss, take_profit, pnl, reason, strategy },
  });

  await discordService.sendTradeAlert({
    symbol, action: side, qty, price: price.toFixed(2),
    confidence: signal?.confidence || 1, reason: `[${strategy}] ${reason}`,
  });

  return trade;
}

async function evaluateExistingPositions(strategyHoldings, lookup, stale) {
  for (const h of strategyHoldings) {
    const price = lookup[h.symbol];
    if (!price || stale[h.symbol]) continue;
    const trigger = await riskManager.evaluateStops({ symbol: h.symbol, currentPrice: price, holding: h });
    if (trigger) {
      await db.recordAudit({ event_type: trigger.trigger, symbol: h.symbol, decision: 'SELL',
        payload: { price, ...trigger, strategy: h.strategy } });
      await executeOrder({
        symbol: h.symbol, side: 'SELL', qty: parseFloat(h.qty), price,
        signal: { consensus: 'SELL', confidence: 1.0, models: [] },
        reason: trigger.reason, strategy: h.strategy,
      });
    }
  }
}

async function flattenStrategyPositions(strategyName, reason) {
  const holdings = await db.getHoldings(strategyName);
  if (!holdings.length) return { closed: 0 };
  const priceMap = await buildPriceLookup(holdings);
  let closed = 0;
  for (const h of holdings) {
    const price = priceMap.lookup[h.symbol] || parseFloat(h.avg_cost);
    const qty = parseFloat(h.qty);
    try {
      if (alpacaService.isConfigured()) {
        await alpacaService.placeOrder({ symbol: h.symbol, qty, side: 'sell' });
      }
    } catch (e) {
      console.error(`[Agent] flatten ${h.symbol} order failed:`, e.message);
      continue;
    }
    const pnl = (price - parseFloat(h.avg_cost)) * qty;
    await db.adjustCash(qty * price);
    await db.deleteHolding(h.symbol, strategyName);
    await db.recordTrade({
      symbol: h.symbol, side: 'SELL', qty, price,
      confidence: 1.0, consensus: 'SELL',
      order_id: `flatten-${Date.now()}`, status: 'flattened',
      pnl, reason, strategy: strategyName,
    });
    await db.recordAudit({ event_type: 'FORCE_FLATTEN', symbol: h.symbol, decision: 'SELL',
      payload: { qty, price, pnl, reason, strategy: strategyName } });
    closed++;
  }
  return { closed };
}

async function flattenAllPositions(reason = 'Manual flatten') {
  if (flattenInProgress) return;
  // Wait for any active cycle to finish before flattening
  const waitStart = Date.now();
  while (cycleInProgress && Date.now() - waitStart < 30000) {
    await new Promise(r => setTimeout(r, 200));
  }
  flattenInProgress = true;
  tradingLock = true;
  try {
    const holdings = await db.getHoldings();
    if (!holdings.length) return;
    console.log(`[Agent] Flattening ALL ${holdings.length} positions — ${reason}`);
    await db.recordAudit({ event_type: 'FORCE_FLATTEN_START', payload: { reason, count: holdings.length } });

    if (alpacaService.isConfigured()) {
      try {
        await alpacaService.closeAllPositions();
        await new Promise(r => setTimeout(r, 1500));
        const remaining = await alpacaService.getPositions();
        if (remaining.length > 0) {
          await db.recordAudit({ event_type: 'FORCE_FLATTEN_BROKER_FAIL',
            payload: { reason, remaining: remaining.map(p => p.symbol) } });
          await discordService.sendCircuitBreakerAlert(
            `⚠ FLATTEN INCOMPLETE — broker still holds: ${remaining.map(p => p.symbol).join(', ')}. Local state NOT cleared.`
          );
          return;
        }
      } catch (e) {
        await db.recordAudit({ event_type: 'FORCE_FLATTEN_BROKER_FAIL', payload: { reason, error: e.message } });
        await discordService.sendCircuitBreakerAlert(`⚠ FLATTEN ERROR — ${e.message}.`);
        return;
      }
    }

    const priceMap = await buildPriceLookup(holdings);
    for (const h of holdings) {
      const price = priceMap.lookup[h.symbol] || parseFloat(h.avg_cost);
      const qty = parseFloat(h.qty);
      const pnl = (price - parseFloat(h.avg_cost)) * qty;
      await db.adjustCash(qty * price);
      await db.deleteHolding(h.symbol, h.strategy);
      await db.recordTrade({
        symbol: h.symbol, side: 'SELL', qty, price,
        confidence: 1.0, consensus: 'SELL',
        order_id: `flatten-${Date.now()}`, status: 'flattened',
        pnl, reason, strategy: h.strategy,
      });
      await db.recordAudit({ event_type: 'FORCE_FLATTEN', symbol: h.symbol, decision: 'SELL',
        payload: { qty, price, pnl, reason, strategy: h.strategy } });
    }
    memoryState.lastFlatten = new Date().toISOString();
    await discordService.sendCircuitBreakerAlert(`Flatten complete — ${holdings.length} positions closed`);
  } catch (e) {
    console.error('[Agent] flatten error:', e.message);
  } finally {
    flattenInProgress = false;
    tradingLock = false;
  }
}

async function analyzeAndTradeSymbol(symbol, portfolio, holdings, equity, cash, strategyConfig) {
  const sc = strategyConfig;
  const bars = await alpacaService.getBars(symbol, sc.timeframe, sc.lookback);
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
    timeframe: sc.timeframe,
    strategy: sc.name === 'day' ? 'intraday day-trading' : 'multi-day swing-trading',
  };

  const holding = holdings.find(h => h.symbol === symbol) || null;
  const signal = await llmService.getEnsembleDecision({ symbol, priceData, sentiment, holding, portfolio });

  await db.recordAudit({
    event_type: 'SIGNAL', symbol, decision: signal.consensus, confidence: signal.confidence,
    models: signal.models,
    payload: { priceData, sentiment, votes: signal.votes, reason: signal.reason, strategy: sc.name },
  });

  memoryState.lastSignals[`${sc.name}:${symbol}`] = {
    symbol, strategy: sc.name, timestamp: new Date().toISOString(),
    price: latest, change: `${change}%`,
    signal: signal.consensus, confidence: signal.confidence,
    votes: signal.votes, models: signal.models, reason: signal.reason,
  };

  if (signal.consensus === 'BUY') {
    const eval_ = await riskManager.evaluateBuy({ symbol, signal, price: latest, equity, cash, holdings, strategyConfig: sc });
    if (eval_.allow) {
      await executeOrder({
        symbol, side: 'BUY', qty: eval_.qty, price: latest,
        signal, stop_loss: eval_.stop_loss, take_profit: eval_.take_profit,
        reason: `${signal.reason} | risk $${eval_.riskUSD}`,
        strategy: sc.name,
      });
    } else {
      await db.recordAudit({ event_type: 'TRADE_REJECTED', symbol, decision: 'BUY',
        confidence: signal.confidence, payload: { reason: eval_.reason, strategy: sc.name } });
    }
  } else if (signal.consensus === 'SELL') {
    const eval_ = await riskManager.evaluateSell({ symbol, signal, holdings, strategyConfig: sc });
    if (eval_.allow) {
      await executeOrder({
        symbol, side: 'SELL', qty: eval_.qty, price: latest,
        signal, reason: signal.reason, strategy: sc.name,
      });
    } else {
      await db.recordAudit({ event_type: 'TRADE_REJECTED', symbol, decision: 'SELL',
        confidence: signal.confidence, payload: { reason: eval_.reason, strategy: sc.name } });
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

async function runStrategy(sc, portfolio, clock, fullPriceLookup) {
  const minsLeft = minutesUntilClose(clock);
  if (sc.forceFlattenBeforeClose && minsLeft <= FORCE_FLATTEN_MINUTES_BEFORE_CLOSE) {
    console.log(`[${sc.name}] ${minsLeft.toFixed(1)}m to close — flattening day positions`);
    await flattenStrategyPositions(sc.name, `Auto-flatten ${FORCE_FLATTEN_MINUTES_BEFORE_CLOSE}m before close`);
    return;
  }

  const stratHoldings = await db.getHoldings(sc.name);
  await evaluateExistingPositions(stratHoldings, fullPriceLookup, {});

  for (const symbol of WATCHLIST) {
    try {
      const sh = await db.getHoldings(sc.name);
      const allH = await db.getHoldings();
      // Mark-to-market full equity using the FULL lookup covering both strategies
      const live = await riskManager.computeEquity(allH, fullPriceLookup);
      const cb2 = await riskManager.checkCircuitBreaker(live.equity);
      if (cb2.tripped) {
        console.log(`[${sc.name}] CB tripped mid-cycle — halting and flattening all`);
        await flattenAllPositions(cb2.reason || 'Circuit breaker tripped mid-cycle');
        break;
      }
      await analyzeAndTradeSymbol(symbol, portfolio, sh, live.equity, live.cash, sc);
    } catch (e) {
      console.error(`[${sc.name}] ${symbol} error:`, e.message);
    }
  }

  memoryState.strategyLastRun[sc.name] = new Date().toISOString();
  memoryState.strategyCycles[sc.name] = (memoryState.strategyCycles[sc.name] || 0) + 1;
}

async function runCycle() {
  if (cycleInProgress || tradingLock) { console.log('[Agent] Cycle/flatten in progress, skipping'); return; }
  cycleInProgress = true;
  tradingLock = true;
  memoryState.lastRun = new Date().toISOString();
  memoryState.cycleCount++;

  try {
    const portfolio = await db.getPortfolio();
    if (portfolio.emergency_pause) { console.log('[Agent] Emergency pause — skipped'); return; }
    if (!portfolio.agent_running) return;

    // Sync alpaca mode with DB
    if (alpacaService.mode !== portfolio.trading_mode) alpacaService.setMode(portfolio.trading_mode);

    const clock = await alpacaService.getClock();
    memoryState.marketOpen = clock.is_open;
    memoryState.nextOpen = clock.next_open;
    memoryState.nextClose = clock.next_close;

    if (!clock.is_open) {
      console.log(`[Agent] Market closed — next open: ${clock.next_open}`);
      return;
    }

    const allH = await db.getHoldings();
    const pmap = await buildPriceLookup(allH);
    const { equity } = await riskManager.computeEquity(allH, pmap.lookup);
    const cb = await riskManager.checkCircuitBreaker(equity);
    if (cb.tripped) {
      console.log(`[Agent] CB active — ${cb.reason || 'tripped'}`);
      await discordService.sendCircuitBreakerAlert(cb.reason || `Drawdown ${(cb.drawdown * 100).toFixed(2)}%`);
      await flattenAllPositions(cb.reason || 'Circuit breaker tripped');
      return;
    }

    // Build a unified price lookup covering all open holdings + watchlist symbols
    // so cross-strategy equity is correctly mark-to-market everywhere
    const symbolsToPrice = new Set([...allH.map(h => h.symbol), ...WATCHLIST]);
    const fullLookup = { ...pmap.lookup };
    await Promise.all([...symbolsToPrice].filter(s => fullLookup[s] === undefined).map(async sym => {
      const bars = await alpacaService.getBars(sym, '1Min', 1);
      if (bars.length) fullLookup[sym] = bars[bars.length - 1].c;
    }));

    // Run each enabled strategy according to its own cadence
    const strategies = [
      { sc: STRATEGIES.day, enabled: portfolio.day_enabled },
      { sc: STRATEGIES.swing, enabled: portfolio.swing_enabled },
    ];
    for (const { sc, enabled } of strategies) {
      if (!enabled) continue;
      const lastRun = memoryState.strategyLastRun[sc.name];
      const elapsed = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 1000 : Infinity;
      if (elapsed < sc.intervalSeconds - 5) continue;
      await runStrategy(sc, portfolio, clock, fullLookup);
    }

    memoryState.lastError = null;
    console.log(`[Agent] Cycle ${memoryState.cycleCount} complete`);
  } catch (e) {
    memoryState.lastError = e.message;
    console.error('[Agent] Cycle error:', e);
    await db.recordAudit({ event_type: 'CYCLE_ERROR', payload: { error: e.message, stack: e.stack } });
  } finally {
    cycleInProgress = false;
    tradingLock = false;
  }
}

async function startAgent() {
  await db.updatePortfolio({ agent_running: true });
  await db.recordAudit({ event_type: 'AGENT_STARTED', payload: { intervalSeconds: BASE_INTERVAL_SECONDS } });
  if (!intervalHandle) intervalHandle = setInterval(runCycle, BASE_INTERVAL_SECONDS * 1000);
  console.log(`[Agent] Started — base interval ${BASE_INTERVAL_SECONDS}s`);
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
  await db.updatePortfolio({ circuit_breaker: false, day_start_equity: equity.toFixed(2) });
  await db.recordAudit({ event_type: 'CIRCUIT_BREAKER_RESET', payload: { newDayStart: equity } });
}

async function setStrategyEnabled(strategyName, enabled) {
  const field = strategyName === 'day' ? 'day_enabled' : strategyName === 'swing' ? 'swing_enabled' : null;
  if (!field) throw new Error(`Unknown strategy: ${strategyName}`);
  await db.updatePortfolio({ [field]: !!enabled });
  await db.recordAudit({ event_type: 'STRATEGY_TOGGLE', payload: { strategy: strategyName, enabled: !!enabled } });
}

async function setTradingMode(mode) {
  if (mode !== 'paper' && mode !== 'live') throw new Error('mode must be paper or live');
  if (mode === 'live' && !alpacaService.hasLiveCredentials()) {
    throw new Error('Live mode requires ALPACA_LIVE_API_KEY and ALPACA_LIVE_SECRET_KEY in secrets');
  }
  // Wait for any in-flight cycle so we never partial-execute orders across modes
  const waitStart = Date.now();
  while ((cycleInProgress || flattenInProgress) && Date.now() - waitStart < 30000) {
    await new Promise(r => setTimeout(r, 200));
  }
  await db.updatePortfolio({ trading_mode: mode });
  alpacaService.setMode(mode);
  await db.recordAudit({ event_type: 'TRADING_MODE_CHANGED', payload: { mode } });
  await discordService.sendCircuitBreakerAlert(`Trading mode switched to ${mode.toUpperCase()}`);
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
  dailyResetHandle = setTimeout(async () => { await dailyReset(); scheduleDailyReset(); }, next - now);
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
  const tradingMode = portfolio.trading_mode || 'paper';
  if (alpacaService.mode !== tradingMode) alpacaService.setMode(tradingMode);

  const strategies = listStrategies().map(s => ({
    ...s,
    enabled: s.name === 'day' ? !!portfolio.day_enabled : !!portfolio.swing_enabled,
    holdings: holdings.filter(h => h.strategy === s.name).length,
    lastRun: memoryState.strategyLastRun[s.name] || null,
    cycles: memoryState.strategyCycles[s.name] || 0,
  }));

  return {
    mode: tradingMode,
    liveAvailable: alpacaService.hasLiveCredentials(),
    running: portfolio.agent_running,
    emergencyPause: portfolio.emergency_pause,
    circuitBreakerTripped: portfolio.circuit_breaker,
    cash: parseFloat(portfolio.cash_balance),
    equity,
    dayStartEquity: dayStart,
    startingBalance: parseFloat(portfolio.starting_balance),
    dailyPnL, totalPnL,
    dailyPnLPct: dayStart ? (dailyPnL / dayStart * 100) : 0,
    dailyLossUSD,
    market: { open: memoryState.marketOpen, nextOpen: memoryState.nextOpen, nextClose: memoryState.nextClose },
    holdings: holdings.map(h => ({
      symbol: h.symbol, strategy: h.strategy,
      qty: parseFloat(h.qty), avgCost: parseFloat(h.avg_cost),
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
    strategies,
    providers: llmService.getProviderStatus(),
    watchlist: WATCHLIST,
    intervalSeconds: BASE_INTERVAL_SECONDS,
    forceFlattenMinutesBeforeClose: FORCE_FLATTEN_MINUTES_BEFORE_CLOSE,
  };
}

scheduleDailyReset();

(async () => {
  try {
    await db.ensureSchema();
    const portfolio = await db.getPortfolio();
    if (portfolio?.trading_mode) alpacaService.setMode(portfolio.trading_mode);
    if (portfolio.agent_running && !intervalHandle) {
      console.log('[Agent] Auto-resuming from previous session');
      intervalHandle = setInterval(runCycle, BASE_INTERVAL_SECONDS * 1000);
      runCycle();
    }
  } catch (e) {
    console.error('[Agent] Startup check failed:', e.message);
  }
})();

module.exports = {
  startAgent, stopAgent, runCycle, getAgentSnapshot,
  emergencyPause, resetCircuitBreaker, flattenAllPositions,
  setStrategyEnabled, setTradingMode, WATCHLIST,
};
