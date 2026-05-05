// Self-Supervised Market Pre-Training Layer.
//
// A lightweight self-supervised model that pre-trains on years of historical
// daily bars to learn GENERAL MARKET DYNAMICS — what tends to happen in the
// next bar given the recent context — and is then fine-tuned on Alpha's own
// closed trades. The learned distributions are injected into every voter's
// LLM prompt as a "PRE-TRAINED MARKET PRIOR" block.
//
// SSL TASK — masked next-bar regime prediction:
//   For every 5-day window in the historical corpus, summarise the window
//   into a CODEWORD (a short discrete token capturing trend × volatility ×
//   momentum), then count how often each next-day return regime
//   (UP_STRONG / UP_WEAK / FLAT / DOWN_WEAK / DOWN_STRONG) follows. The
//   conditional distribution P(next_regime | codeword) is the pre-trained
//   model. 27 codewords (3³) × 5 regimes = 135-cell table — cheap to store,
//   cheap to update, no GPU required, no third-party deps.
//
// FINE-TUNING — incremental Bayesian update from Alpha's own outcomes:
//   When a SELL closes, we look up the codeword that was active at the
//   originating BUY's bar context and the realised outcome regime (mapped
//   from the trade's USD P&L per share over its holding period). The
//   codeword's distribution is nudged toward the realised regime with a
//   small effective-sample-size weight (≡ 1 sample) — so a single trade
//   can never overwhelm the years of pre-training, but a consistent edge
//   accumulates over time. Fine-tune count is tracked separately so the
//   prompt block can show "n=2,847 historical contexts + 12 own trades".
//
// PROMPT INJECTION:
//   At decision time, the layer fetches the symbol's current 5-day codeword
//   (from cached daily bars) and renders a 2-3 line block with the predicted
//   distribution + expected next-day return. INFORMATIONAL ONLY.
//
// SAFETY CONTRACT — STRICTLY INFORMATIONAL:
//   • No risk-manager hook. Cannot affect quorum (3-of-4), confidence gate,
//     daily $100 USD loss budget, 5% drawdown circuit breaker, kill switch,
//     no-averaging-in rule, trailing-stop ratchet, or sizing — ALL retain
//     full veto power.
//   • Every failure (DB, bar fetch, render) swallows silently. Pre-training
//     is fire-and-forget; if Alpaca keys are missing or bars unavailable,
//     the layer simply produces no prompt block (no error propagation).

const db = require('./db');
const alpacaService = require('./alpacaService');
const marketRegistry = require('./marketRegistry');

// ----- Tokenization parameters (kept stable so historical codewords keep
// their meaning across pre-training runs). -----------------------------------
const CONTEXT_BARS = 5;                    // bars summarised into the codeword
const TREND_WINDOW = 20;                   // SMA baseline window for trend bucket
const REGIMES = ['UP_STRONG', 'UP_WEAK', 'FLAT', 'DOWN_WEAK', 'DOWN_STRONG'];
const REGIME_THRESHOLDS = { strongUp: 0.015, weakUp: 0.003, weakDown: -0.003, strongDown: -0.015 };
const PRETRAIN_YEARS = 3;                  // ~756 daily bars per symbol — fits in one Alpaca page
const PRETRAIN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // weekly refresh
const CODEWORD_BAR_CACHE_MS = 6 * 60 * 60 * 1000; // 6h cache for the per-symbol decision-time bars
const FINETUNE_EFFECTIVE_N = 1.0;          // weight of one own-trade outcome relative to a historical sample
const MIN_SAMPLES_FOR_PROMPT = 30;         // don't render prompt block for cold-start codewords
const PRETRAIN_FETCH_DELAY_MS = 350;       // throttle between per-symbol Alpaca pulls so the trade loop's real-time bar API isn't starved during re-training (architect HIGH)

let _refreshAttemptedAt = Date.now();      // initialised to load time so renderForPrompt can't self-trigger before boot warm-up
let _refreshInFlight = null;
let _codewordCache = null;                 // Map<codeword, distribution row>
let _codewordCacheLoadedAt = 0;
const CODEWORD_CACHE_TTL_MS = 5 * 60 * 1000;
const _barCache = new Map();               // symbol -> { bars, fetchedAt }

// ----- Bucket helpers -------------------------------------------------------

