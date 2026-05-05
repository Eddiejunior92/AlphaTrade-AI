// Counterfactual Reasoning Layer.
//
// For every recent closed trade we replay a small set of canned decision-rule
// counterfactuals over the audit history and ask: "what would aggregate P&L
// have looked like if we'd applied THIS rule at decision time?". The output
// is a 3-5 line summary block per (strategy × regime × market) injected into
// every LLM prompt so the voters can see whether tightening/loosening any
// specific decision rule would have helped historically — without ever
// changing the live rules. This is a learning-from-history layer, not a
// gating layer.
//
// Counterfactuals are intentionally DECISION-RULE based (not bar-replay) so
// we don't need to refetch historical bars or simulate execution. Each
// counterfactual filters the closed-trade set using audit metadata that was
// available at decision time, then sums the realised P&L of the trades that
// SURVIVE the filter — the trades that would still have been taken under
// the counterfactual rule. Comparing that to the actual baseline tells us
// whether the rule would have been an improvement, a wash, or a regression.
//
// SAFETY CONTRACT: strictly INFORMATIONAL. Never gates trading, never sizes
// a position, never overrides quorum/gate/breaker/kill-switch/trailing-stop.
// All failures swallow silently. Quorum (3-of-4), 85% confidence threshold,
// $100/day USD loss budget, 5% drawdown circuit breaker, kill switch, and
// trailing-stop ratchet ALL retain full veto power.

const db = require('./db');
const causalInference = require('./causalInferenceService');

const MAX_CLOSES = 400;                 // smaller window than causal — recency matters here
const MIN_BUCKET_CLOSES = 10;
const REFRESH_TTL_MS = 30 * 60 * 1000;  // 30 min — slow signal
const TOP_RESULTS = 4;                  // render at most this many in the prompt block

let _cache = { byContext: new Map(), updated: 0 };
// TTL throttle + in-flight dedupe for refresh(). Without these, an empty
// bucket map (cold-start) would let getResults() schedule a background
// refresh on every symbol per cycle. Also serialises a burst of callers
// to a single replay.
// Initialised to module-load time (NOT 0) so a runtime call to getResults()
// cannot self-trigger a refresh before the boot warm-up scheduler in agent.js
// fires its delayed startup call. Boot scheduler passes force:true to win.
let _refreshAttemptedAt = Date.now();
let _refreshInFlight = null;

// Each counterfactual is a (label, predicate). The predicate returns true
// when the trade WOULD STILL HAVE BEEN TAKEN under the counterfactual rule,
// i.e. when the rule does NOT filter it out. All predicates are pure
// functions of audit metadata that was available at decision time.
const COUNTERFACTUALS = [
  {
    key: 'tighter_conf_88',
    label: 'require entry confidence ≥ 88%',
    survives: (a) => Number(a.confidence) >= 0.88,
  },
  {
    key: 'tighter_conf_92',
    label: 'require entry confidence ≥ 92%',
    survives: (a) => Number(a.confidence) >= 0.92,
  },
  {
    key: 'unanimous_quorum',
    label: 'require 4/4 unanimous quorum',
    survives: (a) => {
      const v = a.payload?.votes; if (!v) return false;
      const max = Math.max(v.BUY || 0, v.SELL || 0, v.HOLD || 0);
      return max >= 4;
    },
  },
  {
    key: 'meta_must_agree',
    label: 'skip when meta-reasoner disagreed',
    survives: (a) => {
      const meta = a.payload?.meta_opinion;
      if (!meta) return true; // no meta opinion → don't filter
      return meta.action === a.decision;
    },
  },
  {
    key: 'meta_high_conf',
    label: 'require meta-reasoner conf ≥ 75%',
    survives: (a) => {
      const meta = a.payload?.meta_opinion;
      if (!meta) return true;
      return Number(meta.confidence) >= 0.75;
    },
  },
  {
    key: 'weighted_must_match',
    label: 'require weighted consensus = raw consensus',
    survives: (a) => {
      const wc = a.payload?.weighted_consensus;
      if (!wc) return true;
      return wc === a.decision;
    },
  },
  {
    key: 'skip_high_vol_regimes',
    label: 'skip VOL_SPIKE / RATE_SHOCK regimes',
    survives: (a) => {
      const reg = a.payload?.regime?.primary || a.payload?.regime || '';
      return !['VOL_SPIKE', 'RATE_SHOCK'].includes(reg);
    },
  },
  {
    key: 'ml_pwin_min',
    label: 'require ML p(win) ≥ 55%',
    survives: (a) => {
      const p = Number(a.payload?.ml_features?.pWin || a.payload?.ml_pwin);
      if (!Number.isFinite(p)) return true;
      return p >= 0.55;
    },
  },
];

// Loads recent closed-trade + audit pairs. Re-implemented here (rather than
// imported) because causalInferenceService caches its own enriched list and
// we want the SAME data shape but with separate ownership.
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
      pnl, strategy: c.strategy, regime, market,
      audit: { decision: audit.decision, confidence: Number(audit.confidence), payload: audit.payload },
    });
  }
  return enriched;
}

