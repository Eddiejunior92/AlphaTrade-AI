// Cross-Market & Sector Propagation Layer.
//
// Learns how moves in one (market × sector) propagate to another. Examples:
//   • US Technology bearish → ASX Materials trades historically win 38%
//     (vs 56% baseline, -18pp lift, n=24)
//   • US Energy bullish    → ASX Materials trades win 71% (vs 56%, +15pp)
//   • US Financials bearish → ASX Financials trades win 41% (vs 58%, -17pp)
//
// How it works:
//   1. Each symbol is bucketed into a coarse sector (Technology / Financials /
//      Materials / Healthcare / Energy / Consumer / Communication / ETF)
//      using a curated 57-symbol map. The market is US or ASX (already on the
//      trade row).
//   2. SECTOR PULSE — every refresh cycle (30 min) we compute the recent
//      "pulse" of each (market, sector) from the last 24h of SIGNAL audit
//      rows: aggregate signal direction (BUY/HOLD/SELL counts), avg polarity
//      from newsSentiment, avg recent return from each SIGNAL's priceData.
//      Pulse is bucketed into 'bullish' | 'bearish' | 'neutral' using
//      symmetric thresholds.
//   3. PROPAGATION MINING — for each closed SELL trade with non-null pnl, we
//      look up what every other (market, sector) pulse was in the 24h leading
//      up to the entry. We then group closed trades by (target_market,
//      target_sector, source_market, source_sector, source_state) and compute
//      conditional win-rate + avg P&L + sample count. Filter to edges with
//      n_samples ≥ 5 and |lift_pp| ≥ 8 to drop noise.
//   4. PROMPT INJECTION — at decision time, the agent looks up the symbol's
//      (market, sector), pulls the top-3 strongest propagation edges for
//      that target bucket, looks up the CURRENT source-state for each, and
//      renders a compact text block injected into every LLM voter's prompt.
//
// Safety contract (identical pattern to causal/counterfactual/memory layers):
//   STRICTLY INFORMATIONAL. This layer writes to its own propagation_insights
//   table and reads from `trades` + `audit_log`. Its only output to the
//   trading loop is a pre-rendered text block. It NEVER touches the risk
//   manager, NEVER gates trades, NEVER alters confidence/quorum/breakers/
//   loss-cap/trailing-stops/kill-switch. Every failure (DB, mining, render)
//   swallows silently. The 3-of-4 quorum, per-tier confidence gate floor,
//   per-tier daily USD loss budget, 5% drawdown circuit breaker, kill switch,
//   no-averaging-in, and trailing-stop ratchet ALL retain full veto power.

const db = require('./db');

// Curated symbol → coarse sector bucket. Spans the US 30 + ASX 27 universe.
// Coarser than knowledgeGraphService.COMPANY_INFO.sector strings on purpose:
// we want big buckets so per-bucket sample counts stay statistically
// meaningful rather than fragmenting into 12-way singletons.
const SYMBOL_SECTOR = Object.freeze({
  // US mega-cap tech / semis
  AAPL:'Technology', NVDA:'Technology', MSFT:'Technology', AMD:'Technology',
  AVGO:'Technology', INTC:'Technology', MU:'Technology', QCOM:'Technology', TSM:'Technology',
  // US comms (FB/Google/NFLX) — bucket as Communication
  META:'Communication', GOOGL:'Communication', NFLX:'Communication',
  // US consumer
  AMZN:'Consumer', TSLA:'Consumer', COST:'Consumer', WMT:'Consumer', HD:'Consumer', MCD:'Consumer',
  // US financials / payments
  JPM:'Financials', BAC:'Financials', GS:'Financials', V:'Financials',
  // US healthcare
  JNJ:'Healthcare', PFE:'Healthcare', LLY:'Healthcare', UNH:'Healthcare',
  // US energy
  XOM:'Energy', CVX:'Energy',
  // US ETFs (macro anchors)
  SPY:'ETF', QQQ:'ETF',

  // ASX banks
  CBA:'Financials', WBC:'Financials', NAB:'Financials', ANZ:'Financials', MQG:'Financials',
  CPU:'Financials',
  // ASX miners / materials
  BHP:'Materials', RIO:'Materials', FMG:'Materials', S32:'Materials', PLS:'Materials',
  MIN:'Materials', JHX:'Materials',
  // ASX healthcare
  CSL:'Healthcare', RMD:'Healthcare', COH:'Healthcare',
  // ASX tech / online / consumer / industrials / energy / REIT
  REA:'Communication', XRO:'Technology',
  WOW:'Consumer', WES:'Consumer', ALL:'Consumer',
  TCL:'Industrials', BXB:'Industrials',
  GMG:'RealEstate',
  WDS:'Energy', STO:'Energy', ORG:'Energy',  // ORG is technically Utilities but folded into Energy for bucket-size purposes
});