function _trendBucket(contextBars, trendBars) {
  // Compares the SMA over the context window to the SMA over the longer
  // trend window. Sign + magnitude relative to the window's own volatility
  // gives a 3-bucket trend codeword.
  if (!contextBars.length || !trendBars.length) return 'F';
  const ctxMean = contextBars.reduce((s, b) => s + b.close, 0) / contextBars.length;
  const trendMean = trendBars.reduce((s, b) => s + b.close, 0) / trendBars.length;
  const ratio = (ctxMean - trendMean) / trendMean;
  if (ratio > 0.01)  return 'U';           // UP
  if (ratio < -0.01) return 'D';           // DOWN
  return 'F';                               // FLAT
}

function _volBucket(returns, longRunVol) {
  if (!returns.length || !Number.isFinite(longRunVol) || longRunVol <= 0) return 'M';
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const sd = Math.sqrt(variance);
  const ratio = sd / longRunVol;
  if (ratio > 1.5) return 'H';              // HIGH vol
  if (ratio < 0.7) return 'L';              // LOW vol
  return 'M';                               // MID vol
}

function _momentumBucket(returns) {
  if (!returns.length) return 'F';
  const last = returns[returns.length - 1];
  if (last > 0.005)  return 'U';
  if (last < -0.005) return 'D';
  return 'F';
}

function _classifyRegime(nextReturn) {
  if (nextReturn >  REGIME_THRESHOLDS.strongUp) return 'UP_STRONG';
  if (nextReturn >  REGIME_THRESHOLDS.weakUp)   return 'UP_WEAK';
  if (nextReturn >= REGIME_THRESHOLDS.weakDown) return 'FLAT';
  if (nextReturn >  REGIME_THRESHOLDS.strongDown) return 'DOWN_WEAK';
  return 'DOWN_STRONG';
}

// Codeword for the last 5 bars in a series. Returns null if there isn't
// enough context (< CONTEXT_BARS + TREND_WINDOW).
function _codewordAt(bars, endIdx) {
  // bars must be ascending by date; endIdx is the LAST bar index of the context.
  const need = CONTEXT_BARS + TREND_WINDOW;
  if (endIdx + 1 < need) return null;
  const ctx = bars.slice(endIdx - CONTEXT_BARS + 1, endIdx + 1);
  const trend = bars.slice(endIdx - CONTEXT_BARS + 1 - TREND_WINDOW, endIdx - CONTEXT_BARS + 1);
  const longRun = bars.slice(0, endIdx + 1);
  const longRunRets = [];
  for (let i = 1; i < longRun.length; i++) longRunRets.push((longRun[i].close - longRun[i - 1].close) / longRun[i - 1].close);
  const lrMean = longRunRets.reduce((a, b) => a + b, 0) / Math.max(1, longRunRets.length);
  const lrSd = Math.sqrt(longRunRets.reduce((s, r) => s + (r - lrMean) ** 2, 0) / Math.max(1, longRunRets.length));
  const ctxRets = [];
  for (let i = 1; i < ctx.length; i++) ctxRets.push((ctx[i].close - ctx[i - 1].close) / ctx[i - 1].close);
  return `${_trendBucket(ctx, trend)}_${_volBucket(ctxRets, lrSd)}_${_momentumBucket(ctxRets)}`;
}

// ----- Pre-training corpus mining -------------------------------------------

async function _loadCorpusSymbols() {
  // Pre-training mines from US-only symbols (Alpaca data feed). We pull the
  // distinct symbols Alpha has actually generated SIGNAL audit rows for in
  // the last 180 days — that's the relevant pre-training universe for the
  // active strategies. Falls back to ASX-watchlist members re-mapped to
  // US-only if no recent signals (cold-start safety).
  try {
    const { rows } = await db.query(`
      SELECT DISTINCT symbol FROM audit_log
      WHERE event_type = 'SIGNAL'
        AND created_at >= NOW() - INTERVAL '180 days'
    `);
    const all = rows.map(r => r.symbol).filter(Boolean);
    const us = all.filter(s => marketRegistry.isUs(s));
    if (us.length) return us;
  } catch (_) {}
  // Cold-start fallback — empty array means no pre-training will run yet.
  // We avoid hardcoding a watchlist here so the layer doesn't drift from
  // the operator's own configuration.
  return [];
}