// Run all counterfactuals across one bucket. Returns:
// { baseline: {n, wins, totalPnl, wr, avgPnl}, results: [{key, label,
//    keptN, droppedN, keptPnl, droppedPnl, keptWr, deltaPnl, verdict}] }
function runBucket(closes) {
  const n = closes.length;
  const wins = closes.filter(c => c.pnl > 0).length;
  const totalPnl = closes.reduce((s, c) => s + c.pnl, 0);
  const baseline = {
    n, wins, totalPnl: +totalPnl.toFixed(2),
    wr: n > 0 ? +(wins / n).toFixed(3) : 0,
    avgPnl: n > 0 ? +(totalPnl / n).toFixed(2) : 0,
  };

  const results = [];
  for (const cf of COUNTERFACTUALS) {
    let keptN = 0, droppedN = 0, keptPnl = 0, droppedPnl = 0, keptWins = 0, droppedLosses = 0, droppedWins = 0;
    for (const c of closes) {
      let keep;
      try { keep = cf.survives(c.audit); } catch (_) { keep = true; } // err → don't filter
      if (keep) { keptN++; keptPnl += c.pnl; if (c.pnl > 0) keptWins++; }
      else      { droppedN++; droppedPnl += c.pnl; if (c.pnl > 0) droppedWins++; else droppedLosses++; }
    }
    if (droppedN === 0) continue; // counterfactual identical to baseline — skip
    const keptWr = keptN > 0 ? keptWins / keptN : 0;
    const deltaPnl = keptPnl - totalPnl;
    let verdict;
    if (deltaPnl > Math.abs(totalPnl) * 0.10 + 5) verdict = 'IMPROVES';
    else if (deltaPnl < -(Math.abs(totalPnl) * 0.10 + 5)) verdict = 'WORSENS';
    else verdict = 'wash';
    results.push({
      key: cf.key, label: cf.label,
      keptN, droppedN,
      keptPnl: +keptPnl.toFixed(2),
      droppedPnl: +droppedPnl.toFixed(2),
      droppedWins, droppedLosses,
      keptWr: +keptWr.toFixed(3),
      deltaPnl: +deltaPnl.toFixed(2),
      verdict,
    });
  }
  // Sort by absolute deltaPnl so the strongest (positive or negative) signals come first.
  results.sort((a, b) => Math.abs(b.deltaPnl) - Math.abs(a.deltaPnl));
  return { baseline, results };
}

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
      const out = runBucket(closes);
      newCache.set(key, { ...out, updated_at: new Date().toISOString() });
      built++;
    }
    _cache = { byContext: newCache, updated: Date.now() };
    return { bucketsBuilt: built, totalCloses: enriched.length };
  } catch (e) {
    console.error('[Counterfactual] refresh failed (swallowed):', e.message);
    return { bucketsBuilt: 0, totalCloses: 0, error: e.message };
  }
  })();
  try { return await _refreshInFlight; } finally { _refreshInFlight = null; }
}

async function getResults({ strategy, regime, market }) {
  // TTL-only gate — empty cache no longer triggers a refresh per call.
  // The TTL-throttled refresh() inside fires at most once per window even
  // if many getResults() calls request it; the boot-time + 30-min interval
  // scheduler in agent.js handles the steady-state refresh cadence.
  if (Date.now() - _refreshAttemptedAt > REFRESH_TTL_MS) {
    refresh().catch(() => {}); // background, non-blocking, internally throttled
  }
  const reg = regime?.primary || regime || 'unknown';
  const key = `${strategy || 'day'}|${reg}|${market || 'US'}`;
  return _cache.byContext.get(key) || null;
}

function renderForPrompt(bucket) {
  if (!bucket || !bucket.results?.length) return null;
  const top = bucket.results.slice(0, TOP_RESULTS);
  const b = bucket.baseline;
  const lines = [];
  lines.push(`Counterfactual replay (n=${b.n}, baseline P&L=$${b.totalPnl} · wr ${(b.wr * 100).toFixed(0)}%):`);
  for (const r of top) {
    const sign = r.deltaPnl >= 0 ? '+' : '';
    lines.push(`  • ${r.label}: would skip ${r.droppedN} (${r.droppedWins}W/${r.droppedLosses}L) → Δ=${sign}$${r.deltaPnl} [${r.verdict}]`);
  }
  lines.push('  (informational — historical replay only; never overrides current quorum/gate)');
  return lines.join('\n');
}

async function getDashboardSummary() {
  const buckets = [];
  for (const [key, val] of _cache.byContext) {
    const [strategy, regime, market] = key.split('|');
    buckets.push({
      strategy, regime, market,
      n: val.baseline.n,
      totalPnl: val.baseline.totalPnl,
      topImprover: val.results.find(r => r.verdict === 'IMPROVES') || null,
      topWorsener: val.results.find(r => r.verdict === 'WORSENS') || null,
    });
  }
  return {
    bucketCount: buckets.length,
    minBucketCloses: MIN_BUCKET_CLOSES,
    counterfactualCount: COUNTERFACTUALS.length,
    buckets,
  };
}

module.exports = {
  refresh, getResults, renderForPrompt, getDashboardSummary,
  MAX_CLOSES, MIN_BUCKET_CLOSES, COUNTERFACTUALS,
};
