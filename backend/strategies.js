// Default 30-symbol high-liquidity US watchlist. Override with env WATCHLIST=...
// Spans the major S&P sectors so the agent isn't lopsided into one regime:
// Mega-cap Tech, Semis, Financials/Payments, Consumer (Disc + Staples),
// Healthcare/Pharma, Energy, plus broad-market ETFs as macro anchors.
const DEFAULT_WATCHLIST = [
  'AAPL', 'NVDA', 'MSFT', 'AMZN', 'META',      // mega-cap tech
  'GOOGL', 'TSLA', 'AMD', 'AVGO', 'NFLX',      // tech / streaming
  'JPM', 'BAC', 'GS', 'V',                      // financials / payments
  'COST', 'WMT', 'HD', 'MCD',                   // consumer (staples + discretionary)
  'JNJ', 'PFE', 'LLY', 'UNH',                   // healthcare / pharma / managed care
  'XOM', 'CVX',                                 // energy majors
  'INTC', 'MU', 'QCOM', 'TSM',                  // semis (foundry + memory + mobile)
  'SPY', 'QQQ',                                 // broad-market ETFs (macro anchors)
];

// Base strategy templates. Per-trade risk numbers, confidence gates, and
// stop/target multipliers are scaled at runtime by the user's chosen Risk Scale
// (see RISK_SCALES below + applyRiskScale).
//
// Trailing stops: `trailingStopPct` (e.g. 0.025 = 2.5%) — once a position is in
// profit, the stop ratchets up to `peak * (1 - trailingStopPct)`, never down.
// Day strategy uses null (positions are flattened intraday anyway).
const STRATEGIES = {
  day: {
    name: 'day',
    label: 'Day Trading',
    description: 'Fast intraday trades on 1-minute bars. Auto-flattens 5 min before close. No overnight risk.',
    market: 'US',                     // routes via Alpaca, US clock, US watchlist
    timeframe: '1Min',
    lookback: 60, // need ≥35 bars for MACD(12,26,9); 60 gives a stable EMA warmup
    intervalSeconds: 30,
    // base stop/target — scaled by risk scale's stop/target multipliers
    stopLossPct: 0.005,
    takeProfitPct: 0.01,
    maxHoldings: 4,
    forceFlattenBeforeClose: true,
    holdOvernight: false,
    minDirectionalAgreement: 3, // quorum NEVER relaxed by risk scale
    maxPositionPct: 0.03,
    trailingStopPct: null,           // not used intraday
    trailingActivatePct: null,
  },
  swing: {
    name: 'swing',
    label: 'Longer Hold',
    description: 'Multi-day swing trades on 15-minute bars. Wider stops, larger targets, can hold overnight. Trailing stop locks in 2.5% below peak once +2% in profit.',
    market: 'US',                     // routes via Alpaca, US clock, US watchlist
    timeframe: '15Min',
    lookback: 60,
    intervalSeconds: 300,
    stopLossPct: 0.02,
    takeProfitPct: 0.05,
    maxHoldings: 3,
    forceFlattenBeforeClose: false,
    holdOvernight: true,
    minDirectionalAgreement: 3,
    maxPositionPct: 0.05,
    trailingStopPct: 0.025,           // 2.5% trail below peak
    trailingActivatePct: 0.02,        // arms once +2% above entry
  },
  // ASX swing strategy — runs on Australian market hours (10:00–16:00
  // Sydney, Mon–Fri). Uses 15-min bars, holds overnight, trails 2.5%.
  // Routes via IBKR (separate broker) and uses the ASX watchlist. All
  // existing safety rails (3-of-4 quorum, confidence gate, daily loss
  // budget, circuit breaker, kill switch) apply identically — they work
  // in USD-equivalent terms (FX-converted at sizing time and at equity
  // computation), so the loss budget remains a unified portfolio cap
  // across both markets.
  asx_swing: {
    name: 'asx_swing',
    label: 'ASX Swing',
    description: 'Australian-market swing trades via IBKR. 15-min bars, holds overnight. AUD-priced; risk sized in USD-equivalent so the daily loss budget remains a single portfolio cap across both markets.',
    market: 'ASX',                    // routes via IBKR, ASX clock, ASX watchlist
    currency: 'AUD',
    timeframe: '15Min',
    lookback: 60,
    intervalSeconds: 300,
    stopLossPct: 0.02,
    takeProfitPct: 0.05,
    maxHoldings: 3,
    forceFlattenBeforeClose: false,
    holdOvernight: true,
    minDirectionalAgreement: 3,
    maxPositionPct: 0.05,
    trailingStopPct: 0.025,
    trailingActivatePct: 0.02,
  },
};

