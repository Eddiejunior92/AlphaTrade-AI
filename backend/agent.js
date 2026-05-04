require('dotenv').config();
const llmService = require('./services/llmService');
const premarketService = require('./services/premarketService');
const alpacaService = require('./services/alpacaService');
const discordService = require('./services/discordService');
const riskManager = require('./services/riskManager');
const sentimentService = require('./services/sentimentService');
const fundamentalsService = require('./services/fundamentalsService');
const patternService = require('./services/patternService');
const indicatorsService = require('./services/indicatorsService');
const intradayService = require('./services/intradayService');
const historicalIntel = require('./services/historicalIntelligenceService');
const adaptiveLearning = require('./services/adaptiveLearningService');
const portfolioOpt = require('./services/portfolioOptimizationService');
const hedgingService = require('./services/hedgingService');
const orderFlowService = require('./services/orderFlowService');
const optionsActivityService = require('./services/optionsActivityService');
const db = require('./services/db');
const { STRATEGIES, listStrategies, getStrategy, applyRiskScale, getRiskScale, listRiskScales, DEFAULT_RISK_SCALE, getWatchlist } = require('./strategies');

const WATCHLIST = getWatchlist();
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
  lastDynamic: null,
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

  // REAL-TIME adaptive learning — every closed trade with realized P&L feeds
  // immediately into the rolling-window stats so the next LLM cycle (and the
  // next BUY's sizing multiplier) already reflects this outcome. Fire-and-
  // forget; recordOutcome swallows errors internally so it can never block.
  if (side === 'SELL' && pnl !== null && Number.isFinite(pnl)) {
    adaptiveLearning.recordOutcome({ symbol, strategy, pnl, closedAt: new Date() })
      .catch(() => {});
  }

  return trade;
}