// Symbol → market. The full ASX 27 universe (matches the asx_swing watchlist
// + knowledgeGraphService.COMPANY_INFO ASX section); everything else falls
// back to 'US' (which is where any unrecognized symbol routes).
const ASX_SYMBOLS = new Set([
  'CBA','WBC','NAB','ANZ','MQG','CPU',
  'BHP','RIO','FMG','S32','PLS','MIN','JHX',
  'CSL','RMD','COH',
  'REA','XRO',
  'WOW','WES','ALL',
  'TCL','BXB',
  'GMG',
  'WDS','STO','ORG',
]);
function sectorFor(symbol) { return SYMBOL_SECTOR[symbol] || 'Other'; }
function marketFor(symbol) { return ASX_SYMBOLS.has(symbol) ? 'ASX' : 'US'; }

// ----- Pulse computation ----------------------------------------------------

const PULSE_WINDOW_HOURS = 24;
// Pulse score: signed weighted blend of (a) avg news/sentiment polarity, and
// (b) recent return derived from each SIGNAL's priceData.bars (last vs first
// in the bar series). Both clipped to [-1,1] and averaged.
function _bucketPulse(score) {
  if (score >= 0.10) return 'bullish';
  if (score <= -0.10) return 'bearish';
  return 'neutral';
}

function _polarityFromPayload(p) {
  const ns = p?.newsSentiment;
  if (typeof ns === 'number') return ns;
  if (typeof ns?.polarity === 'number') return ns.polarity;
  // Fall back to sentiment string
  const s = String(p?.sentiment || '').toLowerCase();
  if (s === 'bullish') return 0.4;
  if (s === 'bearish') return -0.4;
  return 0;
}

function _returnFromPayload(p) {
  const bars = p?.priceData?.bars;
  if (!Array.isArray(bars) || bars.length < 2) return 0;
  const first = bars[0]?.c, last = bars[bars.length - 1]?.c;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return 0;
  const ret = (last - first) / first;
  // Clip to [-0.05, +0.05] then normalize so a 5% intraday move = full ±1.
  return Math.max(-1, Math.min(1, ret / 0.05));
}

// Compute the (market, sector) → pulse map from SIGNAL rows in [now-24h, now].
// One pass over recent rows, no per-symbol API calls.
async function _computeCurrentPulses(asOf = new Date()) {
  const since = new Date(asOf.getTime() - PULSE_WINDOW_HOURS * 3600 * 1000);
  const { rows } = await db.query(`
    SELECT symbol, payload, created_at FROM audit_log
    WHERE event_type = 'SIGNAL' AND created_at >= $1 AND created_at <= $2
  `, [since, asOf]);
  const acc = new Map();  // 'US|Technology' -> { polSum, retSum, n }
  for (const r of rows) {
    const m = marketFor(r.symbol);
    const s = sectorFor(r.symbol);
    if (s === 'Other') continue;
    const key = `${m}|${s}`;
    const pol = _polarityFromPayload(r.payload);
    const ret = _returnFromPayload(r.payload);
    const cur = acc.get(key) || { polSum: 0, retSum: 0, n: 0 };
    cur.polSum += pol;
    cur.retSum += ret;
    cur.n += 1;
    acc.set(key, cur);
  }
  const out = new Map();
  for (const [key, v] of acc.entries()) {
    if (v.n < 3) continue;  // need a minimum to call a pulse
    const avgPol = v.polSum / v.n;
    const avgRet = v.retSum / v.n;
    const score = (avgPol + avgRet) / 2;
    out.set(key, { score, avgPol, avgRet, n: v.n, state: _bucketPulse(score) });
  }
  return out;
}

// ----- Mining (build the propagation_insights table) -----------------------

