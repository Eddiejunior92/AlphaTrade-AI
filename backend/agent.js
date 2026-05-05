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
const mlAdaptive = require('./services/mlAdaptiveService');
const regimeService = require('./services/regimeService');
const metaLearning = require('./services/metaLearningService');
const knowledgeGraph = require('./services/knowledgeGraphService');
const rlExecution = require('./services/rlExecutionService');
const continuousLearning = require('./services/continuousLearningService');
const portfolioOpt = require('./services/portfolioOptimizationService');
const hedgingService = require('./services/hedgingService');
const orderFlowService = require('./services/orderFlowService');
const optionsActivityService = require('./services/optionsActivityService');
const optionsFlowService = require('./services/optionsFlowService');
const macroFactorService = require('./services/macroFactorService');
const macroForecastService = require('./services/macroForecastService');
const scenarioSimService = require('./services/scenarioSimService');
const causalInference = require('./services/causalInferenceService');
const counterfactual = require('./services/counterfactualService');
const safetySuggestion = require('./services/safetySuggestionService');
const memoryService = require('./services/memoryService');
const propagationService = require('./services/propagationService');
const feedbackService = require('./services/feedbackService');
const marketPretrainService = require('./services/marketPretrainService');
const earningsSignalService = require('./services/earningsSignalService');
const earningsTranscriptService = require('./services/earningsTranscriptService');
// [Capital & Risk Capacity / Upgrade #3] — purely additive prompt context.
// All three layers below feed the LLM ensemble informational blocks; the
// existing safety stack (quorum, 75-85% gate, $100/day loss budget, 5%
// drawdown breaker, kill switch, sizing math, no-averaging-in, trailing
// stops) is unchanged and retains full veto power.
const varStressService = require('./services/varStressService');
const dynamicHedgingService = require('./services/dynamicHedgingService');
const liquidityService = require('./services/liquidityService');
const db = require('./services/db');
const { STRATEGIES, listStrategies, getStrategy, applyRiskScale, getRiskScale, listRiskScales, DEFAULT_RISK_SCALE, getWatchlist, getWatchlistForStrategy } = require('./strategies');

const WATCHLIST = getWatchlist();
// Master cycle tick. Floor lowered to 20s so the day strategy's 20s cadence
// can actually fire on schedule — a strategy can never run faster than this
// loop. Other strategies (swing 300s, asx_swing 300s) are gated by their own
// intervalSeconds inside runCycle, so they're unaffected.
const BASE_INTERVAL_SECONDS = Math.max(20, parseInt(process.env.AGENT_INTERVAL_SECONDS || '20'));
const FORCE_FLATTEN_MINUTES_BEFORE_CLOSE = parseInt(process.env.FORCE_FLATTEN_MINUTES_BEFORE_CLOSE || '5');

// =============================================================================
// [Upgrade #4 / Scale & Speed] Performance counters + LLM-skip cache.
// =============================================================================
// All counters are observability-only — none of them gates any safety check.
// `perfMetrics` is reset by /api/perf?reset=1 for ad-hoc measurement windows.
const perfMetrics = {
  cycles: 0,
  cycleDurationsMs: [],     // bounded ring buffer (last 60)
  lastCycleMs: null,
  lastCycleStartedAt: null,
  lastCycleFinishedAt: null,
  strategyDurationsMs: {},  // { day:[…], swing:[…], asx_swing:[…] } — last 60 each
  ensembleCalls: 0,         // calls that actually went to llmService
  ensembleSkipped: 0,       // skip-cache reuse count (HOLD passthroughs)
  ensembleQuietSkipped: 0,  // quiet-market shortcut hits (no LLM call at all)
  ensembleEscalated: 0,     // calls that included the premium tier
  watchdogResets: 0,
  startedAt: Date.now(),
};
function _pushBounded(arr, val, cap = 60) { arr.push(val); if (arr.length > cap) arr.shift(); }

// =============================================================================
// LLM cost-optimisation: tier routing + skip cache
// =============================================================================
// At 20s day cadence the ensemble would be called ~180×/hour/symbol. Two
// guards keep cost flat:
//
// 1) TIER ROUTING (computeRoutingReasons) — most cycles run the cheap tier
//    (Gemini Flash + Grok Fast, 2 voters). We escalate to the full 4-voter
//    ensemble (adds Claude 3.7 + GPT-4o) ONLY when the decision is
//    materially more important: held position, non-day strategy, vol/news
//    regimes, strong tactical setup, strong news, or fresh breakout.
//
// 2) SKIP CACHE (_llmSkipCache) — when the previous decision was HOLD AND
//    we hold no position AND price has barely drifted AND we're inside the
//    skip window, we reuse the cached HOLD verbatim and don't call the LLM
//    at all. NEVER applied to BUY/SELL signals (entries/exits must always
//    re-evaluate fresh) and NEVER applied when a position is open.
//
// SAFETY: the quorum rule, the 75-85% confidence gate, the daily-loss
// budget, the circuit breaker, the kill switch, and riskManager sizing are
// ALL UNCHANGED. requiredValid scales proportionally with pool size inside
// llmService so the gate never gets easier to clear.
// AGGRESSIVE COST-CUT DEFAULTS (round 2):
//   • SKIP_TTL 60s → 120s  — quiet HOLDs reused for up to 2 minutes
//   • SKIP_PRICE_BPS 15 → 35 — allow 0.35% drift before forcing fresh LLM
// Both still env-overridable; both only apply to flat-position day cycles
// where the previous decision was HOLD. BUY/SELL signals and held positions
// always re-evaluate fresh on the next tick.
const LLM_SKIP_TTL_MS = parseInt(process.env.LLM_SKIP_TTL_SECONDS || '120') * 1000;
const LLM_SKIP_PRICE_BPS = parseFloat(process.env.LLM_SKIP_PRICE_BPS || '35');
const _llmSkipCache = new Map(); // `${strategy}:${symbol}` → { signal, ts, price }

// Quiet-market shortcut thresholds. When the tape is genuinely sleepy on a
// flat name, we don't need the LLM at all — emit a synthetic HOLD with the
// same shape as a real signal. Tunable via env so the user can tighten if
// they ever see entries being missed.
const QUIET_NEWS_ABS_MAX = parseFloat(process.env.LLM_QUIET_NEWS_ABS_MAX || '0.15');
const QUIET_REGIMES = (process.env.LLM_QUIET_REGIMES || 'normal,mean_reverting')
  .split(',').map(s => s.trim()).filter(Boolean);
const QUIET_SHORTCUT_ENABLED = String(process.env.LLM_QUIET_SHORTCUT || 'true').toLowerCase() !== 'false';

function computeRoutingReasons({ holding, strategyName, regime, intraday, newsSentiment, patterns }) {
  const reasons = [];
  if (holding) reasons.push('holding');
  // Swing + ASX swing run every 5 min — low frequency, so always escalate.
  if (strategyName && strategyName !== 'day') reasons.push(`strategy:${strategyName}`);
  // regime is an object {primary, tags, confidence, metrics} from
  // regimeService.classifyRegime — pull the primary label string. Defensive
  // handling: accept either a string (legacy) or an object. Round 2: dropped
  // `low_liquidity` from the escalation set — quiet illiquid names rarely
  // benefit from the premium tier and consume disproportionate cost.
  const regimePrimary = typeof regime === 'string' ? regime : regime?.primary;
  if (regimePrimary === 'high_vol' || regimePrimary === 'news_driven') {
    reasons.push(`regime:${regimePrimary}`);
  }
  // Round 2: tightened thresholds so only TOP-decile setups get the premium
  // tier. dipBuy is on a 0-5 scale; only the maximum score escalates now.
  // News abs raised 0.5 → 0.7 (decisive headlines only).
  if (intraday?.dipBuy?.score >= 5) reasons.push('strong_dip_buy');
  if (intraday?.profitTake) reasons.push('profit_take_setup');
  const newsScore = Number(newsSentiment?.score);
  if (Number.isFinite(newsScore) && Math.abs(newsScore) >= 0.7) reasons.push('strong_news');
  if (patterns?.breakout && patterns.breakout !== 'none' && patterns.breakout !== 'inside') {
    reasons.push(`breakout:${patterns.breakout}`);
  }
  return reasons;
}

