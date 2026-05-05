require('dotenv').config();
const llmService = require('./services/llmService');
const premarketService = require('./services/premarketService');
const alpacaService = require('./services/alpacaService');
const ibkrService = require('./services/ibkrService');
const brokerRouter = require('./services/brokerRouter');
const marketRegistry = require('./services/marketRegistry');
const fxService = require('./services/fxService');
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
const earningsSignalService = require('./services/earningsSignalService');
const db = require('./services/db');
const { STRATEGIES, listStrategies, getStrategy, applyRiskScale, getRiskScale, listRiskScales, DEFAULT_RISK_SCALE, getWatchlist, getWatchlistForStrategy } = require('./strategies');

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
let killSwitchActive = false; // sticky abort flag — once set, no new orders can be placed
                              // until the process restarts. Survives mid-cycle in-flight work.

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

// Build BOTH a native-price lookup (for stop/take comparisons + broker logic
// — must match how the broker quotes the symbol) and a USD-equivalent
// lookup (for portfolio equity, circuit breaker, daily-loss budget — all
// of which are USD-denominated).
//
// For US holdings the two are identical. For ASX holdings the native price
// is in AUD and the USD-equivalent is `native * audUsdRate`. Each call
// fetches the FX rate once and reuses it across all ASX symbols in the
// batch to keep numbers internally consistent.
async function buildPriceLookup(holdings) {
  const lookup = {};      // native-currency prices (matches each symbol's quote)
  const usdLookup = {};   // USD-equivalent for equity / risk math
  const stale = {};
  const audUsd = await fxService.getAudToUsd();
  await Promise.all(holdings.map(async h => {
    const info = marketRegistry.getSymbolInfo(h.symbol);
    const bars = await brokerRouter.getBars(h.symbol, '1Min', 1);
    let native;
    if (bars.length) native = bars[bars.length - 1].c;
    else { native = parseFloat(h.avg_cost); stale[h.symbol] = true; }
    lookup[h.symbol] = native;
    usdLookup[h.symbol] = info.currency === 'AUD' ? native * audUsd : native;
  }));
  return { lookup, usdLookup, stale, audUsd };
}