// For each closed trade, look at the (market, sector) pulses in the 24h
// preceding entry, and bucket the outcome accordingly. We approximate "entry
// time" with trade.created_at minus a short look-back since the BUY trade
// row is created at execution time. Good enough for daily-bucket
// propagation analysis at this granularity.
async function _historicalPulsesForBucket(market, sector, asOf) {
  const since = new Date(asOf.getTime() - PULSE_WINDOW_HOURS * 3600 * 1000);
  // Collect SIGNAL rows in the 24h preceding asOf for symbols matching
  // (market, sector). We do an in-Node filter rather than SQL since the
  // sector taxonomy is in JS, not the DB.
  const { rows } = await db.query(`
    SELECT symbol, payload FROM audit_log
    WHERE event_type = 'SIGNAL' AND created_at >= $1 AND created_at <= $2
  `, [since, asOf]);
  let polSum = 0, retSum = 0, n = 0;
  for (const r of rows) {
    if (marketFor(r.symbol) !== market) continue;
    if (sectorFor(r.symbol) !== sector) continue;
    polSum += _polarityFromPayload(r.payload);
    retSum += _returnFromPayload(r.payload);
    n += 1;
  }
  if (n < 3) return { state: 'neutral', score: 0, n };
  const score = ((polSum / n) + (retSum / n)) / 2;
  return { state: _bucketPulse(score), score, n };
}

// All (market × sector) buckets that exist in our taxonomy.
function _allBuckets() {
  const set = new Set();
  for (const [sym, sec] of Object.entries(SYMBOL_SECTOR)) {
    if (sec === 'Other') continue;
    set.add(`${marketFor(sym)}|${sec}`);
  }
  return [...set].map(k => { const [market, sector] = k.split('|'); return { market, sector }; });
}

// Refresh interval bookkeeping (in-flight dedupe + throttle).
const REFRESH_TTL_MS = 30 * 60 * 1000;
let _lastRefreshAt = 0;
let _refreshInFlight = null;
let _pulseCache = new Map();
let _pulseCacheAt = 0;
let _insightsCache = [];     // current persisted edges, freshly loaded after each refresh
let _insightsCacheAt = 0;

async function _loadInsightsCache() {
  const { rows } = await db.query(`
    SELECT target_market, target_sector, source_market, source_sector, source_state,
           target_winrate, target_avg_pnl, target_baseline_winrate, lift_pp, n_samples, computed_at
    FROM propagation_insights ORDER BY ABS(lift_pp) DESC LIMIT 2000
  `);
  _insightsCache = rows.map(r => ({
    ...r,
    target_winrate: parseFloat(r.target_winrate),
    target_avg_pnl: parseFloat(r.target_avg_pnl),
    target_baseline_winrate: parseFloat(r.target_baseline_winrate),
    lift_pp: parseFloat(r.lift_pp),
  }));
  _insightsCacheAt = Date.now();
}