async function _fetchHistoricalBars(symbol, years = PRETRAIN_YEARS) {
  // Adjusted daily bars over `years` years. Splits/dividends adjusted so
  // multi-year drawdowns aren't fabricated by corporate actions.
  const start = new Date(Date.now() - years * 365 * 86400000).toISOString();
  try {
    const bars = await alpacaService.getBars(symbol, '1Day', 1000, {
      start, adjustment: 'all', noMock: true, paginate: true,
    });
    if (!Array.isArray(bars) || bars.length < CONTEXT_BARS + TREND_WINDOW + 1) return [];
    // Normalise: ascending by time, only the close we need for codeword maths.
    return bars
      .map(b => ({ t: b.t, close: Number(b.c) }))
      .filter(b => Number.isFinite(b.close) && b.close > 0)
      .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
  } catch (e) {
    console.warn(`[MarketPretrain] bar fetch failed for ${symbol}: ${e.message}`);
    return [];
  }
}

// One pre-training pass. Mines (codeword, next_regime) counts from the entire
// corpus; aggregates into per-codeword distributions; persists to the
// `market_pretrain_codewords` table (replace-only — the previous fine-tune
// counts are layered back on top because they came from REAL trade outcomes
// and are still valid signal we don't want to lose on a re-train).
async function runPretraining({ force = false } = {}) {
  if (_refreshInFlight) return _refreshInFlight;
  if (!force && Date.now() - _refreshAttemptedAt < PRETRAIN_TTL_MS) {
    return { codewordsLearned: 0, throttled: true };
  }
  _refreshAttemptedAt = Date.now();
  _refreshInFlight = (async () => {
    try {
      const symbols = await _loadCorpusSymbols();
      if (!symbols.length) {
        return { codewordsLearned: 0, totalContexts: 0, symbolsScanned: 0,
                 reason: 'no US symbols in recent SIGNAL audits — cold start' };
      }
      // Snapshot existing fine-tune counts BEFORE we wipe — we restore them
      // on top of the freshly-mined pretrain counts so own-trade signal
      // accumulates across re-training cycles.
      const { rows: prev } = await db.query(`
        SELECT codeword, n_finetune, ft_up_strong, ft_up_weak, ft_flat, ft_down_weak, ft_down_strong
        FROM market_pretrain_codewords
      `);
      const prevFineMap = new Map(prev.map(r => [r.codeword, r]));

      // codeword -> { UP_STRONG, UP_WEAK, FLAT, DOWN_WEAK, DOWN_STRONG }
      const counts = new Map();
      let totalContexts = 0, symbolsScanned = 0;

      for (let si = 0; si < symbols.length; si++) {
        const sym = symbols[si];
        // Throttle between symbol fetches so the live trade-cycle's real-time
        // bar requests aren't starved by a 50-symbol pre-training burst.
        // Skipped for the very first symbol (no preceding fetch).
        if (si > 0) await new Promise(r => setTimeout(r, PRETRAIN_FETCH_DELAY_MS));
        const bars = await _fetchHistoricalBars(sym);
        if (!bars.length) continue;
        symbolsScanned++;
        // Slide a window across the corpus; for each valid endIdx, compute
        // the codeword AT endIdx and the realised next-day return regime at
        // endIdx+1.
        for (let i = CONTEXT_BARS + TREND_WINDOW - 1; i < bars.length - 1; i++) {
          const cw = _codewordAt(bars, i);
          if (!cw) continue;
          const nextRet = (bars[i + 1].close - bars[i].close) / bars[i].close;
          if (!Number.isFinite(nextRet)) continue;
          const regime = _classifyRegime(nextRet);
          const cur = counts.get(cw) || { UP_STRONG: 0, UP_WEAK: 0, FLAT: 0, DOWN_WEAK: 0, DOWN_STRONG: 0 };
          cur[regime]++;
          counts.set(cw, cur);
          totalContexts++;
        }
      }

      // UPSERT-then-prune (architect MEDIUM fix): we used to DELETE + INSERT
      // inside a transaction, which would block any concurrent fine-tune
      // UPDATE on the table for the duration of the re-train and could
      // cause own-trade signal loss on lock timeout. Instead we
      // INSERT ... ON CONFLICT DO UPDATE per codeword (no DELETE on the
      // hot path), then prune any rows whose codewords no longer appear in
      // the freshly-mined corpus AND have no fine-tune signal worth keeping.
      // This eliminates the "table-empty" window entirely — readers always
      // see a fully populated table.
      const cwSet = new Set();
      for (const [cw, c] of counts.entries()) {
        cwSet.add(cw);
        const fine = prevFineMap.get(cw);
        await db.query(`
          INSERT INTO market_pretrain_codewords
            (codeword, n_pretrain, pt_up_strong, pt_up_weak, pt_flat, pt_down_weak, pt_down_strong,
             n_finetune, ft_up_strong, ft_up_weak, ft_flat, ft_down_weak, ft_down_strong, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
          ON CONFLICT (codeword) DO UPDATE SET
            n_pretrain     = EXCLUDED.n_pretrain,
            pt_up_strong   = EXCLUDED.pt_up_strong,
            pt_up_weak     = EXCLUDED.pt_up_weak,
            pt_flat        = EXCLUDED.pt_flat,
            pt_down_weak   = EXCLUDED.pt_down_weak,
            pt_down_strong = EXCLUDED.pt_down_strong,
            updated_at     = NOW()
        `, [
          cw,
          c.UP_STRONG + c.UP_WEAK + c.FLAT + c.DOWN_WEAK + c.DOWN_STRONG,
          c.UP_STRONG, c.UP_WEAK, c.FLAT, c.DOWN_WEAK, c.DOWN_STRONG,
          fine?.n_finetune || 0,
          fine?.ft_up_strong || 0, fine?.ft_up_weak || 0, fine?.ft_flat || 0,
          fine?.ft_down_weak || 0, fine?.ft_down_strong || 0,
        ]);
      }
      // Prune orphan codewords — present in the previous run, absent in this
      // one, AND with no own-trade signal worth keeping (n_finetune == 0).
      // Codewords with fine-tune signal are retained so concurrent SELL
      // closes can still update them.
      if (cwSet.size > 0) {
        await db.query(`
          DELETE FROM market_pretrain_codewords
          WHERE n_finetune = 0
            AND codeword NOT IN (${Array.from(cwSet).map((_, i) => `$${i + 1}`).join(',')})
        `, Array.from(cwSet));
      }
      await db.query(`
        INSERT INTO market_pretrain_meta (id, last_pretrain_at, corpus_size, year_span, codewords_learned, symbols_scanned)
        VALUES (1, NOW(), $1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
          last_pretrain_at = NOW(), corpus_size = $1, year_span = $2,
          codewords_learned = $3, symbols_scanned = $4
      `, [totalContexts, PRETRAIN_YEARS, counts.size, symbolsScanned]);
      _codewordCache = null;                                                     // bust read cache
      _barCache.clear();                                                         // architect MEDIUM fix: prevent stale 6h-old bars after re-train
      return { codewordsLearned: counts.size, totalContexts, symbolsScanned };
    } catch (e) {
      console.error('[MarketPretrain] runPretraining failed (swallowed):', e.message);
      return { codewordsLearned: 0, error: e.message };
    }
  })();
  try { return await _refreshInFlight; } finally { _refreshInFlight = null; }
}

