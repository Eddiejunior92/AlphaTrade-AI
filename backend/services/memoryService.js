// Long-Term Memory & Experience Replay Layer.
//
// What it does:
//   For every closed trade, store a row in `trade_memory` capturing the
//   structured *context* of the entry (strategy, regime, market, RSI/MACD
//   buckets, sentiment, confidence, quorum, news polarity, ML p(win), etc.)
//   along with the realised *outcome* (P&L, win/loss, hold duration) and a
//   one-line auto-generated *lesson*. Each row carries a fixed-length
//   normalized `feature_vec` (~28 dims) used for cosine-similarity retrieval.
//
//   On every analyse cycle, the agent featurises the CURRENT context for the
//   symbol/strategy it's about to decide on, retrieves the top-K most similar
//   past memories from an in-memory cache (last N=2000 rows), and renders a
//   compact "Experience Replay" block that gets injected into every LLM
//   voter's prompt alongside the existing causal + counterfactual blocks.
//
// Why a structured feature embedding (not text embeddings):
//   For tabular trading contexts, a hand-curated structured embedding is
//   both more meaningful (cosine sim directly captures "similar regime +
//   similar indicators + similar conviction") and dramatically cheaper
//   (deterministic, no API call, no provider dependency, no rate limits,
//   no key management). We can always add a text-embedding pathway later if
//   the structured features prove insufficient — the API is the same.
//
// Safety contract:
//   This layer is STRICTLY informational. It only writes to its own
//   `trade_memory` table and reads from `trades` + `audit_log`. Its only
//   output to the trading loop is a pre-rendered text block injected into
//   LLM prompts. It never touches the risk manager, never gates trades,
//   never alters confidence/quorum/breakers/loss-cap/trailing-stops, and
//   never disables anything. Every failure swallows silently — a memory
//   hiccup can never break the trading loop. The 3-of-4 quorum, 85% conf
//   gate floor (in conservative tier), $100/day USD loss budget (in
//   conservative tier), 5% drawdown circuit breaker, kill switch, no-
//   averaging-in, and trailing-stop ratchet ALL retain full veto power.

const db = require('./db');
const { ALL_REGIMES } = require('./regimeService');

// Strategy + market enums for one-hot encoding. Stable order so cached
// vectors stay comparable across restarts.
const STRATEGY_ORDER = ['day', 'swing', 'asx_swing'];
const MARKET_ORDER   = ['US', 'ASX'];
// Use ALL_REGIMES from regimeService and append 'unknown' as a catch-all
// bucket so historical rows without regime info still get a defined slot.
const REGIME_ORDER   = [...ALL_REGIMES, 'unknown'];

// Bump this whenever featurize()'s dimension order or semantics change.
// Retrieval filters cache rows on this so older incompatible vectors are
// silently skipped (rather than producing wrong cosine sims). After bumping,
// run backfill({ force: true }) to re-index outdated rows under the new
// schema (or live with a temporary cold cache while new trades accumulate).
const FEATURE_SCHEMA_VERSION = 1;

// Normalize a regime input that could be either a string or the
// regimeService.classifyRegime() return object ({ primary, tags, ... }).
// Anything we don't recognize collapses to 'unknown' so featurize() stays
// well-defined.
function _regimeKey(r) {
  if (!r) return 'unknown';
  if (typeof r === 'string') return r;
  if (typeof r === 'object' && typeof r.primary === 'string') return r.primary;
  return 'unknown';
}

// Layout of feature_vec (28 dims).
//   0..2   : strategy one-hot (day, swing, asx_swing)
//   3..4   : market one-hot (US, ASX)
//   5..12  : regime one-hot (8 entries — 7 canonical + unknown)
//   13     : direction (1 if BUY, 0 otherwise — we never short)
//   14     : confidence (0-1)
//   15     : conf_high (1 if >= 0.85)
//   16     : unanimous_quorum (1 if 4-0)
//   17     : rsi_norm (0-1; clamped from 0-100)
//   18     : rsi_neutral (1 if 45-65)
//   19     : macd_pos (1 if histogram > 0)
//   20     : vol_high (1 if vol ratio > 1.5)
//   21     : news_pos (1 if polarity > 0.1)
//   22     : news_neg (1 if polarity < -0.1)
//   23     : meta_agree (1 if meta opinion matched consensus)
//   24     : ml_high_pwin (1 if ml p(win) >= 0.6)
//   25     : has_breakout (1 if patterns.breakout != 'none')
//   26     : trend_up (1 if patterns.trend == 'uptrend' or 'trending_up')
//   27     : trend_down (1 if patterns.trend == 'downtrend' or 'trending_down')
const VEC_DIMS = 28;