async function refresh({ force = false } = {}) {
  if (_refreshInFlight) return _refreshInFlight;
  if (!force && Date.now() - _lastRefreshAt < REFRESH_TTL_MS) {
    return { skipped: true, throttled: true };
  }
  _lastRefreshAt = Date.now();
  _refreshInFlight = (async () => {
    try {
      // 1. Refresh the current sector pulses (used by the prompt block).
      _pulseCache = await _computeCurrentPulses(new Date());
      _pulseCacheAt = Date.now();

      // 2. Mine propagation edges from closed trades. ARCHITECT-FIX: avoid
      // look-ahead bias by conditioning on data BEFORE entry, not before
      // close. We resolve each SELL's entry timestamp via a LATERAL join to
      // the most recent prior BUY for the same (symbol, strategy). When no
      // matching BUY exists (legacy / orphan rows), fall back to the SELL's
      // own created_at minus a 24h shim so the join still works.
      const { rows: closes } = await db.query(`
        SELECT s.id, s.symbol, s.strategy, s.market, s.pnl,
               COALESCE(b.created_at, s.created_at - INTERVAL '24 hours') AS entry_time
        FROM trades s
        LEFT JOIN LATERAL (
          SELECT created_at FROM trades b
          WHERE b.side='BUY' AND b.symbol=s.symbol AND b.strategy=s.strategy
            AND b.created_at < s.created_at
          ORDER BY b.created_at DESC LIMIT 1
        ) b ON TRUE
        WHERE s.side='SELL' AND s.pnl IS NOT NULL
        ORDER BY s.created_at DESC LIMIT 500
      `);

      // For each closed trade, compute the historical pulse-state of every
      // bucket in the 24h preceding it. We cache by entry timestamp rounded
      // to the hour so 20 trades in the same hour share a single SQL hit.
      const buckets = _allBuckets();
      const pulseCache = new Map();  // 'YYYY-MM-DDTHH|US|Technology' -> { state }
      const tradeBuckets = [];
      for (const t of closes) {
        const tradeMarket = t.market || marketFor(t.symbol) || 'US';
        const tradeSector = sectorFor(t.symbol);
        if (tradeSector === 'Other') continue;
        const asOf = new Date(t.entry_time);  // ARCHITECT-FIX: entry, not close
        const hourKey = asOf.toISOString().slice(0, 13);
        for (const { market: srcM, sector: srcS } of buckets) {
          // Skip self (target == source)
          if (srcM === tradeMarket && srcS === tradeSector) continue;
          const cacheKey = `${hourKey}|${srcM}|${srcS}`;
          let p = pulseCache.get(cacheKey);
          if (!p) {
            p = await _historicalPulsesForBucket(srcM, srcS, asOf);
            pulseCache.set(cacheKey, p);
          }
          tradeBuckets.push({
            tradeId: t.id,
            target_market: tradeMarket, target_sector: tradeSector,
            source_market: srcM, source_sector: srcS,
            source_state: p.state,
            pnl: parseFloat(t.pnl),
            won: parseFloat(t.pnl) > 0,
          });
        }
      }

      // Compute baseline win-rate per (target_market, target_sector).
      const baseline = new Map();
      for (const t of closes) {
        const tradeMarket = t.market || marketFor(t.symbol) || 'US';
        const tradeSector = sectorFor(t.symbol);
        if (tradeSector === 'Other') continue;
        const k = `${tradeMarket}|${tradeSector}`;
        const cur = baseline.get(k) || { wins: 0, n: 0 };
        if (parseFloat(t.pnl) > 0) cur.wins += 1;
        cur.n += 1;
        baseline.set(k, cur);
      }

      // Aggregate by (target × source × state).
      const agg = new Map();
      for (const tb of tradeBuckets) {
        const k = `${tb.target_market}|${tb.target_sector}|${tb.source_market}|${tb.source_sector}|${tb.source_state}`;
        const cur = agg.get(k) || { wins: 0, pnlSum: 0, n: 0, ...tb };
        if (tb.won) cur.wins += 1;
        cur.pnlSum += tb.pnl;
        cur.n += 1;
        agg.set(k, cur);
      }

      // Persist edges with n ≥ 5 and |lift| ≥ 8pp. Wipe-and-rewrite via DELETE
      // + INSERT under one client so retrieval never sees a half-empty table.
      const client = await db.pool.connect();
      let inserted = 0;
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM propagation_insights');
        for (const cur of agg.values()) {
          if (cur.n < 5) continue;
          const baseK = `${cur.target_market}|${cur.target_sector}`;
          const b = baseline.get(baseK);
          if (!b || b.n < 5) continue;
          const winrate = cur.wins / cur.n;
          const baselineRate = b.wins / b.n;
          const lift_pp = (winrate - baselineRate) * 100;
          if (Math.abs(lift_pp) < 8) continue;
          await client.query(`
            INSERT INTO propagation_insights
              (target_market, target_sector, source_market, source_sector, source_state,
               target_winrate, target_avg_pnl, target_baseline_winrate, lift_pp, n_samples, computed_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
            ON CONFLICT (target_market, target_sector, source_market, source_sector, source_state)
            DO UPDATE SET target_winrate=EXCLUDED.target_winrate,
                          target_avg_pnl=EXCLUDED.target_avg_pnl,
                          target_baseline_winrate=EXCLUDED.target_baseline_winrate,
                          lift_pp=EXCLUDED.lift_pp,
                          n_samples=EXCLUDED.n_samples,
                          computed_at=NOW()
          `, [
            cur.target_market, cur.target_sector,
            cur.source_market, cur.source_sector, cur.source_state,
            winrate.toFixed(4), (cur.pnlSum / cur.n).toFixed(4),
            baselineRate.toFixed(4), lift_pp.toFixed(2), cur.n,
          ]);
          inserted++;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }

      await _loadInsightsCache();
      return { inserted, candidatesScanned: agg.size, closedTradesScanned: closes.length, pulseBuckets: _pulseCache.size };
    } catch (e) {
      console.warn('[Propagation] refresh failed:', e.message);
      return { error: e.message };
    } finally { _refreshInFlight = null; }
  })();
  return _refreshInFlight;
}