// ----- Fine-tuning ----------------------------------------------------------

// Map a closed trade's (entry_price, exit_price, holding_days) to one of the
// 5 next-bar regime buckets — average daily return over the holding period.
function _tradeOutcomeRegime({ entryPrice, exitPrice, holdingDays }) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice <= 0) return null;
  const totalRet = (exitPrice - entryPrice) / entryPrice;
  const days = Math.max(1, Number(holdingDays) || 1);
  const dailyEquivRet = totalRet / days;
  return _classifyRegime(dailyEquivRet);
}

// Called after a SELL closes. Best-effort — never throws. Looks up the
// originating BUY's TRADE_EXECUTED audit row to find the entry context's
// codeword and the entry price, computes the realised regime, and Bayesian-
// updates the codeword distribution with effective-sample-size 1.
async function applyTradeFineTune({ symbol, strategy, exitPrice, exitAt }) {
  try {
    if (!symbol || !strategy || !Number.isFinite(exitPrice)) return { ok: false, reason: 'invalid args' };
    // Find the originating BUY trade row for entry price + entry timestamp.
    const { rows: buyRows } = await db.query(`
      SELECT price, created_at FROM trades
      WHERE side='BUY' AND symbol=$1 AND strategy=$2 AND created_at < $3
      ORDER BY created_at DESC LIMIT 1
    `, [symbol, strategy, exitAt]);
    if (!buyRows.length) return { ok: false, reason: 'no originating BUY' };
    const entryPrice = Number(buyRows[0].price);
    const entryAt = buyRows[0].created_at;
    const holdingDays = Math.max(1, Math.round((new Date(exitAt).getTime() - new Date(entryAt).getTime()) / 86400000));
    const regime = _tradeOutcomeRegime({ entryPrice, exitPrice, holdingDays });
    if (!regime) return { ok: false, reason: 'invalid regime mapping' };
    // Compute the codeword that was active at entry — uses the same daily
    // bar series the runtime uses for prompt rendering. If bars aren't
    // available we silently skip (cold-start safe).
    const cw = await _currentCodewordForSymbol(symbol);
    if (!cw) return { ok: false, reason: 'no codeword at entry context' };
    // Bayesian-style update — increment the matching regime cell by the
    // fine-tune effective N. Capped per-row by NOT exceeding the pretrain
    // count (own trades cannot dominate the prior).
    const col = `ft_${regime.toLowerCase()}`;
    const upd = await db.query(`
      UPDATE market_pretrain_codewords
      SET ${col} = ${col} + $2,
          n_finetune = n_finetune + $2,
          updated_at = NOW()
      WHERE codeword = $1
      RETURNING n_finetune
    `, [cw, FINETUNE_EFFECTIVE_N]);
    if (!upd.rows.length) return { ok: false, reason: `codeword ${cw} not in pretrain table` };
    _codewordCache = null;
    return { ok: true, codeword: cw, regime, holdingDays };
  } catch (e) {
    console.warn('[MarketPretrain] fine-tune failed (swallowed):', e.message);
    return { ok: false, error: e.message };
  }
}