function _oneHot(value, list, baseOffset, vec) {
  const idx = list.indexOf(value);
  if (idx >= 0) vec[baseOffset + idx] = 1;
}

function _clamp01(x) { return Math.max(0, Math.min(1, x)); }

// Builds a 28-dim feature vector from a structured context object.
// All inputs are optional — missing fields default to 0 (the "neutral" slot).
function featurize(ctx) {
  const v = new Array(VEC_DIMS).fill(0);
  _oneHot(ctx.strategy, STRATEGY_ORDER, 0, v);
  _oneHot(ctx.market, MARKET_ORDER, 3, v);
  _oneHot(_regimeKey(ctx.regime), REGIME_ORDER, 5, v);
  v[13] = ctx.direction === 'BUY' ? 1 : 0;
  v[14] = _clamp01(typeof ctx.confidence === 'number' ? ctx.confidence : 0);
  v[15] = (typeof ctx.confidence === 'number' && ctx.confidence >= 0.85) ? 1 : 0;
  v[16] = ctx.unanimousQuorum ? 1 : 0;
  if (typeof ctx.rsi === 'number') {
    v[17] = _clamp01(ctx.rsi / 100);
    v[18] = (ctx.rsi >= 45 && ctx.rsi <= 65) ? 1 : 0;
  }
  v[19] = ctx.macdHistogram > 0 ? 1 : 0;
  v[20] = ctx.volRatio > 1.5 ? 1 : 0;
  v[21] = (typeof ctx.newsPolarity === 'number' && ctx.newsPolarity > 0.1) ? 1 : 0;
  v[22] = (typeof ctx.newsPolarity === 'number' && ctx.newsPolarity < -0.1) ? 1 : 0;
  v[23] = ctx.metaAgree ? 1 : 0;
  v[24] = (typeof ctx.mlPwin === 'number' && ctx.mlPwin >= 0.6) ? 1 : 0;
  v[25] = (ctx.breakout && ctx.breakout !== 'none') ? 1 : 0;
  const trend = String(ctx.trend || '').toLowerCase();
  v[26] = (trend === 'uptrend' || trend === 'trending_up') ? 1 : 0;
  v[27] = (trend === 'downtrend' || trend === 'trending_down') ? 1 : 0;
  return v;
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Parse a SIGNAL audit payload into the same flat shape featurize() expects.
// Robust to missing fields — anything absent just becomes 0/null.
function _ctxFromSignalPayload(p, fallback = {}) {
  if (!p) return { ...fallback };
  const votes = p.votes || {};
  const totalVotes = (votes.BUY || 0) + (votes.HOLD || 0) + (votes.SELL || 0);
  let consensus = 'HOLD', maxV = -1;
  for (const k of ['BUY', 'HOLD', 'SELL']) {
    if ((votes[k] || 0) > maxV) { maxV = votes[k] || 0; consensus = k; }
  }
  const ind = p.indicators || {};
  const macd = ind.macd || {};
  const vol = ind.volume || {};
  const ns = p.newsSentiment;
  const pat = p.patterns || {};
  return {
    strategy: p.strategy || fallback.strategy,
    market: fallback.market || 'US',
    regime: _regimeKey(p.regime || fallback.regime),
    direction: 'BUY',  // memory rows are for closed long positions
    confidence: typeof p.confidence === 'number' ? p.confidence : (totalVotes > 0 ? maxV / totalVotes : 0),
    unanimousQuorum: maxV === 4,
    rsi: ind.rsi,
    macdHistogram: macd.histogram,
    volRatio: vol.ratio,
    newsPolarity: typeof ns?.polarity === 'number' ? ns.polarity : (typeof ns === 'number' ? ns : null),
    metaAgree: p.meta && p.meta.action === consensus,
    mlPwin: p.mlFeatures?.pWin,
    breakout: pat.breakout,
    trend: pat.trend,
    consensus,
  };
}

// Generate a one-line lesson summary from outcome + context.
function _generateLesson(ctx, outcome) {
  const conf = typeof ctx.confidence === 'number' ? `${(ctx.confidence * 100).toFixed(0)}%` : '?%';
  const quorum = ctx.unanimousQuorum ? '4/4' : '3/4';
  const regime = ctx.regime || 'unknown';
  const tag = outcome.won ? 'WIN' : 'LOSS';
  const sign = outcome.pnl_usd >= 0 ? '+' : '';
  const dur = outcome.hold_seconds
    ? (outcome.hold_seconds < 3600 ? `${Math.round(outcome.hold_seconds / 60)}m`
        : `${(outcome.hold_seconds / 3600).toFixed(1)}h`)
    : '?';
  const indicatorBits = [];
  if (typeof ctx.rsi === 'number') indicatorBits.push(`RSI ${ctx.rsi.toFixed(0)}`);
  if (typeof ctx.macdHistogram === 'number') indicatorBits.push(`MACD ${ctx.macdHistogram >= 0 ? '+' : '-'}`);
  if (ctx.volRatio > 1.5) indicatorBits.push(`vol×${ctx.volRatio.toFixed(1)}`);
  const indStr = indicatorBits.length ? ` [${indicatorBits.join(', ')}]` : '';
  return `${ctx.strategy}/${regime}: BUY at ${conf} conf, ${quorum} quorum${indStr} → ${tag} ${sign}$${outcome.pnl_usd.toFixed(2)} after ${dur}`;
}

// Find the best-matching SIGNAL audit row for a given closed trade.
// Heuristic: the most recent SIGNAL row for the same symbol + strategy that
// pre-dates the SELL trade and has consensus=BUY (i.e. was the entry signal
// or one of the BUY signals along the way). We scope to a 7-day lookback so
// the join doesn't get pathological for very long-held positions.
async function _findEntrySignal(trade) {
  const { rows } = await db.query(`
    SELECT payload, created_at FROM audit_log
    WHERE event_type = 'SIGNAL' AND symbol = $1
      AND created_at <= $2
      AND created_at >= ($2::timestamptz - INTERVAL '7 days')
      AND payload->>'strategy' = $3
      AND (payload->'votes'->>'BUY')::int >= 3
    ORDER BY created_at DESC LIMIT 1
  `, [trade.symbol, trade.created_at, trade.strategy]);
  return rows[0] || null;
}

async function _findEntryTrade(closeTrade) {
  // The matching BUY trade: same symbol+strategy, prior in time, BUY side.
  const { rows } = await db.query(`
    SELECT * FROM trades
    WHERE symbol = $1 AND strategy = $2 AND side = 'BUY'
      AND created_at <= $3
    ORDER BY created_at DESC LIMIT 1
  `, [closeTrade.symbol, closeTrade.strategy, closeTrade.created_at]);
  return rows[0] || null;
}

// Build (and persist) a single memory row from a closed trade. Idempotent
// thanks to the UNIQUE constraint on (trade_id) — second call for the same
// trade is a no-op via ON CONFLICT.
async function indexClosedTrade(trade) {
  const sig = await _findEntrySignal(trade);
  const entry = await _findEntryTrade(trade);
  const sigCtx = _ctxFromSignalPayload(sig?.payload, {
    strategy: trade.strategy,
    market: trade.market || 'US',
    regime: 'unknown',
  });
  const pnl_usd = parseFloat(trade.pnl);
  const won = pnl_usd > 0;
  const hold_seconds = entry ? Math.max(0, Math.round((new Date(trade.created_at) - new Date(entry.created_at)) / 1000)) : null;
  const ctx = {
    ...sigCtx,
    confidence: sigCtx.confidence ?? (entry ? parseFloat(entry.confidence) : 0),
  };
  const vec = featurize(ctx);
  const lesson = _generateLesson(ctx, { pnl_usd, won, hold_seconds });
  await db.query(`
    INSERT INTO trade_memory
      (trade_id, symbol, strategy, regime, market, direction, entry_price, exit_price, qty,
       pnl_usd, won, hold_seconds, entry_confidence, entry_quorum, lesson, feature_vec, feature_schema_version, context_snapshot)
    VALUES ($1,$2,$3,$4,$5,'BUY',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb)
    ON CONFLICT (trade_id) DO NOTHING
  `, [
    trade.id, trade.symbol, trade.strategy, _regimeKey(ctx.regime), trade.market || 'US',
    entry ? parseFloat(entry.price) : null,
    parseFloat(trade.price),
    parseFloat(trade.qty),
    pnl_usd, won, hold_seconds,
    ctx.confidence ?? null,
    ctx.unanimousQuorum ? 4 : 3,
    lesson,
    JSON.stringify(vec),
    FEATURE_SCHEMA_VERSION,
    JSON.stringify({
      hasSignalAudit: !!sig, hasEntryTrade: !!entry,
      consensus: ctx.consensus, rsi: ctx.rsi, macdHistogram: ctx.macdHistogram,
      volRatio: ctx.volRatio, newsPolarity: ctx.newsPolarity, metaAgree: ctx.metaAgree,
      breakout: ctx.breakout, trend: ctx.trend,
    }),
  ]);
}

// In-memory cache of the most recent N memories. Refreshed on backfill +
// every cache-TTL window. Retrieval scans this array — at N=2000 that's a
// 56k-float dot product per query, which is sub-millisecond.
const CACHE_LIMIT = 2000;
const CACHE_TTL_MS = 30 * 60 * 1000;
let _cache = [];
let _cacheLoadedAt = 0;
let _cacheInFlight = null;

async function _loadCache() {
  if (_cacheInFlight) return _cacheInFlight;
  _cacheInFlight = (async () => {
    try {
      // Filter on FEATURE_SCHEMA_VERSION so older incompatible vectors are
      // skipped rather than silently producing wrong cosine sims after a
      // featurize() layout change.
      const { rows } = await db.query(`
        SELECT id, trade_id, symbol, strategy, regime, market, pnl_usd, won, hold_seconds,
               entry_confidence, entry_quorum, lesson, feature_vec, created_at
        FROM trade_memory
        WHERE feature_schema_version = $1
        ORDER BY created_at DESC
        LIMIT $2
      `, [FEATURE_SCHEMA_VERSION, CACHE_LIMIT]);
      _cache = rows.map(r => ({ ...r, feature_vec: r.feature_vec }));
      _cacheLoadedAt = Date.now();
    } catch (e) {
      console.warn('[Memory] cache load failed:', e.message);
    } finally { _cacheInFlight = null; }
    return _cache;
  })();
  return _cacheInFlight;
}

// Backfill: scan all closed SELL trades not yet in trade_memory, build a
// memory row for each. Throttled to one run per CACHE_TTL_MS to avoid
// hammering on retries; force=true bypasses the throttle for boot warm-up.
let _backfillAt = Date.now();
let _backfillInFlight = null;
async function backfill({ force = false } = {}) {
  if (_backfillInFlight) return _backfillInFlight;
  if (!force && Date.now() - _backfillAt < CACHE_TTL_MS) {
    return { indexed: 0, throttled: true };
  }
  _backfillAt = Date.now();
  _backfillInFlight = (async () => {
    try {
      const { rows } = await db.query(`
        SELECT t.* FROM trades t
        LEFT JOIN trade_memory m ON m.trade_id = t.id
        WHERE t.side = 'SELL' AND t.pnl IS NOT NULL AND m.id IS NULL
        ORDER BY t.created_at ASC
        LIMIT 500
      `);
      let indexed = 0;
      for (const r of rows) {
        try { await indexClosedTrade(r); indexed++; }
        catch (e) { console.warn(`[Memory] index trade ${r.id} failed:`, e.message); }
      }
      // Force a FRESH cache load after inserts. We reset the cache timestamp
      // and any in-flight load so we don't accidentally adopt a stale pre-
      // insert read that happened to be in flight when backfill started.
      _cacheLoadedAt = 0;
      _cacheInFlight = null;
      await _loadCache();
      return { indexed, totalCandidates: rows.length };
    } catch (e) {
      console.warn('[Memory] backfill failed:', e.message);
      return { indexed: 0, error: e.message };
    } finally { _backfillInFlight = null; }
  })();
  return _backfillInFlight;
}

// Retrieve top-K memories most similar to the supplied context. Returns
// matches with cosine sim ≥ minSim, sorted by similarity descending.
// Ensures cache is loaded; refresh if stale.
async function retrieveSimilar(currentCtx, { k = 5, minSim = 0.6, requireSameStrategy = true } = {}) {
  if (!_cache.length || Date.now() - _cacheLoadedAt > CACHE_TTL_MS) {
    await _loadCache();
  }
  if (!_cache.length) return [];
  const queryVec = featurize(currentCtx);
  const candidates = requireSameStrategy
    ? _cache.filter(r => r.strategy === currentCtx.strategy)
    : _cache;
  // Score everything once, then take a wider top-N (3×k) BEFORE balancing
  // wins/losses — otherwise a one-sided top-K would prevent renderForPrompt
  // from ever pulling opposite-polarity examples for balance.
  const scoredAll = candidates
    .map(r => ({ row: r, sim: cosineSim(queryVec, r.feature_vec) }))
    .filter(s => s.sim >= minSim)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, Math.max(k * 3, k));
  // Balance: up to ceil(k/2) of each polarity from the wider pool, then re-
  // sort by similarity and trim to k. Falls back to top-k if one side is
  // empty.
  const half = Math.ceil(k / 2);
  const wins  = scoredAll.filter(s => s.row.won).slice(0, half);
  const losses = scoredAll.filter(s => !s.row.won).slice(0, half);
  const merged = [...wins, ...losses].sort((a, b) => b.sim - a.sim).slice(0, k);
  return merged.length ? merged : scoredAll.slice(0, k);
}