// Quiet-market shortcut: when the day-strategy tape is genuinely sleepy on a
// flat name, return a synthetic HOLD without calling any LLM. This is a
// pure cost optimisation — HOLD = no trade either way, so trading behaviour
// is identical to what the ensemble would have produced for the same inputs.
//
// All conditions must hold:
//   • day strategy + no open position
//   • not flagged for escalation (no holding/regime/setup/news/breakout)
//   • regime.primary in {normal, mean_reverting}  (low-vol / range-bound)
//   • |newsSentiment.score| < QUIET_NEWS_ABS_MAX  (effectively neutral)
//   • no breakout pattern, no profit-take setup, no dip-buy score
//
// Returns null when conditions are not met → caller proceeds with the
// existing skip-cache + ensemble path. When triggered, increments
// perfMetrics.ensembleQuietSkipped and emits a tagged audit row.
function tryQuietMarketShortcut({ strategyName, holding, escalate, regime, newsSentiment, patterns, intraday }) {
  if (!QUIET_SHORTCUT_ENABLED) return null;
  if (strategyName !== 'day' || holding || escalate) return null;
  const regimePrimary = typeof regime === 'string' ? regime : regime?.primary;
  if (!QUIET_REGIMES.includes(regimePrimary)) return null;
  // Require a FINITE neutral score. Missing sentiment is treated as
  // "unknown, not neutral" → fall through to the cheap-tier LLM call so we
  // don't synthesize HOLD blindly during data gaps.
  const newsScore = Number(newsSentiment?.score);
  if (!Number.isFinite(newsScore) || Math.abs(newsScore) >= QUIET_NEWS_ABS_MAX) return null;
  if (patterns?.breakout && patterns.breakout !== 'none' && patterns.breakout !== 'inside') return null;
  if (intraday?.profitTake) return null;
  if (intraday?.dipBuy?.score && intraday.dipBuy.score > 0) return null;
  return {
    consensus: 'HOLD',
    confidence: 0,
    agreement: 1,
    agreementCount: 0,
    validCount: 0,
    totalModels: 0,
    votes: { BUY: 0, SELL: 0, HOLD: 0 },
    models: [],
    reason: `[quiet-market] regime=${regimePrimary}, news=${Number.isFinite(newsScore) ? newsScore.toFixed(2) : 'n/a'}, no setup/breakout — synthetic HOLD (no LLM call)`,
    pool: [],
    escalated: false,
    routingReason: 'quiet_market_shortcut',
    rawConfidence: 0,
    weightedConsensus: 'HOLD',
    weightedConfidence: 0,
    weights: null,
    meta: null,
    _skippedQuietMarket: true,
  };
}

// [Upgrade #4 / Scale & Speed] Execution mutex.
// -----------------------------------------------------------------------------
// US-bucket and ASX-bucket strategies run concurrently (Promise.all in
// runCycle). Both buckets call `riskManager.evaluateBuy({ ..., cash })` where
// `cash` is read from a SHARED `portfolio.cash_balance` (db.js). Without
// serialization a US BUY and an ASX BUY could both observe the same cash
// snapshot, both pass the budget check, and overdraw. This promise-chain
// mutex serializes ONLY the small critical section (evaluateBuy + place order
// + adjustCash) — the slow LLM ensemble and bar/news/intel fetches still run
// in parallel. Effect on throughput: order placement is naturally infrequent
// (most ticks are HOLD), so serializing this 50-200 ms section costs ~nothing
// while removing the cash double-spend race entirely.
let _executionChain = Promise.resolve();
async function withExecutionLock(fn) {
  const prev = _executionChain;
  let release;
  _executionChain = new Promise(r => { release = r; });
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

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
// `mlFeatures` and `riskUSD` are optional — populated only on BUY calls so
// that close-time mlAdaptive.recordOutcome() can replay the exact decision-
// time feature vector against the realised P&L. Both are stashed in the
// TRADE_EXECUTED audit payload, then looked up at SELL time keyed on
// (symbol, strategy).
async function executeOrder({ symbol, side, qty, price, signal, stop_loss, take_profit,
                              reason, strategy, market, currency, fxToUsd,
                              mlFeatures, riskUSD, regime }) {
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
               reason, strategy, market, currency, fx_rate: fxToUsd,
               // Persist ML + regime metadata on BUY so the SELL path can
               // train both the mlAdaptive and metaLearning layers on
               // the exact decision-time context.
               ...(side === 'BUY' && mlFeatures ? { ml_features: mlFeatures, ml_risk_usd: riskUSD } : {}),
               ...(side === 'BUY' && regime ? { regime } : {}) },
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
    // ML adaptive layer — replay the originating BUY's feature vector and
    // train both heads on the realised pnl/risk ratio. Best-effort lookup;
    // silent no-op if no BUY audit row found within the last 30 days.
    recordMLOutcomeForClose({ symbol, strategy, pnl: usdPnl }).catch(() => {});
    // RL execution layer — credit every intra-trade decision logged for this
    // position with the realised R-multiple. Best-effort; silent no-op if no
    // RL decisions were recorded (e.g. day strategy with no trailing stop).
    recordRLOutcomeForClose({ symbol, strategy, pnl: usdPnl }).catch(() => {});
    // Clear the per-position audit-debounce memo so the NEXT holding of this
    // symbol/strategy starts with a fresh "log on first decision" memo
    // instead of inheriting the closed trade's last action.
    try { rlExecution.clearAuditMemo(symbol, strategy); } catch (_) {}
    // Self-Supervised Market Pre-Training fine-tune — Bayesian-update the
    // codeword's regime distribution with this realised trade outcome.
    // Effective-sample-size 1 so own trades cannot dominate the prior.
    // Best-effort; silent no-op on any failure.
    marketPretrainService.applyTradeFineTune({
      symbol, strategy, exitPrice: parseFloat(price), exitAt: new Date(),
    }).catch(() => {});
  }

  return trade;
}

// Look up the originating BUY's ML feature vector + per-trade USD risk from
// the audit log and forward the realised P&L to mlAdaptiveService for
// online training. Pure best-effort — never throws.
async function recordMLOutcomeForClose({ symbol, strategy, pnl }) {
  try {
    const { rows } = await db.query(`
      SELECT payload FROM audit_log
      WHERE event_type = 'TRADE_EXECUTED' AND symbol = $1
        AND decision = 'BUY'
        AND payload->>'strategy' = $2
        AND created_at >= NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC
      LIMIT 1
    `, [symbol, strategy]);
    const p = rows[0]?.payload;
    const features = p?.ml_features;
    const riskUSD = p?.ml_risk_usd;
    const regime  = p?.regime;
    if (Array.isArray(features) && features.length) {
      await mlAdaptive.recordOutcome({ features, pnl, riskUSD });
    }
    // Train the regime meta-learning layer on every close. If the originating
    // BUY pre-dates the regime layer (older audit row, no `regime` payload),
    // metaLearning attributes the trade to the 'normal' bucket — the safe
    // default — rather than dropping the sample.
    await metaLearning.recordOutcome({ regime, strategy, pnl, riskUSD });
  } catch (e) {
    console.warn(`[Agent] ML/meta close-attribution failed for ${symbol}/${strategy}:`, e.message);
  }
}

// Pull the originating BUY's per-trade USD risk from the audit log so the RL
// reward is in R-multiple terms (matches mlAdaptive's R scaling). Falls back
// to the absolute pnl when risk isn't available.
async function recordRLOutcomeForClose({ symbol, strategy, pnl }) {
  try {
    const { rows } = await db.query(`
      SELECT payload FROM audit_log
      WHERE event_type = 'TRADE_EXECUTED' AND symbol = $1
        AND decision = 'BUY' AND payload->>'strategy' = $2
        AND created_at >= NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC LIMIT 1
    `, [symbol, strategy]);
    const riskUSD = rows[0]?.payload?.ml_risk_usd || Math.max(Math.abs(pnl), 1);
    await rlExecution.recordOutcome({ symbol, strategy, pnlUSD: pnl, riskUSD });
  } catch (e) {
    console.warn('[Agent] RL close-attribution failed:', e.message);
  }
}

