// Causal Inference Layer.
//
// Analyses every closed trade with lightweight causal-inference techniques to
// distinguish true drivers (features that consistently move win-rate or P&L
// across a sufficient sample) from spurious correlations (features that look
// right but vanish under a sample-size floor or have effects within noise).
// Builds a per-(strategy × regime × market) "causal graph": a small set of
// directed (feature → outcome) edges with their estimated effect size, sample
// size, and confidence tier. The graph is rendered into a compact prompt
// block injected into every LLM cycle so the voters can use *learned*
// causality, not just current-cycle indicators.
//
// SAFETY CONTRACT: this layer is strictly INFORMATIONAL. It never gates
// trading, never sizes a position, never overrides the existing 3-of-4
// quorum, 85% confidence threshold, $100/day USD loss budget, 5% drawdown
// circuit breaker, kill switch, or trailing-stop ratchet. All failures
// swallow silently — a causal-mining hiccup can never break the trading loop.
//
// Method (intentionally simple, robust under small samples):
//   1. Pull last N closed SELL trades and join each to the originating
//      TRADE_EXECUTED audit row (carries the full decision context: regime,
//      indicators, votes, weights, meta_opinion, ml_features, etc.)
//   2. For each (strategy, regime, market) bucket with ≥ MIN_BUCKET closes,
//      compute for each candidate feature the conditional win-rate AND avg
//      P&L when the feature is true vs false, the lift over baseline, and a
//      sample-weighted confidence tier (high/medium/low/insufficient).
//   3. Spurious filter: drop edges with |lift| < SPURIOUS_LIFT_THRESHOLD even
//      if the sample is large — small lifts at high N are noise, not signal.
//   4. Persist the resulting graph (topN edges with positive AND negative
//      lift) as JSONB per context bucket. Cache in-memory for fast reads.

const db = require('./db');

const MAX_CLOSES = 800;                // window of recent closed trades to mine
const MIN_BUCKET_CLOSES = 12;          // need ≥12 closes in a bucket to mine
const MIN_FEATURE_TRUE = 4;            // need ≥4 trues AND ≥4 falses per feature
const SPURIOUS_LIFT_THRESHOLD = 0.06;  // |Δwin-rate| < 6pp ⇒ flag as no-effect
const HIGH_CONF_LIFT = 0.15;           // ≥15pp lift ⇒ HIGH confidence tier
const MED_CONF_LIFT = 0.08;            // ≥8pp ⇒ MEDIUM
const REFRESH_TTL_MS = 30 * 60 * 1000; // 30 min — slow-moving signal
const TOP_EDGES = 5;                   // render at most this many per direction

let _cache = { byContext: new Map(), updated: 0 };
// Independent throttle for DB loads — guarantees we never re-read the
// causal_insights table more than once per TTL window, even when the cache
// is empty (cold-start). Without this, getGraph() in a cold-start state
// would hit the DB per-symbol per-cycle. Also serialises concurrent loads
// so a burst of getGraph() calls only triggers one DB query.
// Initialised to module-load time (NOT 0) so a runtime caller cannot
// self-trigger a refresh/load before the boot warm-up scheduler in agent.js
// fires its delayed startup call. The boot scheduler passes force:true so
// it always wins; subsequent in-window callers stay throttled.
let _loadAttemptedAt = Date.now();
let _loadInFlight = null;
let _refreshAttemptedAt = Date.now();
let _refreshInFlight = null;