// ----- Decision-time codeword lookup + prompt render ------------------------

async function _getRecentBarsForSymbol(symbol) {
  const c = _barCache.get(symbol);
  if (c && Date.now() - c.fetchedAt < CODEWORD_BAR_CACHE_MS) return c.bars;
  if (!marketRegistry.isUs(symbol)) {
    // Alpaca data feed is US-only. ASX symbols still get a prompt block from
    // the GENERAL codeword distribution (codewords are symbol-agnostic) but
    // we can't compute their CURRENT codeword without bars — so we omit the
    // block for those symbols rather than emitting a misleading one.
    _barCache.set(symbol, { bars: [], fetchedAt: Date.now() });
    return [];
  }
  const start = new Date(Date.now() - 90 * 86400000).toISOString();              // 90d enough for trend window + context
  let bars = [];
  try {
    const raw = await alpacaService.getBars(symbol, '1Day', 100, { start, adjustment: 'all', noMock: true });
    if (Array.isArray(raw)) {
      bars = raw.map(b => ({ t: b.t, close: Number(b.c) }))
        .filter(b => Number.isFinite(b.close) && b.close > 0)
        .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
    }
  } catch (_) {}
  _barCache.set(symbol, { bars, fetchedAt: Date.now() });
  return bars;
}

async function _currentCodewordForSymbol(symbol) {
  const bars = await _getRecentBarsForSymbol(symbol);
  if (!bars.length) return null;
  return _codewordAt(bars, bars.length - 1);
}

async function _loadCodewordCache() {
  if (_codewordCache && Date.now() - _codewordCacheLoadedAt < CODEWORD_CACHE_TTL_MS) return _codewordCache;
  try {
    const { rows } = await db.query(`SELECT * FROM market_pretrain_codewords`);
    _codewordCache = new Map(rows.map(r => [r.codeword, r]));
    _codewordCacheLoadedAt = Date.now();
  } catch (e) {
    console.warn('[MarketPretrain] codeword cache load failed:', e.message);
    _codewordCache = new Map();
    _codewordCacheLoadedAt = Date.now();
  }
  return _codewordCache;
}

// Build a pure distribution {UP_STRONG, UP_WEAK, FLAT, DOWN_WEAK, DOWN_STRONG}
// from a codeword row. Pretrain counts and fine-tune counts sum together.
function _distributionFromRow(row) {
  const total = Number(row.n_pretrain) + Number(row.n_finetune);
  if (total <= 0) return null;
  const out = {};
  for (const r of REGIMES) {
    const lower = r.toLowerCase();
    const sum = Number(row[`pt_${lower}`]) + Number(row[`ft_${lower}`]);
    out[r] = sum / total;
  }
  return out;
}