// ----- Per-cycle prompt block -----------------------------------------------

// Top-K strongest propagation edges for the (target_market, target_sector)
// of the symbol about to be analyzed, where the source bucket is CURRENTLY
// in the same state the edge was conditioned on. That alignment matters: an
// edge "US Tech bearish → ASX Materials -18pp" is only relevant when US Tech
// is bearish RIGHT NOW. Returns at most `k` actionable edges.
function _activeEdgesFor({ market, sector }, currentPulses, k = 3) {
  if (!_insightsCache.length) return [];
  const edges = _insightsCache.filter(e => e.target_market === market && e.target_sector === sector);
  if (!edges.length) return [];
  const out = [];
  for (const e of edges) {
    const cur = currentPulses.get(`${e.source_market}|${e.source_sector}`);
    if (!cur) continue;
    if (cur.state !== e.source_state) continue;  // edge fires only when current state matches
    out.push({ ...e, currentScore: cur.score });
  }
  return out.sort((a, b) => Math.abs(b.lift_pp) - Math.abs(a.lift_pp)).slice(0, k);
}

// Pre-rendered prompt block for a given target symbol. Returns null when no
// active edges (cold cache / no taxonomy match / no current matches).
function renderForPrompt(symbol) {
  const market = marketFor(symbol);
  const sector = sectorFor(symbol);
  if (sector === 'Other') return null;
  const edges = _activeEdgesFor({ market, sector }, _pulseCache, 3);
  if (!edges.length) return null;
  const lines = edges.map(e => {
    const dir = e.lift_pp >= 0 ? 'TAILWIND' : 'HEADWIND';
    const sign = e.lift_pp >= 0 ? '+' : '';
    return `  • ${e.source_market} ${e.source_sector} currently ${e.source_state} → ${dir} for ${e.target_market} ${e.target_sector}: ${(e.target_winrate*100).toFixed(0)}% wr vs ${(e.target_baseline_winrate*100).toFixed(0)}% baseline (${sign}${e.lift_pp.toFixed(0)}pp, n=${e.n_samples})`;
  });
  return [
    `CROSS-MARKET PROPAGATION — ${edges.length} active edge${edges.length === 1 ? '' : 's'} affecting ${market} ${sector}:`,
    ...lines,
    `  → Treat as priors, NOT as gates. The 3-of-4 quorum + confidence gate retain full veto power.`,
  ].join('\n');
}

// ----- Introspection --------------------------------------------------------

async function getDashboardSummary() {
  if (!_insightsCache.length) await _loadInsightsCache().catch(() => {});
  const pulses = [];
  for (const [k, v] of _pulseCache.entries()) {
    const [market, sector] = k.split('|');
    pulses.push({
      market, sector, state: v.state, score: +v.score.toFixed(3),
      avgPolarity: +v.avgPol.toFixed(3), avgReturn: +v.avgRet.toFixed(3), nSignals: v.n,
    });
  }
  pulses.sort((a, b) => (a.market + a.sector).localeCompare(b.market + b.sector));
  return {
    totalEdges: _insightsCache.length,
    lastRefreshAt: _lastRefreshAt || null,
    pulseBucketsTracked: _pulseCache.size,
    currentPulses: pulses,
    topEdges: _insightsCache.slice(0, 30).map(e => ({
      target: `${e.target_market} ${e.target_sector}`,
      source: `${e.source_market} ${e.source_sector}`,
      sourceState: e.source_state,
      winrate: +(e.target_winrate * 100).toFixed(1),
      baseline: +(e.target_baseline_winrate * 100).toFixed(1),
      liftPp: e.lift_pp,
      avgPnl: e.target_avg_pnl,
      n: e.n_samples,
    })),
  };
}

module.exports = {
  refresh, renderForPrompt, getDashboardSummary,
  // exposed for tests / introspection
  _internal: { sectorFor, marketFor, _bucketPulse, _computeCurrentPulses, SYMBOL_SECTOR, ASX_SYMBOLS },
};