// --- Feature extraction --------------------------------------------------
// Each feature is a pure (audit_payload, models, signal) → boolean function.
// Keep them mechanical and side-effect free so the analysis is reproducible.
const FEATURES = [
  {
    key: 'high_confidence',
    label: 'entry confidence ≥ 90%',
    fn: (a) => Number(a.confidence) >= 0.90,
  },
  {
    key: 'unanimous_quorum',
    label: 'all 4 models voted same way',
    fn: (a) => {
      const v = a.payload?.votes; if (!v) return false;
      const max = Math.max(v.BUY || 0, v.SELL || 0, v.HOLD || 0);
      const total = (v.BUY || 0) + (v.SELL || 0) + (v.HOLD || 0);
      return total >= 4 && max >= 4;
    },
  },
  {
    key: 'meta_agrees',
    label: 'meta-reasoner agreed with consensus',
    fn: (a) => {
      const meta = a.payload?.meta_opinion;
      if (!meta) return false;
      return meta.action === a.decision;
    },
  },
  {
    key: 'meta_high_conf',
    label: 'meta-reasoner conf ≥ 80%',
    fn: (a) => Number(a.payload?.meta_opinion?.confidence) >= 0.80,
  },
  {
    key: 'weighted_matches_raw',
    label: 'weighted consensus matched raw consensus',
    fn: (a) => {
      const wc = a.payload?.weighted_consensus;
      return wc && wc === a.decision;
    },
  },
  {
    key: 'rsi_neutral',
    label: 'RSI in 45-65 zone (no extremes)',
    fn: (a) => {
      const rsi = Number(a.payload?.indicators?.rsi);
      return Number.isFinite(rsi) && rsi >= 45 && rsi <= 65;
    },
  },
  {
    key: 'macd_positive',
    label: 'MACD line above signal',
    fn: (a) => {
      const m = a.payload?.indicators?.macd;
      if (!m) return false;
      return Number(m.macd) > Number(m.signal);
    },
  },
  {
    key: 'positive_news',
    label: 'positive news sentiment',
    fn: (a) => {
      const s = a.payload?.newsSentiment;
      if (!s) return false;
      const score = Number(s.score);
      return Number.isFinite(score) && score > 0.15;
    },
  },
  {
    key: 'high_volume',
    label: 'volume above 20-day average',
    fn: (a) => {
      const ind = a.payload?.indicators;
      const v = Number(ind?.volume), avg = Number(ind?.volumeAvg20 || ind?.avgVolume);
      return Number.isFinite(v) && Number.isFinite(avg) && avg > 0 && v > avg;
    },
  },
  {
    key: 'options_unusual',
    label: 'unusual options activity flagged',
    fn: (a) => Boolean(a.payload?.optionsActivity || a.payload?.options_unusual),
  },
  {
    key: 'ml_high_pwin',
    label: 'ML adaptive p(win) ≥ 60%',
    fn: (a) => Number(a.payload?.ml_features?.pWin || a.payload?.ml_pwin) >= 0.60,
  },
];

// One-pass mining over an array of closed-trade records. Each record has:
//   { pnl, audit }   audit = { decision, confidence, payload, models }
// Returns { features: [{key, label, n_true, n_false, wr_true, wr_false, lift,
//   pnl_true, pnl_false, confidenceTier, spurious}], baseline_wr, n }.
function mineBucket(closes) {
  const n = closes.length;
  const wins = closes.filter(c => c.pnl > 0).length;
  const baseline_wr = n > 0 ? wins / n : 0;
  const baseline_pnl = n > 0 ? closes.reduce((s, c) => s + c.pnl, 0) / n : 0;

  const out = [];
  for (const f of FEATURES) {
    let nT = 0, nF = 0, wT = 0, wF = 0, pT = 0, pF = 0;
    for (const c of closes) {
      let v;
      try { v = f.fn(c.audit); } catch (_) { continue; }
      if (v === true) { nT++; if (c.pnl > 0) wT++; pT += c.pnl; }
      else if (v === false) { nF++; if (c.pnl > 0) wF++; pF += c.pnl; }
    }
    if (nT < MIN_FEATURE_TRUE || nF < MIN_FEATURE_TRUE) continue;
    const wr_true = wT / nT;
    const wr_false = wF / nF;
    const lift = wr_true - wr_false;
    const pnl_true = pT / nT;
    const pnl_false = pF / nF;
    const absLift = Math.abs(lift);
    const spurious = absLift < SPURIOUS_LIFT_THRESHOLD;
    let tier = 'insufficient';
    if (absLift >= HIGH_CONF_LIFT) tier = 'high';
    else if (absLift >= MED_CONF_LIFT) tier = 'medium';
    else if (absLift >= SPURIOUS_LIFT_THRESHOLD) tier = 'low';
    out.push({
      key: f.key, label: f.label,
      n_true: nT, n_false: nF,
      wr_true: +wr_true.toFixed(3), wr_false: +wr_false.toFixed(3),
      lift: +lift.toFixed(3),
      pnl_true: +pnl_true.toFixed(2), pnl_false: +pnl_false.toFixed(2),
      pnl_lift: +(pnl_true - pnl_false).toFixed(2),
      confidenceTier: tier, spurious,
    });
  }
  return { features: out, baseline_wr: +baseline_wr.toFixed(3), baseline_pnl: +baseline_pnl.toFixed(2), n };
}