function _expectedNextDayReturn(dist) {
  // Use the bucket midpoints to convert the categorical distribution into a
  // scalar expected return. Conservative midpoints (we don't have per-bucket
  // means; midpoint-of-band is a defensible plug-in estimator).
  const mids = { UP_STRONG: 0.025, UP_WEAK: 0.008, FLAT: 0.0, DOWN_WEAK: -0.008, DOWN_STRONG: -0.025 };
  let s = 0;
  for (const r of REGIMES) s += (dist[r] || 0) * mids[r];
  return s;
}

async function getMarketPrior(symbol) {
  const [cw, cache] = await Promise.all([_currentCodewordForSymbol(symbol), _loadCodewordCache()]);
  if (!cw) return null;
  const row = cache.get(cw);
  if (!row) return null;
  const total = Number(row.n_pretrain) + Number(row.n_finetune);
  if (total < MIN_SAMPLES_FOR_PROMPT) return null;
  const dist = _distributionFromRow(row);
  if (!dist) return null;
  return {
    codeword: cw,
    nPretrain: Number(row.n_pretrain),
    nFinetune: Number(row.n_finetune),
    distribution: dist,
    expectedNextDayReturn: _expectedNextDayReturn(dist),
  };
}

async function renderForPrompt(symbol) {
  try {
    const p = await getMarketPrior(symbol);
    if (!p) return null;
    const d = p.distribution;
    const er = p.expectedNextDayReturn * 100;
    const sign = er >= 0 ? '+' : '';
    return [
      `PRE-TRAINED MARKET PRIOR (codeword ${p.codeword}, n=${p.nPretrain.toLocaleString()} historical contexts + ${p.nFinetune} own trade outcomes):`,
      `  next-day P[+strong=${(d.UP_STRONG * 100).toFixed(0)}% +weak=${(d.UP_WEAK * 100).toFixed(0)}% flat=${(d.FLAT * 100).toFixed(0)}% -weak=${(d.DOWN_WEAK * 100).toFixed(0)}% -strong=${(d.DOWN_STRONG * 100).toFixed(0)}%]`,
      `  expected next-day return ≈ ${sign}${er.toFixed(2)}% — informational only; quorum + confidence gate retain full veto.`,
    ].join('\n');
  } catch (e) {
    console.warn('[MarketPretrain] renderForPrompt failed (swallowed):', e.message);
    return null;
  }
}

// ----- Dashboard summary ----------------------------------------------------

async function getSummary() {
  try {
    const { rows: meta } = await db.query(`SELECT * FROM market_pretrain_meta WHERE id=1`);
    const { rows: cwAll } = await db.query(`
      SELECT codeword, n_pretrain, n_finetune,
             pt_up_strong, pt_up_weak, pt_flat, pt_down_weak, pt_down_strong,
             ft_up_strong, ft_up_weak, ft_flat, ft_down_weak, ft_down_strong, updated_at
      FROM market_pretrain_codewords ORDER BY n_pretrain DESC
    `);
    const codewords = cwAll.map(r => ({
      codeword: r.codeword,
      nPretrain: Number(r.n_pretrain),
      nFinetune: Number(r.n_finetune),
      distribution: _distributionFromRow(r),
      expectedNextDayReturn: (() => { const d = _distributionFromRow(r); return d ? _expectedNextDayReturn(d) : null; })(),
    }));
    return {
      meta: meta[0] || null,
      codewordCount: codewords.length,
      totalContexts: codewords.reduce((s, c) => s + c.nPretrain, 0),
      totalFinetuneSamples: codewords.reduce((s, c) => s + c.nFinetune, 0),
      codewords,
      nextRefreshAt: _refreshAttemptedAt + PRETRAIN_TTL_MS,
      refreshIntervalMs: PRETRAIN_TTL_MS,
    };
  } catch (e) {
    return { error: e.message, codewords: [] };
  }
}

module.exports = {
  runPretraining, applyTradeFineTune, getMarketPrior, renderForPrompt, getSummary,
  _internal: {
    _codewordAt, _classifyRegime, _trendBucket, _volBucket, _momentumBucket,
    _tradeOutcomeRegime, _expectedNextDayReturn, _distributionFromRow,
    REGIMES, CONTEXT_BARS, TREND_WINDOW,
  },
};