async function evaluateExistingPositions(strategyHoldings, lookup, stale, strategyConfig) {
  for (const h of strategyHoldings) {
    const price = lookup[h.symbol];
    if (!price || stale[h.symbol]) continue;

    // Ratchet trailing stop BEFORE evaluating the (possibly updated) stop.
    if (strategyConfig?.trailingStopPct) {
      const update = riskManager.computeTrailingUpdate({ holding: h, currentPrice: price, strategyConfig });
      if (update) {
        await db.updateTrailing(h.symbol, h.strategy, update);
        if (update.stop_loss) {
          h.stop_loss = update.stop_loss;
          await db.recordAudit({
            event_type: 'TRAILING_STOP_RATCHET', symbol: h.symbol, decision: 'HOLD',
            payload: { strategy: h.strategy, newStop: update.stop_loss, peak: update.highest_price ?? h.highest_price, currentPrice: price },
          });
        }
        if (update.trailing_armed) h.trailing_armed = true;
        if (update.highest_price) h.highest_price = update.highest_price;
      }
    }

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
    adaptiveLearning.recordOutcome({ symbol: h.symbol, strategy: strategyName, pnl, closedAt: new Date() })
      .catch(() => {});
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
      adaptiveLearning.recordOutcome({ symbol: h.symbol, strategy: h.strategy, pnl, closedAt: new Date() })
        .catch(() => {});
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

async function analyzeAndTradeSymbol(symbol, portfolio, holdings, equity, cash, strategyConfig, dynamic) {
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
  // Pull cached news sentiment (refreshed once per cycle in runCycle).
  const newsSentiment = sentimentService.getCached(symbol);

  // Technical indicators (RSI / MACD / volume / volatility) — pure JS,
  // computed from the same bars. Used by BOTH day and swing strategies.
  let indicators = null;
  try { indicators = indicatorsService.computeIndicators(bars); }
  catch (e) { indicators = { ok: false, reason: e.message }; }

  // Pattern recognition — used by BOTH strategies now.
  // For day strategy on 1Min bars with lookback=60, this gives us higher-highs/
  // higher-lows, support/resistance clusters, breakout state etc. over the last
  // ~60 minutes — exactly the intraday structure window we want.
  let patterns = null;
  try { patterns = patternService.analyzePatterns(bars); }
  catch (e) { patterns = { ok: false, reason: e.message }; }

  // Fundamentals — swing only (intraday doesn't react to quarterly fundamentals)
  let fundamentals = null;
  if (sc.name === 'swing') {
    fundamentals = fundamentalsService.getCached(symbol);
  }

  // Intraday tactical setups — day strategy only.
  // Looks at the last 30–60 1-min bars for dip-buy and profit-take patterns.
  // Purely informational; quorum + confidence gate are unchanged.
  let intraday = null;
  if (sc.name === 'day') {
    try { intraday = intradayService.analyzeIntraday(bars, indicators, patterns, holding); }
    catch (e) { intraday = { ok: false, reason: e.message }; }
  }

  // 20-year historical intelligence (cached daily). Both strategies receive it.
  // Day strategy gets an "early-session" emphasis flag during the first 90
  // minutes after open, when intraday data is still thin.
  let historical = null;
  try {
    const minSinceOpen = minutesSinceOpenET();
    const earlySession = sc.name === 'day' && minSinceOpen != null && minSinceOpen >= 0 && minSinceOpen <= 90;
    historical = await historicalIntel.getInsightsForPrompt(symbol, { withinFirst90Min: earlySession });
  } catch (e) {
    console.error(`[Agent] historicalIntel render error for ${symbol}:`, e.message);
  }

  // Pre-market briefing context — only present during first 60 min after open.
  // Returns null otherwise; LLM prompt is unchanged. Never throws.
  const premarket = await premarketService.getActiveBriefingContext(symbol, {
    open: memoryState.marketOpen,
    nextClose: memoryState.nextClose,
  });

  // ---- Upgrade context (informational + sizing inputs) -------------------
  // All four are best-effort; failure → null/no-op, never blocks a decision.
  let adaptiveHints = null;
  try { adaptiveHints = await adaptiveLearning.getCalibrationHints(symbol, sc.name); } catch (_) {}

  let portfolioRiskBlock = null;
  let portfolioMult = 1.0;
  try {
    const allH = await db.getHoldings();
    if (allH.length) {
      const r = await portfolioOpt.evaluateAddition({ candidate: symbol, holdings: allH });
      portfolioMult = r.sizeMult;
      portfolioRiskBlock = await portfolioOpt.getPromptBlock({ candidate: symbol, holdings: allH });
    }
  } catch (_) {}

  let adaptiveMult = 1.0;
  try { adaptiveMult = await adaptiveLearning.getSizingMultiplier(symbol, sc.name); } catch (_) {}

  let orderFlow = null;
  try { orderFlow = orderFlowService.analyzeOrderFlow(bars); } catch (_) {}

  let optionsActivity = null;
  try {
    const opt = await optionsActivityService.getCached(symbol);
    if (opt) optionsActivity = optionsActivityService.renderForPrompt(opt);
  } catch (_) {}

  const signal = await llmService.getEnsembleDecision({
    symbol, priceData, sentiment, newsSentiment, holding, portfolio,
    patterns, fundamentals, indicators, intraday, historical,
    strategyName: sc.name, premarket,
    adaptiveHints, portfolioRisk: portfolioRiskBlock, orderFlow, optionsActivity,
  });

  await db.recordAudit({
    event_type: 'SIGNAL', symbol, decision: signal.consensus, confidence: signal.confidence,
    models: signal.models,
    payload: { priceData, sentiment, newsSentiment, indicators, patterns, fundamentals, intraday,
      historicalAvailable: !!historical,
      votes: signal.votes, reason: signal.reason, strategy: sc.name },
  });

  memoryState.lastSignals[`${sc.name}:${symbol}`] = {
    symbol, strategy: sc.name, timestamp: new Date().toISOString(),
    price: latest, change: `${change}%`,
    signal: signal.consensus, confidence: signal.confidence,
    votes: signal.votes, models: signal.models, reason: signal.reason,
    newsSentiment,
  };

  if (signal.consensus === 'BUY') {
    // Pass adaptive + portfolio multipliers through `dynamic` so riskManager
    // can apply them as pure SIZING modifiers (after quorum/gate). Existing
    // safety gates remain unchanged.
    const dynamicWithUpgrades = { ...(dynamic || {}), adaptiveMult, portfolioMult };
    const eval_ = await riskManager.evaluateBuy({ symbol, signal, price: latest, equity, cash, holdings, strategyConfig: sc, dynamic: dynamicWithUpgrades });
    if (eval_.allow) {
      const sz = eval_.sizing || {};
      await executeOrder({
        symbol, side: 'BUY', qty: eval_.qty, price: latest,
        signal, stop_loss: eval_.stop_loss, take_profit: eval_.take_profit,
        reason: `${signal.reason} | risk $${eval_.riskUSD}` +
          (sz.compoundMult ? ` (×${sz.compoundMult.toFixed(2)} growth·perf, ${(sz.confFraction*100).toFixed(0)}% conf-band)` : ''),
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

async function runStrategy(sc, portfolio, clock, fullPriceLookup, dynamic) {
  const minsLeft = minutesUntilClose(clock);
  if (sc.forceFlattenBeforeClose && minsLeft <= FORCE_FLATTEN_MINUTES_BEFORE_CLOSE) {
    console.log(`[${sc.name}] ${minsLeft.toFixed(1)}m to close — flattening day positions`);
    await flattenStrategyPositions(sc.name, `Auto-flatten ${FORCE_FLATTEN_MINUTES_BEFORE_CLOSE}m before close`);
    return;
  }

  const stratHoldings = await db.getHoldings(sc.name);
  await evaluateExistingPositions(stratHoldings, fullPriceLookup, {}, sc);

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
      await analyzeAndTradeSymbol(symbol, portfolio, sh, live.equity, live.cash, sc, dynamic);
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

    // Refresh news sentiment for the watchlist (cached, TTL-bounded — only
    // hits Grok when stale). Runs in parallel; a slow/failed sentiment call
    // never blocks trading because we use cached/default values downstream.
    sentimentService.getSentimentBatch(WATCHLIST, { concurrency: 4 })
      .catch(e => console.error('[Agent] Sentiment refresh error:', e.message));

    // Refresh swing-only fundamentals (Grok, 6h TTL). Skipped entirely if the
    // swing strategy is disabled. Background; cached/default values are used
    // downstream so a slow/failed call never blocks trading.
    if (portfolio.swing_enabled) {
      fundamentalsService.getFundamentalsBatch(WATCHLIST, { concurrency: 3 })
        .catch(e => console.error('[Agent] Fundamentals refresh error:', e.message));
    }

    // Apply the user's chosen risk scale to each strategy before running.
    // This dynamically adjusts confidence gate, $ risk per trade, and stop/target ratios.
    const scaleName = portfolio.risk_scale || DEFAULT_RISK_SCALE;

    // Compute dynamic compounding scaling for THIS cycle (account-growth + performance curve).
    // Confidence weighting is per-signal and added inside evaluateBuy.
    const recentClosed = await db.getRecentTrades(50);
    const dynamic = riskManager.computeDynamicScaling({
      equity,
      startingBalance: parseFloat(portfolio.starting_balance),
      recentClosedTrades: recentClosed,
    });
    memoryState.lastDynamic = dynamic;

    const strategies = [
      { sc: applyRiskScale(STRATEGIES.day, scaleName), enabled: portfolio.day_enabled },
      { sc: applyRiskScale(STRATEGIES.swing, scaleName), enabled: portfolio.swing_enabled },
    ];
    for (const { sc, enabled } of strategies) {
      if (!enabled) continue;
      const lastRun = memoryState.strategyLastRun[sc.name];
      const elapsed = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 1000 : Infinity;
      if (elapsed < sc.intervalSeconds - 5) continue;
      await runStrategy(sc, portfolio, clock, fullLookup, dynamic);
    }

    // Portfolio-level hedge check — informational by default. AUTO_HEDGE=true
    // arms an inverse-ETF hedge (SH) sized to 15% of long exposure on a risk
    // spike. Cooldown-protected; **NEVER auto-executes when circuit breaker
    // is tripped, emergency pause is on, or agent is stopped** — alert still
    // fires (advisory) but no order is placed.
    try {
      const allHForHedge = await db.getHoldings();
      if (allHForHedge.length >= 2) {
        const safeForAutoHedge = !portfolio.circuit_breaker
          && !portfolio.emergency_pause
          && portfolio.agent_running;
        const autoHedge = process.env.AUTO_HEDGE === 'true' && safeForAutoHedge;
        await hedgingService.evaluateAndAlert(allHForHedge, { autoHedge });
      }
    } catch (e) { console.error('[Hedge] Tick error:', e.message); }

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

async function setRiskScale(scaleName) {
  if (!getRiskScale(scaleName) || !['conservative', 'balanced', 'aggressive'].includes(scaleName)) {
    throw new Error('risk_scale must be conservative, balanced, or aggressive');
  }
  const prev = (await db.getPortfolio()).risk_scale || DEFAULT_RISK_SCALE;
  await db.updatePortfolio({ risk_scale: scaleName });
  const scale = getRiskScale(scaleName);
  await db.recordAudit({
    event_type: 'RISK_SCALE_CHANGED',
    payload: {
      from: prev, to: scaleName,
      confidenceThreshold: scale.confidenceThreshold,
      riskUSD: [scale.minRiskUSD, scale.maxRiskUSD],
      maxDailyLossUSD: scale.maxDailyLossUSD,
      stopMultiplier: scale.stopMultiplier,
      targetMultiplier: scale.targetMultiplier,
    },
  });
  console.log(`[Agent] Risk scale: ${prev} → ${scaleName}`);
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

// --- 20-year historical intelligence — daily refresh -------------------------
// Runs once per day at ~09:00 UTC (~04:00-05:00 ET, well before US open). On
// startup we kick off a non-blocking refresh that skips symbols already cached
// for today, so a restart never hammers the data API.
// Adaptive learning + options activity + hedge tick — lightweight schedulers.
// Adaptive recomputes nightly (after market close); options activity refreshes
// every 30 min during trading hours; hedge check runs once per cycle inside
// runStrategy via evaluateAndAlert (see runCycle below).
let adaptiveDailyHandle = null;
function scheduleAdaptiveRecompute() {
  if (adaptiveDailyHandle) clearTimeout(adaptiveDailyHandle);
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(22, 0, 0, 0); // ~17:00 ET, after market close
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  adaptiveDailyHandle = setTimeout(async () => {
    try {
      const r = await adaptiveLearning.recomputeFromHistory();
      console.log(`[Adaptive] Recompute: ${r.symbolBuckets} symbol buckets, ${r.modelBuckets} model buckets, ${r.sourceCloses} closes`);
    } catch (e) { console.error('[Adaptive] Recompute failed:', e.message); }
    scheduleAdaptiveRecompute();
  }, next - now);
}

let optionsActivityHandle = null;
function scheduleOptionsActivityRefresh() {
  if (optionsActivityHandle) clearInterval(optionsActivityHandle);
  optionsActivityHandle = setInterval(async () => {
    if (!memoryState.marketOpen) return;
    try { await optionsActivityService.refreshBatch(WATCHLIST); }
    catch (e) { console.error('[OptionsActivity] Batch refresh failed:', e.message); }
  }, 30 * 60 * 1000);
}

let intelDailyHandle = null;
function scheduleDailyIntelligence() {
  if (intelDailyHandle) clearTimeout(intelDailyHandle);
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(9, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  intelDailyHandle = setTimeout(async () => {
    try { await historicalIntel.runDailyIntelligence({}); }
    catch (e) { console.error('[Intel] Daily run failed:', e.message); }
    scheduleDailyIntelligence();
  }, next - now);
  console.log(`[Intel] Next daily run scheduled in ${Math.round((next - now) / 60000)} min`);
}

// Minutes since today's 9:30 AM ET. Returns a negative number before 9:30 ET,
// positive after; null only on parse failure. Caller (early-session flag) must
// also gate on market-open since this does not check trading day.
function minutesSinceOpenET() {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(now);
    const h = parseInt(parts.find(p => p.type === 'hour')?.value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute')?.value, 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return (h * 60 + m) - (9 * 60 + 30);
  } catch (_) { return null; }
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

  const scaleName = portfolio.risk_scale || DEFAULT_RISK_SCALE;
  const activeScale = getRiskScale(scaleName);

  // Dynamic compounding scaling — recompute on demand so the UI reflects the
  // current state even between cycles (e.g. after intraday MTM moves).
  const recentClosed = await db.getRecentTrades(50);
  const dynamic = riskManager.computeDynamicScaling({
    equity,
    startingBalance: parseFloat(portfolio.starting_balance),
    recentClosedTrades: recentClosed,
  });
  // Effective per-trade $ risk band after compounding multipliers (before
  // per-signal confidence weighting). UI shows this so users see how the band
  // shifts as the account grows or recent performance changes.
  const compound = dynamic.compoundMult;
  // Clamp displayed band to executable floor/ceiling so the UI never advertises
  // sizing the engine wouldn't actually take.
  const absCeiling = activeScale.maxRiskUSD * riskManager.tunables.ABS_RISK_CEILING_MULT;
  const absFloor = activeScale.minRiskUSD * 0.5;
  const effectiveBand = {
    minRiskUSD: +Math.max(absFloor, activeScale.minRiskUSD * compound).toFixed(2),
    maxRiskUSD: +Math.min(absCeiling, activeScale.maxRiskUSD * compound).toFixed(2),
    ceilingUSD: +absCeiling.toFixed(2),
    floorUSD: +absFloor.toFixed(2),
  };

  const strategies = listStrategies(scaleName).map(s => ({
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
    risk: riskManager.getConfig(portfolio),
    riskScale: {
      current: scaleName,
      ...activeScale,
      dynamic,
      effectiveBand,
    },
    riskScales: listRiskScales(),
    strategies,
    providers: llmService.getProviderStatus(),
    watchlist: WATCHLIST,
    sentiment: sentimentService.getAllCached(),
    intervalSeconds: BASE_INTERVAL_SECONDS,
    forceFlattenMinutesBeforeClose: FORCE_FLATTEN_MINUTES_BEFORE_CLOSE,
  };
}

scheduleDailyReset();
scheduleDailyIntelligence();
scheduleAdaptiveRecompute();
scheduleOptionsActivityRefresh();
// Warm adaptive cache + options activity once at startup so the first cycle
// has fresh context. Both are best-effort and never block boot.
adaptiveLearning.recomputeFromHistory()
  .then(r => console.log(`[Adaptive] Startup recompute: ${r.symbolBuckets} symbols, ${r.modelBuckets} models from ${r.sourceCloses} closes`))
  .catch(e => console.error('[Adaptive] Startup recompute failed:', e.message));
optionsActivityService.refreshBatch(WATCHLIST)
  .then(() => console.log(`[OptionsActivity] Startup batch refreshed for ${WATCHLIST.length} symbols`))
  .catch(e => console.error('[OptionsActivity] Startup refresh failed:', e.message));

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
    // Fire-and-forget: ensure today's intelligence cache is warm. Skips any
    // symbol already cached for today, so restarts don't re-hit the data API.
    historicalIntel.runDailyIntelligence({})
      .catch(e => console.error('[Intel] Startup warm-up failed:', e.message));
  } catch (e) {
    console.error('[Agent] Startup check failed:', e.message);
  }
})();

module.exports = {
  startAgent, stopAgent, runCycle, getAgentSnapshot,
  emergencyPause, resetCircuitBreaker, flattenAllPositions,
  setStrategyEnabled, setTradingMode, setRiskScale, WATCHLIST,
};