// Pull recent closes joined to their originating TRADE_EXECUTED audit. We
// join on (symbol, strategy) within a 14-day window before the SELL — same
// as adaptiveLearningService's per-model attribution path.
async function loadRecentClosesWithAudit() {
  const { rows: closes } = await db.query(`
    SELECT t.id, t.symbol, t.strategy, t.created_at, t.pnl, t.market
    FROM trades t
    WHERE t.pnl IS NOT NULL AND t.side = 'SELL'
    ORDER BY t.created_at DESC
    LIMIT $1
  `, [MAX_CLOSES]);

  const enriched = [];
  for (const c of closes) {
    const pnl = parseFloat(c.pnl);
    if (!Number.isFinite(pnl)) continue;
    const { rows: a } = await db.query(`
      SELECT decision, confidence, payload, models
      FROM audit_log
      WHERE event_type = 'TRADE_EXECUTED' AND symbol = $1
        AND decision = 'BUY' AND created_at <= $2
        AND created_at >= $2 - INTERVAL '14 days'
        AND payload->>'strategy' = $3
      ORDER BY created_at DESC
      LIMIT 1
    `, [c.symbol, c.created_at, c.strategy]);
    if (!a[0]) continue;
    const audit = a[0];
    const regime = audit.payload?.regime?.primary || audit.payload?.regime || 'unknown';
    const market = audit.payload?.market || c.market || 'US';
    enriched.push({
      pnl, symbol: c.symbol, strategy: c.strategy, regime, market,
      audit: { decision: audit.decision, confidence: Number(audit.confidence), payload: audit.payload, models: audit.models },
    });
  }
  return enriched;
}

// Build the full causal graph (one bucket per (strategy, regime, market))
// and persist to causal_insights. Returns summary {bucketsBuilt, totalCloses}.
// TTL-throttled and in-flight-deduped so neither cold-start nor a burst of
// callers can trigger more than one refresh per window.
async function refresh({ force = false } = {}) {
  if (_refreshInFlight) return _refreshInFlight;
  if (!force && Date.now() - _refreshAttemptedAt < REFRESH_TTL_MS) {
    return { bucketsBuilt: _cache.byContext.size, totalCloses: 0, throttled: true };
  }
  _refreshAttemptedAt = Date.now();
  _refreshInFlight = (async () => {
  try {
    const enriched = await loadRecentClosesWithAudit();
    if (!enriched.length) return { bucketsBuilt: 0, totalCloses: 0 };

    // Bucket the closes.
    const byCtx = new Map();
    for (const c of enriched) {
      const key = `${c.strategy}|${c.regime}|${c.market}`;
      const arr = byCtx.get(key) || [];
      arr.push(c);
      byCtx.set(key, arr);
    }

    let built = 0;
    const newCache = new Map();
    for (const [key, closes] of byCtx) {
      if (closes.length < MIN_BUCKET_CLOSES) continue;
      const [strategy, regime, market] = key.split('|');
      const mined = mineBucket(closes);
      const payload = {
        baseline_wr: mined.baseline_wr,
        baseline_pnl: mined.baseline_pnl,
        n: mined.n,
        features: mined.features,
        updated_at: new Date().toISOString(),
      };
      try {
        await db.query(`
          INSERT INTO causal_insights (strategy, regime, market, payload, n_closes, updated_at)
          VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
          ON CONFLICT (strategy, regime, market) DO UPDATE SET
            payload    = EXCLUDED.payload,
            n_closes   = EXCLUDED.n_closes,
            updated_at = NOW()
        `, [strategy, regime, market, JSON.stringify(payload), mined.n]);
        built++;
      } catch (e) {
        console.warn(`[Causal] persist ${key} failed:`, e.message);
      }
      newCache.set(key, payload);
    }
    _cache = { byContext: newCache, updated: Date.now() };
    return { bucketsBuilt: built, totalCloses: enriched.length };
  } catch (e) {
    console.error('[Causal] refresh failed (swallowed):', e.message);
    return { bucketsBuilt: 0, totalCloses: 0, error: e.message };
  }
  })();
  try { return await _refreshInFlight; } finally { _refreshInFlight = null; }
}