// Render the experience-replay block injected into LLM prompts. Formatted
// as a tight 4-7 line block so it doesn't dominate the prompt. We bias
// toward showing one or two LOSSES and one or two WINS in the top-K so the
// model gets balanced lesson coverage rather than only one polarity.
function renderForPrompt(matches) {
  if (!matches || matches.length === 0) return null;
  // Re-balance: take up to 3 losses + up to 3 wins from the matches, sorted
  // by similarity. Keeps the model honest about both sides.
  const losses = matches.filter(m => !m.row.won).slice(0, 3);
  const wins   = matches.filter(m => m.row.won).slice(0, 3);
  const picked = [...losses, ...wins].sort((a, b) => b.sim - a.sim).slice(0, 5);
  if (picked.length === 0) return null;
  const lines = picked.map(({ row, sim }) => {
    return `  • [sim ${(sim * 100).toFixed(0)}%] ${row.lesson}`;
  });
  const winN = matches.filter(m => m.row.won).length;
  const lossN = matches.filter(m => !m.row.won).length;
  const aggPnl = matches.reduce((s, m) => s + parseFloat(m.row.pnl_usd), 0);
  return [
    `EXPERIENCE REPLAY — ${matches.length} similar past situation${matches.length === 1 ? '' : 's'} retrieved (${winN}W / ${lossN}L, agg P&L ${aggPnl >= 0 ? '+' : ''}$${aggPnl.toFixed(2)}):`,
    ...lines,
    `  → Use these as priors, NOT as gates. The 3-of-4 quorum + confidence gate retain full veto power.`,
  ].join('\n');
}