async function evaluateExistingPositions(strategyHoldings, lookup, stale, strategyConfig) {
  for (const h of strategyHoldings) {
    const price = lookup[h.symbol];
    if (!price || stale[h.symbol]) continue;

    // RL execution layer — picks a bounded adjustment to trailing config based
    // on (regime, strategy, MFE%, current PnL%). The returned `adjustedConfig`
    // only modifies trailingStopPct/trailingActivatePct within [0.5×, 1.5×]
    // of the strategy default (or LOCK_IN — a 0.7% tight trail armed
    // immediately). Falls back to strategyConfig on any failure. Hard stop,
    // daily loss budget, breaker, kill switch, and quorum all unchanged —
    // the existing ratchet still only moves stops UP, never down.
    let activeConfig = strategyConfig;
    if (strategyConfig?.trailingStopPct) {
      // Best-effort regime classification for state. Pulls from the cached
      // regime layer used elsewhere in the cycle. Missing regime is fine —
      // recommendForHolding falls back to 'normal' bucket.
      let regime = null;
      try {
        const bars = await db.getRecentBars?.(h.symbol, 60).catch(() => null);
        if (bars && bars.length) {
          regime = regimeService.classifyRegime({ bars, indicators: null, newsSentiment: null });
        }
      } catch (_) {}
      const rec = await rlExecution.recommendForHolding({
        holding: h, currentPrice: price, regime, strategyConfig,
      });
      activeConfig = rec.adjustedConfig || strategyConfig;
    }

    // Ratchet trailing stop BEFORE evaluating the (possibly updated) stop.
    if (activeConfig?.trailingStopPct) {
      const update = riskManager.computeTrailingUpdate({ holding: h, currentPrice: price, strategyConfig: activeConfig });
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
    // Train the ML adaptive layer on flatten outcomes too — same audit-lookup path.
    recordMLOutcomeForClose({ symbol: h.symbol, strategy: strategyName, pnl: usdPnl }).catch(() => {});
    // RL close-attribution + memo clear — flatten is a real close.
    recordRLOutcomeForClose({ symbol: h.symbol, strategy: strategyName, pnl: usdPnl }).catch(() => {});
    try { rlExecution.clearAuditMemo(h.symbol, strategyName); } catch (_) {}
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
      // Force-flattens are real closes too — train the ML adaptive + regime
      // meta layers on them so circuit-breaker / kill-switch trades aren't
      // silently dropped from the learning ledger. Both layers self-attribute
      // to the originating BUY's stored feature vector + regime.
      recordMLOutcomeForClose({ symbol: h.symbol, strategy: h.strategy, pnl: usdPnl }).catch(() => {});
      // RL close-attribution + memo clear — emergency flatten is a real close.
      recordRLOutcomeForClose({ symbol: h.symbol, strategy: h.strategy, pnl: usdPnl }).catch(() => {});
      try { rlExecution.clearAuditMemo(h.symbol, h.strategy); } catch (_) {}
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

  // Pre-market briefing context — the service picks the right briefing (US or
  // ASX) based on the symbol and only injects during that market's first
  // 60min (US) / 90min (ASX) post-open window. Never throws; null = no inject.
  const premarket = await premarketService.getActiveBriefingContext(symbol);

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

  // --- Regime-aware meta-learning -----------------------------------------
  // Classify the current tape (high-vol / trending / mean-reverting / news /
  // low-liquidity / normal) from the indicators + bars + sentiment we already
  // have, then look up the per-regime track record to derive:
  //   • confidenceBoost (≥0) — TIGHTENS the quorum gate inside riskManager
  //   • regimeMult ∈ [0.85, 1.10] — sizing nudge stacked alongside mlMult
  // Both default to neutral until META_MIN_SAMPLES (=8) closes per bucket.
  let regime = null;
  let regimeAdjust = { regime: 'normal', confidenceBoost: 0, regimeMult: 1.0, basis: { n: 0 } };
  try {
    regime = regimeService.classifyRegime({ bars, indicators, newsSentiment });
    regimeAdjust = await metaLearning.getAdjustments(regime, sc.name);
  } catch (_) {}
  const regimeContext = regime
    ? regimeService.getPromptBlock(regime, regimeAdjust)
    : null;

  // --- Long-term knowledge graph -----------------------------------------
  // Pre-rendered per-symbol summary maintained by knowledgeGraphService —
  // sector context, peer set, earnings track, valuation, macro backdrop,
  // and a curated major-event timeline. Refreshed daily + on strong news.
  // Pure DB read here; never blocks trading on failure.
  let knowledgeContext = null;
  try { knowledgeContext = await knowledgeGraph.getPromptBlock(symbol); } catch (_) {}

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

  // Quantitative options-chain block — P/C ratio, IV avg, IV rank, IV skew,
  // unusual sweeps/blocks. Pulled from cache only here so the per-symbol
  // cycle never blocks on the chain fetch (refresh runs on its own 30-min
  // schedule + at startup). US-only.
  let optionsFlow = null;
  if (!isAsxSymbol) {
    try {
      const flow = optionsFlowService.getCached(symbol);
      if (flow) optionsFlow = optionsFlowService.renderForPrompt(flow);
    } catch (_) {}
  }

  // Macro-forecast block — cross-asset regime classification + 24-48h
  // forecast. Cache-only here so per-symbol cycles never block on the macro
  // refresh. Applies to BOTH US and ASX symbols (cross-asset signals are
  // global). Adjustments are wired into the riskManager via dynamic.macroAdjust
  // below — they can ONLY tighten the gate / shrink size, never the reverse.
  let macroForecast = null;
  let macroAdjustForRisk = null;
  try {
    const fc = macroForecastService.getCached();
    if (fc) {
      macroForecast = macroForecastService.renderForPrompt(fc);
      macroAdjustForRisk = {
        confidenceBoost: fc.adjust?.confidenceBoost || 0,
        sizeMult:        fc.adjust?.sizeMult || 1.0,
        regime:          fc.current?.regime,
        forecastRegime:  fc.forecast?.regime,
      };
    }
  } catch (_) {}

  // Self-play Monte-Carlo scenario sim — fuses recent bars + indicators +
  // regime + macro forecast + IV (when available) into a probability-weighted
  // 1-3d outlook. Pure JS; cached per-symbol on lastBarT so re-runs in the
  // same minute hit cache. Strictly informational — never votes / sizes /
  // gates anything; quorum + breaker + kill switch retain full veto power.
  let scenarioSim = null;
  try {
    const macroSnap = macroForecastService.getCached();
    const flowSnap = !isAsxSymbol ? optionsFlowService.getCached(symbol) : null;
    // barsPerDay heuristic from strategy cadence: day=1Min (~390 US/360 ASX),
    // swing=15Min (~26). Stops/targets pulled from the live strategy config.
    const barsPerDay = sc.cadenceSeconds && sc.cadenceSeconds >= 300 ? 26 : 390;
    const sim = scenarioSimService.simulate({
      symbol, bars, indicators,
      regime, macroForecast: macroSnap, optionsFlow: flowSnap,
      barsPerDay,
      stopLossPct: sc.stopLossPct, takeProfitPct: sc.takeProfitPct,
    });
    if (sim?.ok) scenarioSim = scenarioSimService.renderForPrompt(sim);
  } catch (_) {}

  // Causal-inference + counterfactual context for THIS (strategy × regime ×
  // market) bucket. Both are cached graphs refreshed on a 30-min cadence by
  // the boot-time scheduler below. Strictly informational — neither layer
  // can change the consensus, the gate, the size, or the breaker. Failures
  // here degrade silently to null blocks (LLMs simply don't see them).
  let causalContext = null, counterfactualContext = null, experienceContext = null;
  try {
    const g = await causalInference.getGraph({ strategy: sc.name, regime, market: info.market });
    causalContext = causalInference.renderForPrompt(g);
  } catch (_) {}
  try {
    const r = await counterfactual.getResults({ strategy: sc.name, regime, market: info.market });
    counterfactualContext = counterfactual.renderForPrompt(r);
  } catch (_) {}
  // Long-term memory / experience replay — top-K most similar past closed
  // trades for this (strategy, regime, indicator buckets) context. Featurises
  // the CURRENT decision context, runs cosine sim against the in-memory
  // cache, takes the top-5 with sim ≥ 0.6, and renders a balanced wins/
  // losses prompt block. Pure prior — never gates trades.
  try {
    const ind = indicators || {};
    const pat = patterns || {};
    const ns = newsSentiment;
    const matches = await memoryService.retrieveSimilar({
      strategy: sc.name,
      market: info.market,
      regime,
      direction: 'BUY',
      // Confidence/quorum aren't known yet (we're building the prompt, not
      // closing the loop) — leave at neutral defaults so retrieval keys
      // primarily off regime + indicators + market.
      confidence: 0.85,
      unanimousQuorum: false,
      rsi: ind.rsi,
      macdHistogram: ind.macd?.histogram,
      volRatio: ind.volume?.ratio,
      newsPolarity: typeof ns?.polarity === 'number' ? ns.polarity : (typeof ns === 'number' ? ns : null),
      breakout: pat.breakout,
      trend: pat.trend,
    }, { k: 5, minSim: 0.6 });
    experienceContext = memoryService.renderForPrompt(matches);
  } catch (_) {}
  // Cross-Market & Sector Propagation — top-K active propagation edges for
  // the symbol's (market × sector) bucket where the source bucket is
  // CURRENTLY in the conditioning state. Strictly informational priors.
  let propagationContext = null;
  try { propagationContext = propagationService.renderForPrompt(symbol); } catch (_) {}
  // Self-Supervised Market Pre-Training prior — pre-trained on years of
  // historical daily bars, fine-tuned on Alpha's own trade outcomes. Pure
  // informational prompt block; quorum + confidence gate retain full veto.
  let marketPriorContext = null;
  try { marketPriorContext = await marketPretrainService.renderForPrompt(symbol); } catch (_) {}
  // Human-in-the-Loop feedback — pre-rendered summary of recent USER ratings
  // + the bounded confidence-shrinkage factor for this (strategy, regime,
  // market) bucket. Both strictly informational/tightening; the shrinkage
  // factor is in [0.85, 1.00] and feeds the existing min() gate so it can
  // ONLY make the gate stricter, never relax it.
  let feedbackContext = null, feedbackShrinkage = 1.0;
  try {
    feedbackContext = await feedbackService.renderForPrompt({ strategy: sc.name, regime, market: info.market });
    feedbackShrinkage = await feedbackService.getConfidenceShrinkage({ strategy: sc.name, regime, market: info.market });
  } catch (_) {}

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

  // [Data Depth] Earnings-transcript summary block — Grok-generated 4-6
  // bullet structured summary of the most recent quarterly call (tone,
  // guidance, capex, Q&A surprises, forward catalysts). Cached per symbol
  // 30 days; cache-only read here so the per-symbol cycle never blocks on
  // a Grok call. The boot scheduler refreshes weekly + before earnings.
  // US-only (no transcripts for ASX in our pipeline).
  let earningsTranscript = null;
  if (!isAsxSymbol) {
    try {
      const tx = earningsTranscriptService.getCached(symbol);
      if (tx) earningsTranscript = earningsTranscriptService.renderForPrompt(tx);
    } catch (_) {}
  }

  // [Capital & Risk Capacity] Three new prompt-context blocks. All cache-only
  // reads (refreshers run on independent schedulers) so a slow downstream
  // never blocks the trading cycle. Strictly informational — no execution
  // path consumes any of these values.
  let varBlock = null;
  let hedgeBlock = null;
  let liquidityLine = null;
  try {
    const v = varStressService.getCached();
    if (v) varBlock = varStressService.renderForPrompt(v);
  } catch (_) {}
  try {
    const h = dynamicHedgingService.getCached();
    if (h) hedgeBlock = dynamicHedgingService.renderForPrompt(h);
  } catch (_) {}
  try {
    const liq = liquidityService.getCached(symbol);
    if (liq) liquidityLine = liquidityService.renderForPrompt(liq);
  } catch (_) {}

  // ---- LLM routing + skip cache (cost optimisation) -------------------
  // Decide tier (cheap vs escalated) and whether the previous HOLD can be
  // reused. See the comment block on _llmSkipCache for the safety contract.
  const escalateReasons = computeRoutingReasons({ holding, strategyName: sc.name, regime, intraday, newsSentiment, patterns });
  const escalate = escalateReasons.length > 0;
  const routingReason = escalate ? escalateReasons.join(',') : 'cheap_tier';

  const skipKey = `${sc.name}:${symbol}`;
  let signal;
  const skipCached = _llmSkipCache.get(skipKey);
  const priceDriftBps = skipCached
    ? Math.abs((latest - skipCached.price) / skipCached.price) * 10000
    : Infinity;
  const canSkip = (
    sc.name === 'day' &&
    !holding &&
    !escalate &&
    skipCached &&
    skipCached.signal.consensus === 'HOLD' &&
    Date.now() - skipCached.ts < LLM_SKIP_TTL_MS &&
    priceDriftBps < LLM_SKIP_PRICE_BPS
  );

  // Quiet-market shortcut runs BEFORE the skip-cache check — it doesn't
  // need a prior cached signal, just a sleepy regime + neutral news + no
  // setup. Catches the long tail of names that aren't in cache yet.
  const quietSignal = tryQuietMarketShortcut({ strategyName: sc.name, holding, escalate, regime, newsSentiment, patterns, intraday });
  if (quietSignal) {
    perfMetrics.ensembleQuietSkipped++;
    signal = quietSignal;
  } else if (canSkip) {
    perfMetrics.ensembleSkipped++;
    signal = {
      ...skipCached.signal,
      _skippedFromCache: true,
      _cacheAgeMs: Date.now() - skipCached.ts,
      reason: `[skip-cache] ${skipCached.signal.reason} (age ${((Date.now() - skipCached.ts)/1000).toFixed(0)}s, drift ${priceDriftBps.toFixed(1)}bps)`,
    };
  } else {
    perfMetrics.ensembleCalls++;
    if (escalate) perfMetrics.ensembleEscalated++;
    signal = await llmService.getEnsembleDecision({
      symbol, priceData, sentiment, newsSentiment, holding, portfolio,
      patterns, fundamentals, indicators, intraday, historical,
      strategyName: sc.name, premarket,
      adaptiveHints, portfolioRisk: portfolioRiskBlock, orderFlow, optionsActivity, optionsFlow, earningsSignal,
      earningsTranscript,
      // [Capital & Risk Capacity] new prompt-context blocks
      varStress: varBlock, dynamicHedging: hedgeBlock, liquidityProfile: liquidityLine,
      regimeContext, knowledgeContext, macroForecast, scenarioSim,
      // Dynamic-weighting + meta-reasoner context. Both are strictly
      // informational; raw quorum + confidence gate retain full veto.
      regime, market: info.market,
      // Causal + counterfactual + experience-replay + cross-market propagation
      // prompt blocks. Pre-rendered text or null — all strictly informational,
      // never gating.
      causalContext, counterfactualContext, experienceContext, propagationContext,
      // Human-in-the-Loop layer: prompt summary + bounded shrinkage factor.
      // Both can ONLY tighten the existing gate, never relax it.
      feedbackContext, feedbackShrinkage,
      // Self-Supervised Market Pre-Training prior. Strictly informational.
      marketPriorContext,
      // Tier routing — cheap by default; agent decides when to escalate.
      escalate, routingReason,
    });
    // Cache only flat HOLDs with no open position. BUY/SELL and held
    // positions must always re-evaluate fresh on the next cycle.
    if (signal.consensus === 'HOLD' && !holding) {
      _llmSkipCache.set(skipKey, { signal, ts: Date.now(), price: latest });
      // Bound cache size so a long-running process doesn't leak.
      if (_llmSkipCache.size > 256) {
        const oldest = _llmSkipCache.keys().next().value;
        _llmSkipCache.delete(oldest);
      }
    } else {
      _llmSkipCache.delete(skipKey);
    }
  }

  // Pre-compute ML features here too so the SIGNAL audit always carries them
  // (even for HOLD/SELL signals) — that lets close-time recordOutcome replay
  // the *exact* feature vector the model would have predicted on at entry.
  let _mlFeaturesForAudit = null;
  try {
    _mlFeaturesForAudit = mlAdaptive.extractFeatures({
      signal, newsSentiment, indicators,
      strategyName: sc.name, market: info.market, regime,
    });
  } catch (_) {}

  await db.recordAudit({
    event_type: 'SIGNAL', symbol, decision: signal.consensus, confidence: signal.confidence,
    models: signal.models,
    payload: { priceData, sentiment, newsSentiment, indicators, patterns, fundamentals, intraday,
      historicalAvailable: !!historical,
      votes: signal.votes, reason: signal.reason, strategy: sc.name,
      ml_features: _mlFeaturesForAudit,
      regime, regime_adjust: regimeAdjust,
      // Dynamic-weighting + meta-reasoner audit fields — informational only,
      // never gate trading. Surfaced for the dashboard + post-hoc review.
      raw_confidence: signal.rawConfidence,
      weighted_consensus: signal.weightedConsensus,
      weighted_confidence: signal.weightedConfidence,
      weighted_votes: signal.weightedVotes,
      ensemble_weights: signal.weights,
      weight_context: signal.weightContext,
      meta_opinion: signal.meta,
      // Compact tags for the dashboard so it can show "this signal saw a
      // causal block" / "saw a counterfactual hint" without re-resolving
      // the whole context bucket.
      causal_seen: !!causalContext,
      counterfactual_seen: !!counterfactualContext,
      // Tier-routing audit — informational only, never gates trading.
      llm_pool: signal.pool || null,
      llm_escalated: !!signal.escalated,
      llm_routing_reason: signal.routingReason || routingReason,
      llm_skipped_from_cache: !!signal._skippedFromCache,
      llm_skipped_quiet_market: !!signal._skippedQuietMarket,
      llm_cache_age_ms: signal._cacheAgeMs || null },
  });

  // Tag signal with market+currency so the dashboard can filter US vs ASX
  // without re-deriving from symbol on every render.
  const _sigInfo = marketRegistry.getSymbolInfo(symbol);
  memoryState.lastSignals[`${sc.name}:${symbol}`] = {
    symbol, strategy: sc.name, timestamp: new Date().toISOString(),
    price: latest, change: `${change}%`,
    market: _sigInfo.market, currency: _sigInfo.currency,
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
    // ML adaptive layer — predicts P(win) and an R-multiple from the same
    // decision context the LLMs saw, then maps the R-multiple to a sizing
    // multiplier in [0.85, 1.15]. During cold-start (n_updates < MIN_TRAIN)
    // mlMult=1.0 so the agent runs identically to before.
    let mlPrediction = { mlMult: 1.0, pWin: null, rPred: null, trained: false };
    let mlFeatures = null;
    try {
      mlFeatures = mlAdaptive.extractFeatures({
        signal, newsSentiment, indicators,
        strategyName: sc.name, market: info.market, regime,
      });
      mlPrediction = await mlAdaptive.predict(mlFeatures);
    } catch (_) { /* swallow — never block trading */ }

    const dynamicWithUpgrades = {
      ...(dynamic || {}),
      adaptiveMult, portfolioMult,
      mlMult: mlPrediction.mlMult,
      regimeAdjust,    // riskManager applies the gate-tightening + sizing mult
      // Macro-forecast layer — additively tightens the confidence gate AND
      // shrinks size. Hard-clamped in riskManager: boost ≥ 0, sizeMult ≤ 1.0.
      macroAdjust: macroAdjustForRisk || undefined,
    };
    // [Upgrade #4] Atomic BUY critical section — re-read fresh cash +
    // holdings, run evaluateBuy, AND executeOrder all under a single lock
    // acquisition. This is the only way to prevent a parallel ASX bucket
    // from observing pre-deduction cash between our evaluate and our
    // adjustCash. Equity drift within a cycle is bounded (few orders max)
    // and the daily-loss budget + 5% breaker were already validated at
    // cycle start, so reusing `equity` here is safe.
    await withExecutionLock(async () => {
      const _portFresh = await db.getPortfolio();
      const _cashNow   = Number.isFinite(parseFloat(_portFresh.cash_balance))
        ? parseFloat(_portFresh.cash_balance) : cash;
      const _allHFresh = await db.getHoldings();
      const eval_ = await riskManager.evaluateBuy({
        symbol, signal, price: latestUsd, equity, cash: _cashNow, holdings: _allHFresh,
        strategyConfig: sc, dynamic: dynamicWithUpgrades,
      });
      if (!eval_.allow) {
        await db.recordAudit({ event_type: 'TRADE_REJECTED', symbol, decision: 'BUY',
          confidence: signal.confidence, payload: { reason: eval_.reason, strategy: sc.name, market: info.market } });
        return;
      }
      const sz = eval_.sizing || {};
      // Convert USD-equivalent stop/take back to NATIVE for broker + storage.
      // For US (fxToUsd === 1) this is a no-op.
      const nativeStop = eval_.stop_loss   / fxToUsd;
      const nativeTake = eval_.take_profit / fxToUsd;
      const mlTag = mlPrediction.trained
        ? ` | ml mult=${mlPrediction.mlMult.toFixed(2)} pWin=${(mlPrediction.pWin * 100).toFixed(0)}%`
        : '';
      const regimeTag = regime ? ` | regime=${regime.primary}` +
        (regimeAdjust.confidenceBoost ? ` (+${(regimeAdjust.confidenceBoost*100).toFixed(0)}pp gate)` : '') +
        (regimeAdjust.regimeMult !== 1 ? ` ×${regimeAdjust.regimeMult.toFixed(2)} size` : '') : '';
      const macroTag = macroAdjustForRisk ? ` | macro=${macroAdjustForRisk.regime}→${macroAdjustForRisk.forecastRegime}` +
        (macroAdjustForRisk.confidenceBoost ? ` (+${(macroAdjustForRisk.confidenceBoost*100).toFixed(1)}pp gate)` : '') +
        (macroAdjustForRisk.sizeMult < 1 ? ` ×${macroAdjustForRisk.sizeMult.toFixed(2)} size` : '') : '';
      await executeOrder({
        symbol, side: 'BUY', qty: eval_.qty, price: latest,
        signal,
        stop_loss:   parseFloat(nativeStop.toFixed(4)),
        take_profit: parseFloat(nativeTake.toFixed(4)),
        reason: `${signal.reason} | risk $${eval_.riskUSD}` +
          (sz.compoundMult ? ` (×${sz.compoundMult.toFixed(2)} growth·perf, ${(sz.confFraction*100).toFixed(0)}% conf-band)` : '') +
          mlTag + regimeTag + macroTag +
          (info.currency !== 'USD' ? ` | fx ${info.currency}/USD=${fxToUsd.toFixed(4)}` : ''),
        strategy: sc.name,
        market: info.market, currency: info.currency, fxToUsd,
        mlFeatures, riskUSD: eval_.riskUSD, regime,
      });
    });
  } else if (signal.consensus === 'SELL') {
    // [Upgrade #4] Atomic SELL critical section — evaluateSell needs the
    // freshest holdings (a parallel bucket may have just sold the same
    // symbol), and executeOrder calls adjustCash which the other bucket
    // reads. Both inside one lock acquisition.
    await withExecutionLock(async () => {
      const _allHFresh = await db.getHoldings();
      const eval_ = await riskManager.evaluateSell({ symbol, signal, holdings: _allHFresh, strategyConfig: sc });
      if (!eval_.allow) {
        await db.recordAudit({ event_type: 'TRADE_REJECTED', symbol, decision: 'SELL',
          confidence: signal.confidence, payload: { reason: eval_.reason, strategy: sc.name, market: info.market } });
        return;
      }
      await executeOrder({
        symbol, side: 'SELL', qty: eval_.qty, price: latest,
        signal, reason: signal.reason, strategy: sc.name,
        market: info.market, currency: info.currency, fxToUsd,
      });
    });
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
        await handleBreakerTrip({ cb: cb2, portfolio, equity: live.equity, where: `mid-cycle:${sc.name}` });
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
  // [Upgrade #4] perf — wall-clock per cycle so the watchdog and /api/perf
  // can spot slowdowns or hangs.
  const cycleT0 = Date.now();
  perfMetrics.lastCycleStartedAt = cycleT0;
  perfMetrics.cycles++;
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
      await handleBreakerTrip({ cb, portfolio, equity, where: 'pre-cycle' });
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
    sentimentService.getSentimentBatch(allWatchlistSymbols, { concurrency: 3 })
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
    // [Upgrade #4 / Scale & Speed] Run US-bucket and ASX-bucket strategies
    // CONCURRENTLY. Within the US bucket, day + swing remain SEQUENTIAL (they
    // share the US watchlist and the same circuit-breaker / cash account, so
    // back-to-back execution avoids a race where two strategies both think
    // there's enough cash for the same buy). The ASX bucket is fully
    // independent (separate broker, separate symbols, separate market hours)
    // so it always runs in parallel with US — meaningful when ASX evening
    // overlaps US morning, and zero-cost when only one market is open.
    const eligibleStrategies = strategies.filter(s => {
      if (!s.enabled || !s.marketOpen) return false;
      const lastRun = memoryState.strategyLastRun[s.sc.name];
      const elapsed = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 1000 : Infinity;
      return elapsed >= s.sc.intervalSeconds - 5;
    });
    const usBucket = eligibleStrategies.filter(s => s.sc.name !== 'asx_swing');
    const asxBucket = eligibleStrategies.filter(s => s.sc.name === 'asx_swing');

    const runBucketSequential = async (bucket) => {
      for (const { sc, clock: stratClock } of bucket) {
        const t0 = Date.now();
        await runStrategy(sc, portfolio, stratClock, usdFullLookup, dynamic);
        const dt = Date.now() - t0;
        if (!perfMetrics.strategyDurationsMs[sc.name]) perfMetrics.strategyDurationsMs[sc.name] = [];
        _pushBounded(perfMetrics.strategyDurationsMs[sc.name], dt);
      }
    };
    await Promise.all([
      runBucketSequential(usBucket),
      runBucketSequential(asxBucket),
    ]);

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

    // Continuous online learning — per-bar tick. Folds realized 1-bar
    // returns into per-(model, ctx) calibration buffers and applies tiny
    // SGD updates to weight-deltas + threshold-deltas. Best-effort, never
    // throws. Strictly additive — cannot affect quorum, gates, or risk.
    // Reuses the cycle's already-fetched usdFullLookup (USD-equivalent
    // live prices for every symbol the cycle touched) so we don't double
    // up on broker quote calls.
    try {
      const allHForLearn = await db.getHoldings();
      if (allHForLearn.length > 0) {
        const priceLookup = {};
        for (const h of allHForLearn) {
          const px = usdFullLookup?.[h.symbol];
          if (Number.isFinite(px)) priceLookup[h.symbol] = { price: Number(px) };
        }
        await continuousLearning.onBarTick({
          holdings: allHForLearn,
          priceLookup,
          regime: portfolio.last_regime || 'unknown',
          market: 'US',
        });
      }
    } catch (e) { console.error('[ContinuousLearning] tick swallowed:', e.message); }

    memoryState.lastError = null;
    console.log(`[Agent] Cycle ${memoryState.cycleCount} complete`);
  } catch (e) {
    memoryState.lastError = e.message;
    console.error('[Agent] Cycle error:', e);
    await db.recordAudit({ event_type: 'CYCLE_ERROR', payload: { error: e.message, stack: e.stack } });
  } finally {
    const dt = Date.now() - cycleT0;
    perfMetrics.lastCycleMs = dt;
    perfMetrics.lastCycleFinishedAt = Date.now();
    _pushBounded(perfMetrics.cycleDurationsMs, dt);
    cycleInProgress = false;
    tradingLock = false;
  }
}

// =============================================================================
// [Upgrade #4 / Scale & Speed] Watchdog — auto-restart on hung cycles.
// =============================================================================
// If a cycle never completes (deadlock, broker timeout cascade, runaway
// promise) the agent stops trading silently. The watchdog catches that:
// when a cycle has been "in progress" for more than WATCHDOG_HUNG_MS without
// completing, we log + audit + `process.exit(1)`. On Replit, the workflow
// auto-restarts on non-zero exit, giving us a clean recovery. SAFETY: this
// runs OUTSIDE the trading loop and uses an independent timer; it cannot be
// blocked by whatever is blocking the cycle. Threshold is 5 minutes — well
// past any legitimate cycle even with all four LLMs slow-pathing.
const WATCHDOG_HUNG_MS = parseInt(process.env.WATCHDOG_HUNG_MS || '300000');
const WATCHDOG_INTERVAL_MS = 30_000;
let _watchdogHandle = null;
function startWatchdog() {
  if (_watchdogHandle) return;
  _watchdogHandle = setInterval(() => {
    if (!cycleInProgress) return;
    const startedAt = perfMetrics.lastCycleStartedAt;
    if (!startedAt) return;
    const age = Date.now() - startedAt;
    if (age > WATCHDOG_HUNG_MS) {
      perfMetrics.watchdogResets++;
      const msg = `[Watchdog] Cycle hung for ${(age/1000).toFixed(0)}s (> ${WATCHDOG_HUNG_MS/1000}s) — exiting for auto-restart`;
      console.error(msg);
      try { db.recordAudit({ event_type: 'WATCHDOG_RESTART', payload: { ageMs: age, threshold: WATCHDOG_HUNG_MS } }); } catch (_) {}
      // Give the audit a moment to flush, then exit. Replit workflow will
      // restart us automatically.
      setTimeout(() => process.exit(1), 1000);
    }
  }, WATCHDOG_INTERVAL_MS);
  if (_watchdogHandle.unref) _watchdogHandle.unref();
  console.log(`[Watchdog] Started — hang threshold ${WATCHDOG_HUNG_MS/1000}s`);
}
startWatchdog();

// Process-level safety nets. unhandledRejection used to kill the process by
// default; we log + audit, but DO NOT exit here (the watchdog will catch a
// truly stuck cycle). For uncaughtException, exit so the workflow restarts.
process.on('unhandledRejection', (reason) => {
  console.error('[Process] unhandledRejection:', reason);
  try { db.recordAudit({ event_type: 'UNHANDLED_REJECTION', payload: { message: String(reason?.message || reason) } }); } catch (_) {}
});
process.on('uncaughtException', (err) => {
  console.error('[Process] uncaughtException — exiting for auto-restart:', err);
  try { db.recordAudit({ event_type: 'UNCAUGHT_EXCEPTION', payload: { message: err?.message, stack: err?.stack } }); } catch (_) {}
  setTimeout(() => process.exit(1), 500);
});

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

// Centralized breaker-trip handler — used by BOTH the pre-cycle check in
// runCycle AND the mid-cycle check inside runStrategy so every genuine trip
// produces an alert + flatten. Discord send is best-effort: a webhook failure
// must NEVER block flattening.
async function handleBreakerTrip({ cb, portfolio, equity, where }) {
  try {
    const cfg = riskManager.getConfig(portfolio);
    await discordService.sendBreakerTrippedAlert({
      reason: `${cb.reason || `Drawdown ${(cb.drawdown * 100).toFixed(2)}%`} (${where})`,
      drawdownPct: cb.drawdown,
      dayStartEquity: parseFloat(portfolio.day_start_equity),
      equity,
      thresholdPct: cfg.maxDailyDrawdownPct,
      lossUSD: cb.lossUSD,
      mode: portfolio.trading_mode,
    });
  } catch (e) { console.error('[Discord] tripped alert failed:', e.message); }
  await flattenAllPositions(cb.reason || 'Circuit breaker tripped');
}

async function resetCircuitBreaker(source = 'operator') {
  const holdings = await db.getHoldings();
  const priceMap = await buildPriceLookup(holdings);
  // USD-equivalent — day_start_equity is stored in USD.
  const { equity, portfolio } = await riskManager.computeEquity(holdings, priceMap.usdLookup);
  await db.updatePortfolio({ circuit_breaker: false, day_start_equity: equity.toFixed(2) });
  await db.recordAudit({ event_type: 'CIRCUIT_BREAKER_RESET', payload: { newDayStart: equity, source } });
  try {
    await discordService.sendBreakerResetAlert({
      newDayStartEquity: equity,
      mode: portfolio?.trading_mode,
      source,
    });
  } catch (e) { console.error('[Discord] reset alert failed:', e.message); }
}

async function setAutoBreakerReset(enabled) {
  await db.updatePortfolio({ auto_breaker_reset: !!enabled });
  await db.recordAudit({
    event_type: 'BREAKER_AUTO_RESET_CHANGED',
    payload: { enabled: !!enabled, note: 'Only takes effect in paper mode; live mode never auto-resets.' },
  });
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
  const { equity, portfolio } = await riskManager.computeEquity(holdings, priceMap.usdLookup);
  // The daily PnL anchor is ALWAYS rolled forward — that's a hard requirement
  // for the daily-loss budget math. The breaker, however, is only auto-cleared
  // when the operator has opted in AND we're in paper mode. Live mode NEVER
  // auto-resets a tripped breaker — operator must do it explicitly.
  const wasTripped = !!portfolio.circuit_breaker;
  const mode = portfolio.trading_mode || 'paper';
  const autoResetOptedIn = portfolio.auto_breaker_reset !== false;
  const shouldAutoReset = wasTripped && autoResetOptedIn && mode === 'paper';
  const update = { day_start_equity: equity.toFixed(2) };
  if (shouldAutoReset) update.circuit_breaker = false;
  await db.updatePortfolio(update);
  await db.recordAudit({
    event_type: 'DAILY_RESET',
    payload: { dayStartEquity: equity, breakerWasTripped: wasTripped, breakerAutoReset: shouldAutoReset, mode },
  });
  if (shouldAutoReset) {
    try {
      await discordService.sendBreakerResetAlert({ newDayStartEquity: equity, mode, source: 'daily-auto-reset' });
    } catch (e) { console.error('[Discord] daily auto-reset alert failed:', e.message); }
  }
  console.log(`[Agent] Daily reset — new day-start equity: $${equity.toFixed(2)}` +
    (wasTripped ? (shouldAutoReset ? ' | breaker auto-reset (paper)' : ' | breaker LEFT TRIPPED (live or opt-out)') : ''));
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

// Build a {symbol → spot} map for the options-flow batch. Uses the most
// recent 1-min bar close (cheap; the cycle already pulls these). Best-effort
// per symbol — missing entries simply skip flow refresh for that name.
async function buildSpotLookup(symbols) {
  const out = {};
  for (const s of symbols) {
    try {
      const bars = await alpacaService.getBars(s, '1Min', 1);
      const last = Array.isArray(bars) && bars.length ? bars[bars.length - 1] : null;
      const px = last?.c ?? last?.close ?? null;
      if (px) out[s] = px;
    } catch (_) {}
  }
  return out;
}

// Real options-chain refresh (Alpaca snapshot endpoint). Runs every 30 min
// during US market hours. Needs a spot-price lookup so each symbol gets a
// near-money strike filter — pulled from the in-memory price snapshot the
// cycle already builds, falling back to a fresh getLatestQuote per symbol
// if the snapshot is empty.
let optionsFlowHandle = null;
function scheduleOptionsFlowRefresh() {
  if (optionsFlowHandle) clearInterval(optionsFlowHandle);
  optionsFlowHandle = setInterval(async () => {
    if (!memoryState.marketOpen) return;
    try {
      const spotLookup = await buildSpotLookup(WATCHLIST);
      await optionsFlowService.refreshBatch(WATCHLIST, spotLookup);
    } catch (e) { console.error('[OptionsFlow] Batch refresh failed:', e.message); }
  }, 30 * 60 * 1000);
}

// [Data Depth] Earnings-transcript refresh — quarterly cadence with a
// near-earnings sweep. Boots warm a small batch on first start; subsequent
// scheduled runs target stale entries + names within ~5 days of earnings.
// US-only (we don't have ASX transcript coverage).
let earningsTranscriptHandle = null;
function scheduleEarningsTranscriptRefresh() {
  if (earningsTranscriptHandle) clearInterval(earningsTranscriptHandle);
  // Run every 12h during US market hours. Each call hits Grok serially with
  // a small inter-symbol delay (250ms) inside refreshBatch.
  earningsTranscriptHandle = setInterval(async () => {
    if (!memoryState.marketOpen) return;
    try {
      const usSymbols = WATCHLIST.filter(s => {
        try { return marketRegistry.getSymbolInfo(s).market === 'US'; }
        catch (_) { return false; }
      });
      // Pull near-earnings days from fundamentals so we can force-refresh
      // pre-print. fundamentalsService stores `earnings_next_date`.
      const nearLookup = {};
      for (const s of usSymbols) {
        try {
          const f = fundamentalsService.getCached(s);
          const dt = f?.earnings_next_date;
          if (dt) {
            const days = Math.floor((new Date(dt).getTime() - Date.now()) / 86400000);
            if (Number.isFinite(days)) nearLookup[s] = days;
          }
        } catch (_) {}
      }
      // Refresh in two passes: imminent earnings first (within 5d), then the
      // rest. Limits: at most 12 symbols per scheduled tick to bound XAI
      // usage. Stale entries beyond that wait for the next tick.
      const imminent = usSymbols.filter(s => Number.isFinite(nearLookup[s]) && nearLookup[s] >= 0 && nearLookup[s] < 5);
      const others = usSymbols.filter(s => !imminent.includes(s));
      const batch = [...imminent, ...others].slice(0, 12);
      for (const s of batch) {
        try {
          await earningsTranscriptService.getOrRefresh(s, { nearEarningsDays: nearLookup[s] });
        } catch (_) {}
      }
    } catch (e) { console.error('[EarningsTranscript] Batch refresh failed:', e.message); }
  }, 12 * 60 * 60 * 1000);
}

// --- Macro-forecast refresh -----------------------------------------------
// Cross-asset factor snapshot is refreshed every 60 minutes during US market
// hours. Macro signals move on the daily timescale, so an hourly cadence is
// plenty — and it lets the snapshot always reflect the most recent close.
let macroForecastHandle = null;
function scheduleMacroForecastRefresh() {
  if (macroForecastHandle) clearInterval(macroForecastHandle);
  macroForecastHandle = setInterval(async () => {
    if (!memoryState.marketOpen) return;
    try {
      await macroForecastService.getForecast();
    } catch (e) { console.error('[Macro] Refresh failed:', e.message); }
  }, 60 * 60 * 1000);
}

// --- Long-term knowledge graph — daily refresh ----------------------------
// Runs once per day at ~08:00 UTC (~03:00-04:00 ET, well before US open and
// after Sydney close). Pulls cached fundamentals + sentiment per symbol and
// writes a refreshed per-symbol blob + pre-rendered prompt summary into
// company_knowledge. The refresh itself is best-effort and bounded to 2x
// concurrent LLM calls — never blocks trading on failure.
let kgDailyHandle = null;
function scheduleDailyKnowledgeGraph() {
  if (kgDailyHandle) clearTimeout(kgDailyHandle);
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(8, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  kgDailyHandle = setTimeout(async () => {
    try {
      const r = await knowledgeGraph.refreshAll({ concurrency: 2 });
      console.log(`[KG] Daily refresh: ok=${r.ok}/${r.total} errs=${r.err}`);
    } catch (e) { console.error('[KG] Daily refresh failed:', e.message); }
    scheduleDailyKnowledgeGraph();
  }, next - now);
  console.log(`[KG] Next daily refresh in ${Math.round((next - now) / 60000)} min`);
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

  const breakerCfg = riskManager.getConfig(portfolio);
  const drawdownPctLive = dayStart > 0 ? Math.max(0, (dayStart - equity) / dayStart) : 0;
  return {
    mode: tradingMode,
    liveAvailable: alpacaService.hasLiveCredentials(),
    running: portfolio.agent_running,
    emergencyPause: portfolio.emergency_pause,
    circuitBreakerTripped: portfolio.circuit_breaker,
    breakerConfig: {
      maxDailyDrawdownPct: breakerCfg.maxDailyDrawdownPct,
      maxDailyLossUSD:     breakerCfg.maxDailyLossUSD,
      envCapUSD:           breakerCfg.envCapUSD,
      autoResetEnabled:    portfolio.auto_breaker_reset !== false,
      autoResetActiveInMode: tradingMode === 'paper',
      currentDrawdownPct:  drawdownPctLive,
      currentLossUSD:      dailyLossUSD,
      dayStartEquity:      dayStart,
      configuredVia:       'MAX_DAILY_DRAWDOWN_PCT secret (default 0.05)',
    },
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
scheduleDailyKnowledgeGraph();
// Boot-time non-blocking warm-up — kicks off the first refresh once the
// fundamentals + sentiment caches start landing. Skips symbols that are
// already fresh (TTL gate inside refreshSymbol).
setTimeout(() => {
  knowledgeGraph.refreshAll({ concurrency: 2 })
    .then(r => console.log(`[KG] Boot warm-up: ok=${r.ok}/${r.total} errs=${r.err}`))
    .catch(e => console.error('[KG] Boot warm-up failed:', e.message));
}, 30_000);
// Warm adaptive cache + options activity once at startup so the first cycle
// has fresh context. Both are best-effort and never block boot.
adaptiveLearning.recomputeFromHistory()
  .then(r => console.log(`[Adaptive] Startup recompute: ${r.symbolBuckets} symbols, ${r.modelBuckets} models from ${r.sourceCloses} closes`))
  .catch(e => console.error('[Adaptive] Startup recompute failed:', e.message));
optionsActivityService.refreshBatch(WATCHLIST)
  .then(() => console.log(`[OptionsActivity] Startup batch refreshed for ${WATCHLIST.length} symbols`))
  .catch(e => console.error('[OptionsActivity] Startup refresh failed:', e.message));

// Quantitative options-flow + IV warm-up. Delayed 60s so the price-bar API
// isn't slammed at boot alongside everything else.
setTimeout(() => {
  buildSpotLookup(WATCHLIST)
    .then(spot => optionsFlowService.refreshBatch(WATCHLIST, spot))
    .then(() => console.log(`[OptionsFlow] Startup batch refreshed for ${WATCHLIST.length} symbols`))
    .catch(e => console.error('[OptionsFlow] Startup refresh failed:', e.message));
}, 60_000);
scheduleOptionsFlowRefresh();

// Macro-forecast warm-up — delayed 75s so the daily-bar API isn't slammed at
// boot alongside the options-flow refresh. Runs once at startup, then the
// interval scheduler takes over.
setTimeout(() => {
  macroForecastService.getForecast()
    .then(d => {
      const r = d?.current?.regime, f = d?.forecast?.regime, c = d?.forecast?.confidence;
      console.log(`[Macro] Startup forecast: now=${r} → 24-48h=${f} (conf ${(c * 100).toFixed(0)}%)`);
    })
    .catch(e => console.error('[Macro] Startup forecast failed:', e.message));
}, 75_000);
scheduleMacroForecastRefresh();

// [Data Depth] Earnings-transcript warm-up — delayed 105s. Initial batch
// targets the first 6 US watchlist symbols only so we don't burn a chunk
// of XAI quota at boot; the 12h scheduler picks up the rest opportunistically.
setTimeout(() => {
  (async () => {
    try {
      const usSyms = WATCHLIST.filter(s => {
        try { return marketRegistry.getSymbolInfo(s).market === 'US'; }
        catch (_) { return false; }
      }).slice(0, 6);
      let warmed = 0;
      for (const s of usSyms) {
        try { if (await earningsTranscriptService.getOrRefresh(s)) warmed += 1; }
        catch (_) {}
      }
      console.log(`[EarningsTranscript] Startup warmed ${warmed}/${usSyms.length} symbols`);
    } catch (e) { console.error('[EarningsTranscript] Startup failed:', e.message); }
  })();
}, 105_000);
scheduleEarningsTranscriptRefresh();

// [Capital & Risk Capacity / Upgrade #3] Three independent schedulers, all
// purely additive prompt context. Failures swallow to null — no scheduler
// failure can crash the trading loop or bypass safety rails.
//
// VaR + stress + dynamic-hedging refresh: portfolio-level, every 30 min during
// market hours. Pulls current holdings, current USD prices, current portfolio
// equity + daily loss budget, and computes:
//   • Historical VaR (1d, 95%/99%) from synthetic portfolio returns
//   • Monte-Carlo VaR (5000 sims, normal-fit μ/σ)
//   • Stress scenarios (market crash, vol spike, rates up, crypto crash, etc.)
//   • Dynamic hedging suggestions derived from VaR + concentration + regime
let varHedgingHandle = null;
async function refreshVarAndHedging() {
  try {
    const allH = await db.getHoldings();
    const pmap = await buildPriceLookup(allH);
    const { equity, portfolio } = await riskManager.computeEquity(allH, pmap.usdLookup);
    const dailyLossBudget = riskManager.effectiveDailyLossBudget(portfolio);
    const varSnap = await varStressService.refresh(allH, pmap.usdLookup, equity, dailyLossBudget);
    const macroData = (() => { try { return macroForecastService.getCachedRaw?.(); } catch (_) { return null; } })();
    const macroRegime = macroData?.current?.regime || macroData?.regime || null;
    // Realised intraday loss utilization vs the same daily budget. Used to
    // surface the "we're already deep into the budget" advisory line.
    const dayStart = parseFloat(portfolio?.day_start_equity || equity);
    const realisedLossUSD = Math.max(0, dayStart - equity);
    const lossUtil = dailyLossBudget > 0 ? +(realisedLossUSD / dailyLossBudget * 100).toFixed(1) : null;
    await dynamicHedgingService.refresh(allH, pmap.usdLookup, varSnap, macroRegime, lossUtil);
  } catch (e) { console.error('[VaRStress/Hedging] refresh failed:', e.message); }
}
function scheduleVarHedgingRefresh() {
  if (varHedgingHandle) clearInterval(varHedgingHandle);
  varHedgingHandle = setInterval(() => {
    if (!memoryState.marketOpen) return;
    refreshVarAndHedging();
  }, 30 * 60 * 1000);
}

// Liquidity refresh: per-symbol ADV + spread proxy. Computed from
// already-cached daily bars (`historical_intelligence`), so no extra API
// calls. 4-hour cadence — ADV moves slowly. 12 symbols/tick to bound work.
let liquidityHandle = null;
let liquidityCursor = 0;
function scheduleLiquidityRefresh() {
  if (liquidityHandle) clearInterval(liquidityHandle);
  liquidityHandle = setInterval(async () => {
    if (!memoryState.marketOpen) return;
    try {
      const batch = [];
      for (let i = 0; i < 12 && liquidityCursor < WATCHLIST.length; i++, liquidityCursor++) {
        batch.push(WATCHLIST[liquidityCursor]);
      }
      if (liquidityCursor >= WATCHLIST.length) liquidityCursor = 0;
      if (batch.length) await liquidityService.refreshBatch(batch);
    } catch (e) { console.error('[Liquidity] Batch refresh failed:', e.message); }
  }, 60 * 60 * 1000); // 1h tick × 12 syms = full 30 syms in ~3h, refreshed every ~6-8h
}

// Warm-ups: VaR/hedging (delayed 120s — needs holdings + price lookup +
// historical intelligence to be loaded), liquidity (delayed 135s).
setTimeout(() => {
  refreshVarAndHedging()
    .then(() => {
      const v = varStressService.getCached();
      if (v?.ok) {
        const h95 = v.historicalVaR?.confidence_95?.lossUSD;
        console.log(`[VaRStress] Startup snapshot: 1d 95% VaR -$${h95?.toFixed(0) ?? '?'}, util ${v.varUtilizationPct ?? '?'}%, contributors ${v.contributors}`);
      } else {
        console.log(`[VaRStress] Startup snapshot: ${v?.reason || 'unavailable'}`);
      }
    })
    .catch(e => console.error('[VaRStress] Startup failed:', e.message));
}, 120_000);
scheduleVarHedgingRefresh();

setTimeout(async () => {
  try {
    const r = await liquidityService.refreshBatch(WATCHLIST.slice(0, 12));
    console.log(`[Liquidity] Startup batch refreshed ${r.refreshed}/${r.total}`);
  } catch (e) { console.error('[Liquidity] Startup failed:', e.message); }
}, 135_000);
scheduleLiquidityRefresh();

// Causal-inference + counterfactual warm-up — delayed 90s so the audit_log
// + trades joins don't pile on with the other startup queries. Runs once at
// startup, then every 30 min. Both refreshes are independent, mutually
// non-blocking, and silently swallow failures so a learning hiccup can
// never break the trading loop.
setTimeout(() => {
  // force:true so the warm-up call always runs even though the module-load
  // timestamp would otherwise throttle it. The interval below uses the
  // default (non-forced) TTL-gated path so re-entrancy stays safe.
  causalInference.refresh({ force: true })
    .then(r => console.log(`[Causal] Startup refresh: built ${r.bucketsBuilt} buckets from ${r.totalCloses} closes`))
    .catch(e => console.error('[Causal] Startup refresh failed:', e.message));
  counterfactual.refresh({ force: true })
    .then(r => console.log(`[Counterfactual] Startup refresh: built ${r.bucketsBuilt} buckets from ${r.totalCloses} closes`))
    .catch(e => console.error('[Counterfactual] Startup refresh failed:', e.message));
}, 90_000);
setInterval(() => {
  causalInference.refresh().catch(() => {});
  counterfactual.refresh().catch(() => {});
}, 30 * 60 * 1000);

// Intelligent Safety Suggestion Layer warm-up — delayed 120s so it runs
// AFTER the counterfactual layer (which it consumes for additional evidence)
// has had a chance to populate its first cache. Suggestion generation never
// applies anything automatically; it only writes pending rows to the
// safety_suggestions table for the user to review and approve in the UI.
async function _resolveSafetyContext() {
  const portfolio = await db.getPortfolio().catch(() => null);
  const scaleName = portfolio?.risk_scale || DEFAULT_RISK_SCALE;
  const strategies = listStrategies(scaleName).map(s => ({
    name: s.name, label: s.label,
    enabled: s.name === 'day' ? !!portfolio?.day_enabled
           : s.name === 'swing' ? !!portfolio?.swing_enabled
           : s.name === 'asx_swing' ? !!portfolio?.asx_swing_enabled
           : false,
  }));
  return { portfolio, strategies };
}
setTimeout(async () => {
  try {
    const ctx = await _resolveSafetyContext();
    const r = await safetySuggestion.refresh({ force: true, ...ctx });
    console.log(`[Safety] Startup refresh: generated ${r.generated} (inserted ${r.inserted ?? 0}, updated ${r.updated ?? 0}, expired ${r.expired ?? 0})`);
  } catch (e) { console.error('[Safety] Startup refresh failed:', e.message); }
}, 120_000);
setInterval(async () => {
  try {
    const ctx = await _resolveSafetyContext();
    await safetySuggestion.refresh(ctx).catch(() => {});
  } catch (_) {}
}, 30 * 60 * 1000);

// Long-Term Memory & Experience Replay warm-up — backfill memory rows for
// every closed trade not yet indexed, then refresh every 30 min so newly
// closed trades show up in retrieval. Strictly informational; cannot affect
// the trading loop. Failures are logged and swallowed.
setTimeout(async () => {
  try {
    const r = await memoryService.backfill({ force: true });
    console.log(`[Memory] Startup backfill: indexed ${r.indexed} of ${r.totalCandidates ?? 0} candidate trades`);
  } catch (e) { console.error('[Memory] Startup backfill failed:', e.message); }
}, 150_000);
setInterval(() => {
  memoryService.backfill().catch(() => {});
}, 30 * 60 * 1000);

// Cross-Market & Sector Propagation warm-up. Mines propagation edges from
// closed trades + recent SIGNAL audits, computes the current per-bucket
// pulse, and persists actionable edges to propagation_insights. Strictly
// informational; cannot affect the trading loop. Failures are logged and
// swallowed.
setTimeout(async () => {
  try {
    const r = await propagationService.refresh({ force: true });
    if (r?.error) console.error('[Propagation] Startup refresh failed:', r.error);
    else console.log(`[Propagation] Startup refresh: ${r?.inserted ?? 0} edges, ${r?.pulseBuckets ?? 0} pulse buckets, scanned ${r?.closedTradesScanned ?? 0} closed trades`);
  } catch (e) { console.error('[Propagation] Startup refresh failed:', e.message); }
}, 180_000);
setInterval(() => {
  propagationService.refresh().catch(() => {});
}, 30 * 60 * 1000);

// Automated Strategy Discovery warm-up. Periodically backtests small
// variations of trading rules and persists the strongest as PENDING
// proposals for the operator to apply or dismiss on the dashboard. NEVER
// auto-applies — operator approval is mandatory. 4-hour cadence (slow,
// expensive signal). Failures are logged and swallowed.
const strategyDiscoveryService = require('./services/strategyDiscoveryService');
setTimeout(async () => {
  try {
    const r = await strategyDiscoveryService.refresh({ force: true });
    if (r?.error) console.error('[StrategyDiscovery] Startup refresh failed:', r.error);
    else console.log(`[StrategyDiscovery] Startup refresh: ${r?.proposalsInserted ?? 0} new proposals from ${r?.candidates ?? 0} candidates over ${r?.bucketsEvaluated ?? 0} buckets (${r?.totalCloses ?? 0} closes scanned)`);
  } catch (e) { console.error('[StrategyDiscovery] Startup refresh failed:', e.message); }
}, 210_000);
setInterval(() => {
  strategyDiscoveryService.refresh().catch(() => {});
}, 4 * 60 * 60 * 1000);

// Self-Supervised Market Pre-Training warm-up. Mines years of historical
// daily bars from Alpaca for the recently-active US watchlist, builds the
// codeword → next-bar regime distribution table, then runs WEEKLY thereafter.
// Heavy + slow (multi-symbol Alpaca pagination) so this is delayed to +240s
// and runs only after the lighter learning layers have warmed. Failures
// are logged + swallowed — the service produces no prompt block when cold.
setTimeout(async () => {
  try {
    const r = await marketPretrainService.runPretraining({ force: true });
    if (r?.error) console.error('[MarketPretrain] Startup pre-training failed:', r.error);
    else console.log(`[MarketPretrain] Startup pre-training: learned ${r?.codewordsLearned ?? 0} codewords from ${r?.totalContexts ?? 0} contexts across ${r?.symbolsScanned ?? 0} symbols${r?.reason ? ` (${r.reason})` : ''}`);
  } catch (e) { console.error('[MarketPretrain] Startup pre-training failed:', e.message); }
}, 240_000);
setInterval(() => {
  marketPretrainService.runPretraining().catch(() => {});
}, 7 * 24 * 60 * 60 * 1000);

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
  emergencyPause, resetCircuitBreaker, setAutoBreakerReset, flattenAllPositions,
  cancelAllOpenOrders, killSwitch, isKillSwitchLatched,
  setStrategyEnabled, setTradingMode, setRiskScale, WATCHLIST,
  // Exposed for the /api/risk-capacity endpoint so it can compute on-demand
  // pre-warmup. Read-only USD price-lookup builder; identical logic to the
  // per-cycle path. Does NOT touch trading state.
  buildPriceLookup,
  // [Upgrade #4] Surfaced for /api/perf — observability only.
  perfMetrics,
};