async function loadCache(force = false) {
  // TTL-throttled UNCONDITIONALLY — empty cache must not relax the gate.
  // Without this, a cold-start (no rows in causal_insights yet) would re-hit
  // the DB on every getGraph() call (every symbol, every cycle). Also dedupes
  // concurrent callers to a single in-flight load.
  if (!force && Date.now() - _loadAttemptedAt < REFRESH_TTL_MS) return _cache;
  if (_loadInFlight) return _loadInFlight;
  _loadAttemptedAt = Date.now();
  _loadInFlight = (async () => {
    try {
      const { rows } = await db.query('SELECT strategy, regime, market, payload, n_closes FROM causal_insights');
      const m = new Map();
      for (const r of rows) {
        m.set(`${r.strategy}|${r.regime}|${r.market}`, { ...r.payload, n: r.n_closes });
      }
      _cache = { byContext: m, updated: Date.now() };
    } catch (e) {
      console.error('[Causal] loadCache failed:', e.message);
      if (!_cache.byContext) _cache = { byContext: new Map(), updated: Date.now() };
    }
    return _cache;
  })();
  try { return await _loadInFlight; } finally { _loadInFlight = null; }
}

// Public: get the graph for one (strategy, regime, market) context.
async function getGraph({ strategy, regime, market }) {
  await loadCache();
  const reg = regime?.primary || regime || 'unknown';
  const key = `${strategy || 'day'}|${reg}|${market || 'US'}`;
  return _cache.byContext.get(key) || null;
}

// Render a compact 4-6 line prompt block — top positive AND top negative
// drivers (filtered: non-spurious, sorted by |lift|), plus baseline.
function renderForPrompt(graph) {
  if (!graph || !graph.features?.length) return null;
  const real = graph.features.filter(f => !f.spurious);
  if (!real.length) return null;
  const positives = real.filter(f => f.lift > 0).sort((a, b) => b.lift - a.lift).slice(0, TOP_EDGES);
  const negatives = real.filter(f => f.lift < 0).sort((a, b) => a.lift - b.lift).slice(0, TOP_EDGES);
  const lines = [];
  lines.push(`Causal drivers (n=${graph.n} closed trades, baseline win-rate ${(graph.baseline_wr * 100).toFixed(0)}%):`);
  if (positives.length) {
    lines.push('  Positive drivers (raise win-rate):');
    for (const f of positives) {
      lines.push(`    • ${f.label}: +${(f.lift * 100).toFixed(0)}pp (n=${f.n_true}/${f.n_false}, ${f.confidenceTier})`);
    }
  }
  if (negatives.length) {
    lines.push('  Negative drivers (lower win-rate):');
    for (const f of negatives) {
      lines.push(`    • ${f.label}: ${(f.lift * 100).toFixed(0)}pp (n=${f.n_true}/${f.n_false}, ${f.confidenceTier})`);
    }
  }
  lines.push('  (informational — derived from realised P&L; never gates trading)');
  return lines.join('\n');
}

async function getDashboardSummary() {
  await loadCache(false);
  const buckets = [];
  for (const [key, payload] of _cache.byContext) {
    const [strategy, regime, market] = key.split('|');
    buckets.push({
      strategy, regime, market, n: payload.n,
      baseline_wr: payload.baseline_wr,
      topDriver: payload.features?.filter(f => !f.spurious).sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift))[0] || null,
    });
  }
  return {
    bucketCount: buckets.length,
    minBucketCloses: MIN_BUCKET_CLOSES,
    spuriousThreshold: SPURIOUS_LIFT_THRESHOLD,
    featureCount: FEATURES.length,
    buckets,
  };
}

module.exports = {
  refresh, getGraph, renderForPrompt, getDashboardSummary,
  MAX_CLOSES, MIN_BUCKET_CLOSES, FEATURES,
};
