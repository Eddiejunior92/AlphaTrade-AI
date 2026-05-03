require('dotenv').config();
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const llmService = require('./services/llmService');
const alpacaService = require('./services/alpacaService');
const discordService = require('./services/discordService');

const WATCHLIST = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META', 'GOOGL', 'SPY'];
const MAX_POSITION_SIZE = parseFloat(process.env.MAX_POSITION_SIZE) || 1000;
const MAX_DAILY_LOSS = parseFloat(process.env.MAX_DAILY_LOSS) || 500;
const CONFIDENCE_THRESHOLD = 0.65;
const TRADING_MODE = process.env.TRADING_MODE || 'paper';

let agentState = {
  running: false,
  mode: TRADING_MODE,
  dailyPnL: 0,
  tradesCount: 0,
  circuitBreakerTripped: false,
  lastRun: null,
  tradeLog: [],
  signals: {},
  startTime: Date.now(),
};

function getAgentState() {
  return { ...agentState };
}

async function analyzeSymbol(symbol) {
  try {
    const bars = await alpacaService.getBars(symbol, '5Min', 20);
    if (!bars.length) return null;

    const prices = bars.map(b => b.c);
    const latest = prices[prices.length - 1];
    const change = ((latest - prices[0]) / prices[0] * 100).toFixed(2);
    const sentiment = parseFloat(change) > 0 ? 'bullish' : 'bearish';

    const priceData = {
      symbol,
      latest,
      change: `${change}%`,
      high: Math.max(...prices).toFixed(2),
      low: Math.min(...prices).toFixed(2),
      bars: bars.slice(-5).map(b => ({ t: b.t, c: b.c, v: b.v })),
    };

    const signal = await llmService.getEnsembleSignal(symbol, priceData, sentiment);

    const result = {
      id: uuidv4(),
      symbol,
      timestamp: new Date().toISOString(),
      price: latest,
      change: `${change}%`,
      signal: signal.consensus,
      confidence: signal.confidence,
      votes: signal.votes,
      models: signal.results,
      reason: signal.reason,
    };

    agentState.signals[symbol] = result;
    return result;
  } catch (e) {
    console.error(`[Agent] analyzeSymbol ${symbol} error:`, e.message);
    return null;
  }
}

async function executeTrade(signal, account) {
  if (agentState.circuitBreakerTripped) {
    console.log('[Agent] Circuit breaker active — trade blocked');
    return null;
  }

  if (agentState.dailyPnL <= -MAX_DAILY_LOSS) {
    agentState.circuitBreakerTripped = true;
    await discordService.sendCircuitBreakerAlert(`Daily loss limit of $${MAX_DAILY_LOSS} reached.`);
    console.log('[Agent] Max daily loss reached — circuit breaker tripped');
    return null;
  }

  const equity = parseFloat(account.equity) || 25000;
  const qty = Math.max(1, Math.floor(MAX_POSITION_SIZE / (signal.price || 100)));

  const tradeEntry = {
    id: uuidv4(),
    symbol: signal.symbol,
    action: signal.signal,
    qty,
    price: signal.price,
    confidence: signal.confidence,
    timestamp: new Date().toISOString(),
    mode: TRADING_MODE,
    status: 'pending',
  };

  try {
    if (signal.signal === 'HOLD') {
      tradeEntry.status = 'skipped';
    } else {
      const order = await alpacaService.placeOrder({
        symbol: signal.symbol,
        qty,
        side: signal.signal.toLowerCase(),
      });
      tradeEntry.orderId = order.id;
      tradeEntry.status = order.status || 'submitted';

      await discordService.sendTradeAlert({
        symbol: signal.symbol,
        action: signal.signal,
        qty,
        price: signal.price?.toFixed(2),
        confidence: signal.confidence,
        reason: signal.reason,
      });
    }
  } catch (e) {
    tradeEntry.status = 'error';
    tradeEntry.error = e.message;
    console.error('[Agent] Trade execution error:', e.message);
  }

  agentState.tradeLog.unshift(tradeEntry);
  if (agentState.tradeLog.length > 100) agentState.tradeLog = agentState.tradeLog.slice(0, 100);
  agentState.tradesCount++;

  return tradeEntry;
}

async function runCycle() {
  if (!agentState.running) return;
  console.log(`[Agent] Starting cycle at ${new Date().toISOString()}`);
  agentState.lastRun = new Date().toISOString();

  const account = await alpacaService.getAccount();

  const results = await Promise.allSettled(WATCHLIST.map(sym => analyzeSymbol(sym)));
  const signals = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

  const actionable = signals.filter(
    s => s.signal !== 'HOLD' && s.confidence >= CONFIDENCE_THRESHOLD
  );

  for (const signal of actionable) {
    await executeTrade(signal, account);
  }

  console.log(`[Agent] Cycle complete. Analyzed: ${signals.length}, Actionable: ${actionable.length}`);
}

function startAgent() {
  agentState.running = true;
  agentState.circuitBreakerTripped = false;
  console.log('[Agent] Started');
  runCycle();
}

function stopAgent() {
  agentState.running = false;
  console.log('[Agent] Stopped');
}

function resetCircuitBreaker() {
  agentState.circuitBreakerTripped = false;
  agentState.dailyPnL = 0;
  console.log('[Agent] Circuit breaker reset');
}

const INTERVAL_MINUTES = parseInt(process.env.TRADE_INTERVAL_MINUTES) || 15;
cron.schedule(`*/${INTERVAL_MINUTES} * * * *`, () => {
  if (agentState.running) runCycle();
});

cron.schedule('0 0 * * *', () => {
  agentState.dailyPnL = 0;
  agentState.tradesCount = 0;
  agentState.circuitBreakerTripped = false;
  console.log('[Agent] Daily stats reset');
});

module.exports = { startAgent, stopAgent, getAgentState, runCycle, resetCircuitBreaker, WATCHLIST };