async function getDashboardSummary({ strategy = null, regime = null, market = null, limit = 50 } = {}) {
  if (!_cache.length) await _loadCache();
  let rows = _cache;
  if (strategy) rows = rows.filter(r => r.strategy === strategy);
  if (regime)   rows = rows.filter(r => r.regime === regime);
  if (market)   rows = rows.filter(r => r.market === market);
  const wins = rows.filter(r => r.won).length;
  const losses = rows.length - wins;
  const totalPnl = rows.reduce((s, r) => s + parseFloat(r.pnl_usd), 0);
  return {
    totalMemories: _cache.length,
    filteredCount: rows.length,
    wins, losses,
    netPnL: +totalPnl.toFixed(2),
    cacheLoadedAt: _cacheLoadedAt,
    sample: rows.slice(0, Math.min(limit, rows.length)).map(r => ({
      id: r.id, symbol: r.symbol, strategy: r.strategy, regime: r.regime, market: r.market,
      pnl_usd: parseFloat(r.pnl_usd), won: r.won, lesson: r.lesson, created_at: r.created_at,
    })),
  };
}

module.exports = {
  featurize, cosineSim, indexClosedTrade,
  backfill, retrieveSimilar, renderForPrompt,
  getDashboardSummary,
  // exposed for tests
  _internal: { VEC_DIMS, STRATEGY_ORDER, MARKET_ORDER, REGIME_ORDER },
};