// `price`, `stop_loss`, `take_profit` are NATIVE-currency (AUD for ASX,
// USD for US). `fxToUsd` is the AUD→USD rate captured at the moment of
// sizing (1.0 for US trades). All cash bookkeeping stays in USD — we
// abstract over the fact that an Alpaca USD account and an IBKR AUD
// account are physically separate by treating the portfolio as one
// USD-functional-currency book. Realized P&L is computed in native units
// then converted to USD using the close-time FX rate, which is the
// correct economic treatment (FX moves between entry and exit are part of
// the position's true return).
async function executeOrder({ symbol, side, qty, price, signal, stop_loss, take_profit,
                              reason, strategy, market, currency, fxToUsd }) {
  market   = market   || marketRegistry.getSymbolInfo(symbol).market;
  currency = currency || marketRegistry.getSymbolInfo(symbol).currency;
  fxToUsd  = Number.isFinite(fxToUsd) ? fxToUsd
            : (currency === 'AUD' ? await fxService.getAudToUsd() : 1.0);

  // Kill-switch hard guard — once tripped, NO new buy/sell orders may be placed
  // until the process restarts. brokerRouter.placeOrder also enforces this at
  // the broker sink, but we short-circuit here to avoid even constructing an
  // order request after kill.
  if (killSwitchActive) {
    console.log(`[Agent] Kill switch active — refused ${side} ${qty} ${symbol}`);
    await db.recordAudit({ event_type: 'KILL_SWITCH_BLOCKED_ORDER', symbol, decision: side,
      payload: { qty, price, strategy, market, reason: 'kill switch active' } });
    return null;
  }
  let order = { id: `mock-${Date.now()}`, status: 'mock_filled' };
  try {
    order = await brokerRouter.placeOrder({ symbol, qty, side: side.toLowerCase() });
  } catch (e) {
    await db.recordTrade({
      symbol, side, qty, price, confidence: signal?.confidence,
      consensus: signal?.consensus, status: 'error',
      reason: `Order failed: ${e.message}`, strategy,
      market, currency, fx_rate: fxToUsd,
    });
    await db.recordAudit({ event_type: 'TRADE_ERROR', symbol, decision: side,
      payload: { error: e.message, qty, price, strategy, market } });
    return null;
  }

  const nativeCost = qty * price;
  const usdCost = nativeCost * fxToUsd;
  let nativePnl = null;
  let usdPnl = null;

  if (side === 'BUY') {
    await db.adjustCash(-usdCost);
    await db.upsertHolding({
      symbol, strategy, qty, avg_cost: price, stop_loss, take_profit,
      market, currency, fx_rate_at_entry: fxToUsd,
    });
  } else {
    const existing = await db.getHolding(symbol, strategy);
    if (existing) {
      nativePnl = (price - parseFloat(existing.avg_cost)) * qty;
      // Convert native P&L to USD at CLOSE-time FX. This means FX drift
      // between entry and exit shows up in the realized USD return,
      // matching how a USD-functional-currency book actually reports.
      usdPnl = nativePnl * fxToUsd;
      await db.deleteHolding(symbol, strategy);
    }
    await db.adjustCash(usdCost);
  }

  const trade = await db.recordTrade({
    symbol, side, qty, price,
    confidence: signal?.confidence, consensus: signal?.consensus,
    order_id: order.id, status: order.status || 'submitted',
    pnl: usdPnl, reason, strategy,
    market, currency, fx_rate: fxToUsd,
  });

  await db.recordAudit({
    event_type: 'TRADE_EXECUTED', symbol, decision: side,
    confidence: signal?.confidence, models: signal?.models,
    payload: { qty, price, stop_loss, take_profit, pnl: usdPnl, native_pnl: nativePnl,
               reason, strategy, market, currency, fx_rate: fxToUsd },
  });

  const ccyTag = currency === 'USD' ? '$' : `${currency} `;
  await discordService.sendTradeAlert({
    symbol, action: side, qty, price: `${ccyTag}${price.toFixed(2)}`,
    confidence: signal?.confidence || 1, reason: `[${strategy}/${market}] ${reason}`,
  });

  // REAL-TIME adaptive learning — feed USD P&L (the unified portfolio
  // measurement unit) so the multi-market track-record stays comparable.
  if (side === 'SELL' && usdPnl !== null && Number.isFinite(usdPnl)) {
    adaptiveLearning.recordOutcome({ symbol, strategy, pnl: usdPnl, closedAt: new Date() })
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
  const audUsd = priceMap.audUsd;
  let closed = 0;
  for (const h of holdings) {
    const price = priceMap.lookup[h.symbol] || parseFloat(h.avg_cost); // native
    const qty = parseFloat(h.qty);
    const currency = h.currency || 'USD';
    const fxToUsd = currency === 'AUD' ? audUsd : 1.0;
    try {
      // Route per-symbol — US holdings go to Alpaca, ASX holdings to IBKR.
      // brokerRouter also enforces the kill-switch guard at the broker sink.
      await brokerRouter.placeOrder({ symbol: h.symbol, qty, side: 'sell' });
    } catch (e) {
      console.error(`[Agent] flatten ${h.symbol} order failed:`, e.message);
      continue;
    }
    const nativePnl = (price - parseFloat(h.avg_cost)) * qty;
    const usdPnl = nativePnl * fxToUsd;
    await db.adjustCash(qty * price * fxToUsd);
    await db.deleteHolding(h.symbol, strategyName);
    await db.recordTrade({
      symbol: h.symbol, side: 'SELL', qty, price,
      confidence: 1.0, consensus: 'SELL',
      order_id: `flatten-${Date.now()}`, status: 'flattened',
      pnl: usdPnl, reason, strategy: strategyName,
      market: h.market || 'US', currency, fx_rate: fxToUsd,
    });
    await db.recordAudit({ event_type: 'FORCE_FLATTEN', symbol: h.symbol, decision: 'SELL',
      payload: { qty, price, pnl: usdPnl, native_pnl: nativePnl, reason, strategy: strategyName,
                 market: h.market || 'US', currency, fx_rate: fxToUsd } });
    adaptiveLearning.recordOutcome({ symbol: h.symbol, strategy: strategyName, pnl: usdPnl, closedAt: new Date() })
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

    // Flatten via BOTH brokers in parallel. Each broker's bulk-close API is
    // used (Alpaca DELETE /v2/positions; IBKR per-position market sell loop).
    // Either broker failing is a hard stop for that broker's positions —
    // we DO NOT clear local holdings for a broker that didn't confirm.
    try {
      const out = await brokerRouter.closeAllPositionsAllBrokers();
      await new Promise(r => setTimeout(r, 1500));
      const [aPos, iPos] = await Promise.allSettled([
        alpacaService.isConfigured() ? alpacaService.getPositions() : [],
        ibkrService.isConfigured()   ? ibkrService.getPositions()   : [],
      ]);
      const stillOpen = []
        .concat(aPos.status === 'fulfilled' ? aPos.value.map(p => p.symbol) : [])
        .concat(iPos.status === 'fulfilled' ? iPos.value.map(p => p.symbol) : []);
      if (stillOpen.length) {
        await db.recordAudit({ event_type: 'FORCE_FLATTEN_BROKER_FAIL',
          payload: { reason, remaining: stillOpen, brokers: out } });
        await discordService.sendCircuitBreakerAlert(
          `⚠ FLATTEN INCOMPLETE — brokers still hold: ${stillOpen.join(', ')}. Local state NOT cleared.`
        );
        return;
      }
    } catch (e) {
      await db.recordAudit({ event_type: 'FORCE_FLATTEN_BROKER_FAIL', payload: { reason, error: e.message } });
      await discordService.sendCircuitBreakerAlert(`⚠ FLATTEN ERROR — ${e.message}.`);
      return;
    }

    const priceMap = await buildPriceLookup(holdings);
    const audUsd = priceMap.audUsd;
    for (const h of holdings) {
      const price = priceMap.lookup[h.symbol] || parseFloat(h.avg_cost); // native
      const qty = parseFloat(h.qty);
      const currency = h.currency || 'USD';
      const fxToUsd = currency === 'AUD' ? audUsd : 1.0;
      const nativePnl = (price - parseFloat(h.avg_cost)) * qty;
      const usdPnl = nativePnl * fxToUsd;
      await db.adjustCash(qty * price * fxToUsd);
      await db.deleteHolding(h.symbol, h.strategy);
      await db.recordTrade({
        symbol: h.symbol, side: 'SELL', qty, price,
        confidence: 1.0, consensus: 'SELL',
        order_id: `flatten-${Date.now()}`, status: 'flattened',
        pnl: usdPnl, reason, strategy: h.strategy,
        market: h.market || 'US', currency, fx_rate: fxToUsd,
      });
      await db.recordAudit({ event_type: 'FORCE_FLATTEN', symbol: h.symbol, decision: 'SELL',
        payload: { qty, price, pnl: usdPnl, native_pnl: nativePnl, reason, strategy: h.strategy,
                   market: h.market || 'US', currency, fx_rate: fxToUsd } });
      adaptiveLearning.recordOutcome({ symbol: h.symbol, strategy: h.strategy, pnl: usdPnl, closedAt: new Date() })
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
  const info = marketRegistry.getSymbolInfo(symbol);
  const isAsxSymbol = info.market === 'ASX';
  // Bars come from the symbol's broker (Alpaca for US, IBKR for ASX). The
  // analyzer below is broker-agnostic — bars are normalized to {t,o,h,l,c,v}
  // by each broker service.
  const bars = await brokerRouter.getBars(symbol, sc.timeframe, sc.lookback);
  if (!bars.length) return null;
  // FX rate snapshot — captured once per symbol per cycle so all sizing /
  // P&L math for this analysis uses an internally consistent rate.
  const fxToUsd = info.currency === 'AUD' ? await fxService.getAudToUsd() : 1.0;
  const prices = bars.map(b => b.c);
  const latest = prices[prices.length - 1];           // native currency
  const latestUsd = latest * fxToUsd;                 // USD-equivalent for risk math
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

  // Intraday tactical setups — US day strategy only. Skipped for ASX
  // (intradayService relies on US session microstructure / open clock).
  let intraday = null;
  if (sc.name === 'day' && !isAsxSymbol) {
    try { intraday = intradayService.analyzeIntraday(bars, indicators, patterns, holding); }
    catch (e) { intraday = { ok: false, reason: e.message }; }
  }

  // 20-year historical intelligence — Alpaca-sourced, US-only. Skipped for
  // ASX symbols (no equivalent feed wired in yet); analyzer falls back to
  // bar-derived signals which is the safe degradation for a new market.
  let historical = null;
  if (!isAsxSymbol) {
    try {
      const minSinceOpen = minutesSinceOpenET();
      const earlySession = sc.name === 'day' && minSinceOpen != null && minSinceOpen >= 0 && minSinceOpen <= 90;
      historical = await historicalIntel.getInsightsForPrompt(symbol, { withinFirst90Min: earlySession });
    } catch (e) {
      console.error(`[Agent] historicalIntel render error for ${symbol}:`, e.message);
    }
  }

  // Pre-market briefing context — US-only (uses NYSE clock). Skipped for ASX.
  // Returns null otherwise; LLM prompt is unchanged. Never throws.
  const premarket = isAsxSymbol ? null : await premarketService.getActiveBriefingContext(symbol, {
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

  // Options activity — US-only (CBOE-derived). Skipped for ASX symbols.
  let optionsActivity = null;
  if (!isAsxSymbol) {
    try {
      const opt = await optionsActivityService.getCached(symbol);
      if (opt) optionsActivity = optionsActivityService.renderForPrompt(opt);
    } catch (_) {}
  }

  // Earnings signal — derived from cached fundamentals (no extra API). PEAD
  // bias + pre-earnings blackout flag for both day and swing strategies.
  let earningsSignal = null;
  try {
    const fund = fundamentals || fundamentalsService.getCached(symbol);
    if (fund) {
      const sig = earningsSignalService.analyzeEarningsSignal(fund);
      earningsSignal = earningsSignalService.renderForPrompt(sig);
    }
  } catch (_) {}

  const signal = await llmService.getEnsembleDecision({
    symbol, priceData, sentiment, newsSentiment, holding, portfolio,
    patterns, fundamentals, indicators, intraday, historical,
    strategyName: sc.name, premarket,
    adaptiveHints, portfolioRisk: portfolioRiskBlock, orderFlow, optionsActivity, earningsSignal,
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
    // Risk sizing happens entirely in USD-equivalent — that keeps the
    // single daily-loss budget and circuit breaker valid across markets.
    // For ASX, we feed the AUD price multiplied by the FX rate; the qty
    // returned is dimensionless (shares), and stop/take come back in
    // USD-equivalent which we convert back to AUD for both the broker
    // order and the holdings table (holdings store NATIVE so the
    // broker-level stop/take comparisons match how the symbol is quoted).
    const dynamicWithUpgrades = { ...(dynamic || {}), adaptiveMult, portfolioMult };
    const eval_ = await riskManager.evaluateBuy({
      symbol, signal, price: latestUsd, equity, cash, holdings,
      strategyConfig: sc, dynamic: dynamicWithUpgrades,
    });
    if (eval_.allow) {
      const sz = eval_.sizing || {};
      // Convert USD-equivalent stop/take back to NATIVE for broker + storage.
      // For US (fxToUsd === 1) this is a no-op.
      const nativeStop = eval_.stop_loss   / fxToUsd;
      const nativeTake = eval_.take_profit / fxToUsd;
      await executeOrder({
        symbol, side: 'BUY', qty: eval_.qty, price: latest,
        signal,
        stop_loss:   parseFloat(nativeStop.toFixed(4)),
        take_profit: parseFloat(nativeTake.toFixed(4)),
        reason: `${signal.reason} | risk $${eval_.riskUSD}` +
          (sz.compoundMult ? ` (×${sz.compoundMult.toFixed(2)} growth·perf, ${(sz.confFraction*100).toFixed(0)}% conf-band)` : '') +
          (info.currency !== 'USD' ? ` | fx ${info.currency}/USD=${fxToUsd.toFixed(4)}` : ''),
        strategy: sc.name,
        market: info.market, currency: info.currency, fxToUsd,
      });
    } else {
      await db.recordAudit({ event_type: 'TRADE_REJECTED', symbol, decision: 'BUY',
        confidence: signal.confidence, payload: { reason: eval_.reason, strategy: sc.name, market: info.market } });
    }
  } else if (signal.consensus === 'SELL') {
    const eval_ = await riskManager.evaluateSell({ symbol, signal, holdings, strategyConfig: sc });
    if (eval_.allow) {
      await executeOrder({
        symbol, side: 'SELL', qty: eval_.qty, price: latest,
        signal, reason: signal.reason, strategy: sc.name,
        market: info.market, currency: info.currency, fxToUsd,
      });
    } else {
      await db.recordAudit({ event_type: 'TRADE_REJECTED', symbol, decision: 'SELL',
        confidence: signal.confidence, payload: { reason: eval_.reason, strategy: sc.name, market: info.market } });
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
  // Auto-flatten only applies to strategies with a defined "next close"
  // (US day strategy via Alpaca clock). ASX swing holds overnight and
  // never auto-flattens, so we just skip the check when clock is null.
  if (clock) {
    const minsLeft = minutesUntilClose(clock);
    if (sc.forceFlattenBeforeClose && minsLeft <= FORCE_FLATTEN_MINUTES_BEFORE_CLOSE) {
      console.log(`[${sc.name}] ${minsLeft.toFixed(1)}m to close — flattening day positions`);
      await flattenStrategyPositions(sc.name, `Auto-flatten ${FORCE_FLATTEN_MINUTES_BEFORE_CLOSE}m before close`);
      return;
    }
  }

  // Use the strategy's own watchlist (US for day/swing; ASX for asx_swing).
  const stratWatchlist = getWatchlistForStrategy(sc.name);

  const stratHoldings = await db.getHoldings(sc.name);
  await evaluateExistingPositions(stratHoldings, fullPriceLookup, {}, sc);

  for (const symbol of stratWatchlist) {
    try {
      const sh = await db.getHoldings(sc.name);
      const allH = await db.getHoldings();
      // Mark-to-market full equity using the USD-equivalent lookup so
      // ASX positions contribute their USD value to the unified portfolio.
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
  if (killSwitchActive) { console.log('[Agent] Kill switch active — cycle refused'); return; }
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

    // US clock from Alpaca (authoritative — accounts for early closes,
    // half-days, holidays). ASX clock is computed locally from Sydney
    // timezone math (no holiday calendar — ASX-holiday orders simply fail
    // at the broker, which is logged + audit-tagged).
    const clock = await alpacaService.getClock();
    const asxOpen = marketRegistry.isAsxOpen();
    const asxNextOpen = asxOpen ? null : marketRegistry.nextAsxOpen();
    memoryState.marketOpen = clock.is_open;       // legacy field — US open
    memoryState.nextOpen = clock.next_open;
    memoryState.nextClose = clock.next_close;
    memoryState.usMarketOpen = clock.is_open;
    memoryState.asxMarketOpen = asxOpen;
    memoryState.asxNextOpen = asxNextOpen;

    // We continue the cycle if ANY market is open — equity must still be
    // marked-to-market for circuit-breaker monitoring even if no strategy
    // can place new orders this tick.
    if (!clock.is_open && !asxOpen) {
      console.log(`[Agent] All markets closed — US next: ${clock.next_open}, ASX next: ${asxNextOpen}`);
      return;
    }

    const allH = await db.getHoldings();
    const pmap = await buildPriceLookup(allH);
    // USD-equivalent lookup is what the breaker, daily-loss budget, and
    // dynamic-scaling math expect — they all operate in USD.
    const { equity } = await riskManager.computeEquity(allH, pmap.usdLookup);
    const cb = await riskManager.checkCircuitBreaker(equity);
    if (cb.tripped) {
      console.log(`[Agent] CB active — ${cb.reason || 'tripped'}`);
      await discordService.sendCircuitBreakerAlert(cb.reason || `Drawdown ${(cb.drawdown * 100).toFixed(2)}%`);
      await flattenAllPositions(cb.reason || 'Circuit breaker tripped');
      return;
    }

    // Unified USD-equivalent price lookup covering all open holdings +
    // watchlist symbols across BOTH markets. Cross-strategy equity stays
    // accurate even when the same symbol appears under multiple strategies.
    const asxWatchlist = marketRegistry.getAsxWatchlist();
    const symbolsToPrice = new Set([...allH.map(h => h.symbol), ...WATCHLIST, ...asxWatchlist]);
    const usdFullLookup = { ...pmap.usdLookup };
    const audUsd = pmap.audUsd;
    await Promise.all([...symbolsToPrice].filter(s => usdFullLookup[s] === undefined).map(async sym => {
      try {
        const symInfo = marketRegistry.getSymbolInfo(sym);
        const bars = await brokerRouter.getBars(sym, '1Min', 1);
        if (bars.length) {
          const native = bars[bars.length - 1].c;
          usdFullLookup[sym] = symInfo.currency === 'AUD' ? native * audUsd : native;
        }
      } catch (e) { /* per-symbol price fetch failure is non-fatal */ }
    }));

    // Refresh news sentiment for the FULL watchlist (US + ASX). Cached;
    // failure never blocks trading.
    const allWatchlistSymbols = [...new Set([...WATCHLIST, ...asxWatchlist])];
    sentimentService.getSentimentBatch(allWatchlistSymbols, { concurrency: 4 })
      .catch(e => console.error('[Agent] Sentiment refresh error:', e.message));

    if (portfolio.swing_enabled || portfolio.asx_swing_enabled) {
      fundamentalsService.getFundamentalsBatch(allWatchlistSymbols, { concurrency: 3 })
        .catch(e => console.error('[Agent] Fundamentals refresh error:', e.message));
    }

    const scaleName = portfolio.risk_scale || DEFAULT_RISK_SCALE;
    const recentClosed = await db.getRecentTrades(50);
    const dynamic = riskManager.computeDynamicScaling({
      equity,
      startingBalance: parseFloat(portfolio.starting_balance),
      recentClosedTrades: recentClosed,
    });
    memoryState.lastDynamic = dynamic;

    // Per-strategy market gating — a strategy only runs when its market is
    // open. ASX swing runs on Sydney hours; US day/swing on NYSE hours.
    // The clock arg passed to runStrategy is null for ASX (no
    // forceFlatten-before-close logic applies — ASX swing holds overnight).
    const strategies = [
      { sc: applyRiskScale(STRATEGIES.day, scaleName),       enabled: portfolio.day_enabled,        marketOpen: clock.is_open, clock },
      { sc: applyRiskScale(STRATEGIES.swing, scaleName),     enabled: portfolio.swing_enabled,      marketOpen: clock.is_open, clock },
      { sc: applyRiskScale(STRATEGIES.asx_swing, scaleName), enabled: portfolio.asx_swing_enabled !== false, marketOpen: asxOpen,       clock: null },
    ];
    for (const { sc, enabled, marketOpen, clock: stratClock } of strategies) {
      if (!enabled) continue;
      if (!marketOpen) continue;
      const lastRun = memoryState.strategyLastRun[sc.name];
      const elapsed = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 1000 : Infinity;
      if (elapsed < sc.intervalSeconds - 5) continue;
      await runStrategy(sc, portfolio, stratClock, usdFullLookup, dynamic);
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
          && portfolio.agent_running
          && !killSwitchActive;
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
  // Latched kill switch — only a process restart clears it. Reject loudly
  // here so an operator who clicks Start sees the truth instead of a silent
  // no-op (cycles would refuse anyway via the killSwitchActive guard, but
  // the operator deserves explicit feedback).
  if (killSwitchActive) {
    const e = new Error('Kill switch is latched — restart the backend process to resume trading.');
    e.code = 'KILL_SWITCH_LATCHED';
    throw e;
  }
  await db.updatePortfolio({ agent_running: true });
  await db.recordAudit({ event_type: 'AGENT_STARTED', payload: { intervalSeconds: BASE_INTERVAL_SECONDS } });
  if (!intervalHandle) intervalHandle = setInterval(runCycle, BASE_INTERVAL_SECONDS * 1000);
  console.log(`[Agent] Started — base interval ${BASE_INTERVAL_SECONDS}s`);
  runCycle();
}

function isKillSwitchLatched() { return killSwitchActive; }

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

// Standalone "cancel all open orders" — touches working/pending orders only,
// never positions. Used by operators when they want to stop the agent from
// completing in-flight orders without forcing position liquidation.
async function cancelAllOpenOrders(reason = 'operator request') {
  await db.recordAudit({ event_type: 'CANCEL_ALL_ORDERS', payload: { reason } });
  // Hit BOTH brokers — operators expect "cancel all" to be all-broker.
  const out = await brokerRouter.cancelAllOpenOrdersAllBrokers();
  const cancelled = (out.alpaca?.cancelled || 0) + (out.ibkr?.cancelled || 0);
  console.log(`[Agent] Cancelled ${cancelled} open orders across brokers (${reason})`);
  return { cancelled, brokers: out };
}

// Kill switch — the nuclear option. Atomic cascade:
//   1. Audit-log KILL_SWITCH_START with reason + actor
//   2. Cancel every open Alpaca order (no in-flight executions can complete)
//   3. Force-flatten every position (uses existing flattenAllPositions, which
//      already handles broker-fail rollback + per-position audit + Discord)
//   4. Set emergency_pause = true and agent_running = false
//   5. Audit-log KILL_SWITCH_COMPLETE with the result summary
//   6. Discord blast
// Operator must double-confirm (server.js requires confirm:"KILL"). Returns
// the outcome rather than throwing so the API can render a structured response.
// All existing safety rails (3-of-4 quorum, gates, sizing, hedging) remain
// untouched — this only halts the agent, it does not change decision logic.
async function killSwitch({ reason = 'operator kill switch', actor = 'operator' } = {}) {
  const startedAt = new Date();
  const startSummary = { reason, actor, startedAt: startedAt.toISOString() };
  // STEP 1: Trip the sticky abort flag FIRST. Any in-flight executeOrder()
  // call from a cycle that already passed emergency_pause will now refuse.
  // Set BEFORE any await so there is zero window between the operator's
  // intent and the order-blocking guard.
  killSwitchActive = true;
  // Mirror to the broker layer so any code path that calls placeOrder()
  // directly (hedging auto-exec, future hand-rolled call sites) is also
  // refused, not just the executeOrder() funnel.
  try { brokerRouter.setKillSwitchActiveAll(true); } catch (_) {}
  await db.recordAudit({ event_type: 'KILL_SWITCH_START', payload: startSummary });
  console.log(`[Agent] 🛑 KILL SWITCH ENGAGED — ${reason} (actor: ${actor})`);
  try { await discordService.sendCircuitBreakerAlert(`🛑 KILL SWITCH — ${reason}`); } catch (_) {}

  // STEP 2: Halt scheduling so no new cycle can start mid-kill.
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  await db.updatePortfolio({ agent_running: false, emergency_pause: true });

  // STEP 3: Wait for any in-flight cycle to drain. executeOrder is now
  // refusing new orders, but an analyzeAndTradeSymbol() call may still be
  // mid-LLM-await — let it finish cleanly so audit/state writes complete.
  const drainStart = Date.now();
  while (cycleInProgress && Date.now() - drainStart < 30000) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (cycleInProgress) {
    await db.recordAudit({ event_type: 'KILL_SWITCH_DRAIN_TIMEOUT',
      payload: { waitedMs: Date.now() - drainStart } });
    console.error('[Agent] Kill switch: cycle drain timed out after 30s — proceeding with flatten anyway (executeOrder is already blocked)');
  }

  // STEP 4: Cancel open orders across BOTH brokers (best-effort, allSettled
  // inside the router so one broker failing doesn't skip the other).
  let cancelResult = { cancelled: 0 };
  try {
    const out = await brokerRouter.cancelAllOpenOrdersAllBrokers();
    cancelResult = { cancelled: (out.alpaca?.cancelled || 0) + (out.ibkr?.cancelled || 0), brokers: out };
  } catch (e) {
    await db.recordAudit({ event_type: 'KILL_SWITCH_CANCEL_FAIL', payload: { error: e.message } });
  }

  // STEP 5: Flatten everything via the established codepath (already does
  // the broker-confirm-then-clear-local pattern + per-position audit rows).
  // flattenAllPositions uses Alpaca's DELETE /v2/positions, not executeOrder,
  // so the killSwitchActive guard does not block the flatten itself.
  const holdingsBefore = await db.getHoldings();
  await flattenAllPositions(`Kill switch: ${reason}`);
  const holdingsAfter = await db.getHoldings();

  const result = {
    reason, actor,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    ordersCancelled: cancelResult.cancelled || 0,
    positionsBefore: holdingsBefore.length,
    positionsAfter: holdingsAfter.length,
    flattenComplete: holdingsAfter.length === 0,
  };
  await db.recordAudit({ event_type: 'KILL_SWITCH_COMPLETE', payload: result });
  try {
    const tag = result.flattenComplete ? '✅ flatten complete' : `⚠ ${result.positionsAfter} positions still open`;
    await discordService.sendCircuitBreakerAlert(`Kill switch finished — ${tag}, ${result.ordersCancelled} orders cancelled`);
  } catch (_) {}
  console.log(`[Agent] Kill switch complete:`, result);
  return result;
}

async function resetCircuitBreaker() {
  const holdings = await db.getHoldings();
  const priceMap = await buildPriceLookup(holdings);
  // USD-equivalent — day_start_equity is stored in USD.
  const { equity } = await riskManager.computeEquity(holdings, priceMap.usdLookup);
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
  const field = strategyName === 'day'       ? 'day_enabled'
              : strategyName === 'swing'     ? 'swing_enabled'
              : strategyName === 'asx_swing' ? 'asx_swing_enabled'
              : null;
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
  // USD-equivalent — equity / day_start_equity are USD throughout.
  const { equity } = await riskManager.computeEquity(holdings, priceMap.usdLookup);
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
  // `lookup` (native) is for per-holding display fields (currentPrice in
  // the symbol's own currency). `usdLookup` is what equity / P&L math uses.
  const lookup = priceMap.lookup;
  const { equity } = holdings.length ? await riskManager.computeEquity(holdings, priceMap.usdLookup) : { equity: parseFloat(portfolio.cash_balance) };
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
    enabled: s.name === 'day'       ? !!portfolio.day_enabled
           : s.name === 'swing'     ? !!portfolio.swing_enabled
           : s.name === 'asx_swing' ? portfolio.asx_swing_enabled !== false
           : false,
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
    markets: {
      US:  { open: !!memoryState.usMarketOpen,  nextOpen: memoryState.nextOpen || null, nextClose: memoryState.nextClose || null },
      ASX: { open: !!memoryState.asxMarketOpen, nextOpen: memoryState.asxNextOpen || null, nextClose: null },
    },
    fx: fxService.getStatus(),
    asxWatchlist: marketRegistry.getAsxWatchlist(),
    holdings: holdings.map(h => {
      // Per-holding values are reported in the symbol's NATIVE currency
      // (USD for US, AUD for ASX). The UI shows `currency` so users can
      // distinguish them. USD-equivalent equity above already accounts
      // for FX so the top-line numbers stay comparable across markets.
      const native = lookup[h.symbol] || parseFloat(h.avg_cost);
      return {
        symbol: h.symbol, strategy: h.strategy,
        market: h.market || 'US',
        currency: h.currency || 'USD',
        qty: parseFloat(h.qty), avgCost: parseFloat(h.avg_cost),
        currentPrice: native,
        stopLoss: h.stop_loss ? parseFloat(h.stop_loss) : null,
        takeProfit: h.take_profit ? parseFloat(h.take_profit) : null,
        marketValue: parseFloat(h.qty) * native,
        unrealizedPnL: (native - parseFloat(h.avg_cost)) * parseFloat(h.qty),
      };
    }),
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
  cancelAllOpenOrders, killSwitch, isKillSwitchLatched,
  setStrategyEnabled, setTradingMode, setRiskScale, WATCHLIST,
};