// User-controlled risk scales. The Risk Scale governs:
//   - confidenceThreshold (consensus gate)
//   - min/maxRiskUSD per trade
//   - stop & target multipliers (relative to base strategy)
//   - maxDailyLossUSD (daily loss circuit-breaker budget)
// Quorum (3-of-4 directional agreement) and the % drawdown circuit breaker are
// NOT relaxed by risk scale — those remain hard safety floors.
const RISK_SCALES = {
  conservative: {
    name: 'conservative',
    label: 'Conservative',
    emoji: '🛡',
    short: 'Capital preservation first.',
    description: '85% confidence gate, $50–$100 per trade, tight stops, $100/day loss cap.',
    confidenceThreshold: 0.85,
    minRiskUSD: 50,
    maxRiskUSD: 100,
    stopMultiplier: 0.8,
    targetMultiplier: 0.9,
    maxDailyLossUSD: 100,
  },
  balanced: {
    name: 'balanced',
    label: 'Balanced',
    emoji: '⚖',
    short: 'Default — steady growth, sensible risk.',
    description: '80% confidence gate, $100–$200 per trade, balanced stops, $200/day loss cap.',
    confidenceThreshold: 0.80,
    minRiskUSD: 100,
    maxRiskUSD: 200,
    stopMultiplier: 1.0,
    targetMultiplier: 1.0,
    maxDailyLossUSD: 200,
  },
  aggressive: {
    name: 'aggressive',
    label: 'Aggressive',
    emoji: '🔥',
    short: 'Bigger swings, bigger payoffs.',
    description: '75% confidence gate, $200–$400 per trade, wider stops/targets, $400/day loss cap.',
    confidenceThreshold: 0.75,
    minRiskUSD: 200,
    maxRiskUSD: 400,
    stopMultiplier: 1.4,
    targetMultiplier: 1.6,
    maxDailyLossUSD: 400,
  },
};

const DEFAULT_RISK_SCALE = 'balanced';

function getRiskScale(name) {
  return RISK_SCALES[name] || RISK_SCALES[DEFAULT_RISK_SCALE];
}

// Returns a NEW strategy object with risk-scale overrides applied.
// Never mutates the base strategy.
function applyRiskScale(strategy, scaleName) {
  const scale = getRiskScale(scaleName);
  return {
    ...strategy,
    confidenceThreshold: scale.confidenceThreshold,
    minRiskUSD: scale.minRiskUSD,
    maxRiskUSD: scale.maxRiskUSD,
    stopLossPct: +(strategy.stopLossPct * scale.stopMultiplier).toFixed(5),
    takeProfitPct: +(strategy.takeProfitPct * scale.targetMultiplier).toFixed(5),
    riskScale: scale.name,
  };
}

function getStrategy(name, scaleName) {
  const base = STRATEGIES[name];
  if (!base) return null;
  return scaleName ? applyRiskScale(base, scaleName) : base;
}

function listStrategies(scaleName) {
  return Object.values(STRATEGIES).map(s => scaleName ? applyRiskScale(s, scaleName) : s);
}

function listRiskScales() {
  return Object.values(RISK_SCALES);
}

function getWatchlist() {
  const fromEnv = (process.env.WATCHLIST || '').split(',').map(s => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_WATCHLIST;
}

// Per-strategy watchlist resolver. US strategies use the US watchlist; the
// ASX strategy pulls from marketRegistry. Caller-side dispatch so we
// don't have to import marketRegistry at the top (avoids a cycle if
// marketRegistry ever needs strategy metadata).
function getWatchlistForStrategy(strategyName) {
  if (strategyName === 'asx_swing') {
    const { getAsxWatchlist } = require('./services/marketRegistry');
    return getAsxWatchlist();
  }
  return getWatchlist();
}

module.exports = {
  STRATEGIES, RISK_SCALES, DEFAULT_RISK_SCALE, DEFAULT_WATCHLIST, getWatchlist,
  getWatchlistForStrategy,
  getStrategy, listStrategies, getRiskScale, applyRiskScale, listRiskScales,
};
