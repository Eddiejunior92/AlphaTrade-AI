// Automated Strategy Discovery Layer.
//
// Periodically generates a small population of candidate decision-rule
// VARIATIONS (tweaks to the confidence gate, meta-reasoner requirements,
// quorum, regime filters, ML-pwin floor, etc.), backtests each one against
// the closed-trade audit history, and persists the strongest as PENDING
// PROPOSALS for the operator to review on the dashboard. The operator can
// then APPLY a proposal (creating an "active overlay" — an additional
// decision-rule filter that's checked at trade time) or DISMISS it. Proposals
// are NEVER applied automatically — operator approval is mandatory.
//
// Backtesting is DECISION-RULE REPLAY (not bar-replay) — same approach as
// counterfactualService. We reuse closed-trade rows joined to their
// originating TRADE_EXECUTED audit row, then ask: "would aggregate P&L have
// been better or worse if we'd required THIS extra rule at decision time?"
// This avoids any need to refetch historical bars or simulate execution.
//
// SAFETY CONTRACT — STRICTLY ADDITIVE-FILTERING:
//   • Discovery NEVER mutates live trading params, NEVER auto-applies.
//     The strongest finding becomes a 'pending' row in `strategy_proposals`;
//     it stays inactive until an operator hits "Apply" via the operator-
//     gated endpoint.
//   • An "active overlay" (a row in `active_overlays`) is by construction
//     a TIGHTENING filter — when its predicate returns false on a candidate
//     BUY signal, the BUY is downgraded to HOLD. Overlays can ONLY drop
//     trades the existing gate already approved; they CANNOT upgrade HOLD→
//     BUY, lift confidence, bypass quorum, expand sizing, or relax any
//     breaker / kill switch / loss cap / trailing stop / no-averaging rule.
//   • Predicates are pure functions of decision-time SIGNAL/audit metadata
//     (confidence, votes, meta-reasoner opinion, weighted consensus, regime,
//     ML pwin) — same shape as counterfactualService. No external I/O at
//     gate-check time.
//   • Every code path failure (DB, mining, predicate) swallows silently —
//     a discovery hiccup cannot break the trading loop.

const db = require('./db');

const MAX_CLOSES = 400;                    // backtest window, mirrors counterfactual layer
const MIN_BUCKET_CLOSES = 12;              // need at least this many closes per (strat, regime, market) to trust the result
const MIN_KEPT_TRADES = 10;                // proposal must keep at least this many trades — avoids over-fit
const MIN_KEPT_FRACTION = 0.30;            // and at least 30% of the original — avoids "drop everything"
const MIN_DELTA_PCT = 0.05;                // require ≥+5% improvement on baseline gross P&L (or +$5 if baseline ≈ 0)
const MIN_DELTA_ABS = 5;                   // floor for tiny baselines
const REFRESH_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — discovery is a slow, expensive signal
const TOP_PROPOSALS_PER_REFRESH = 10;      // cap how many we persist per cycle

let _refreshAttemptedAt = Date.now();      // initialised to load time so getProposals() can't self-trigger before boot warm-up
let _refreshInFlight = null;
let _activeOverlaysCache = null;
let _activeOverlaysLoadedAt = 0;
const OVERLAYS_CACHE_TTL_MS = 30 * 1000;   // 30s — overlays are tiny but checked every BUY

// ----- Variation generators -------------------------------------------------
//
// A "variation" is a (key, label, predicate, contextScope) where predicate
// returns TRUE when a closed-trade audit row WOULD STILL HAVE BEEN TAKEN
// under the variation's rule (i.e. the rule does NOT filter it out). All
// predicates are pure functions of the decision-time audit payload — exactly
// the metadata available at gate-check time.
//
// contextScope is null for global rules or '${regime}' / '${market}' for
// rules that should only fire in a specific bucket. The replay engine sets
// this when generating regime-specific variations from observed buckets.

function _confGteVariation(threshold) {
  return {
    key: `conf_gte_${Math.round(threshold * 100)}`,
    label: `require entry confidence ≥ ${Math.round(threshold * 100)}%`,
    predicate: (a) => Number(a.confidence) >= threshold,
    def: { kind: 'conf_gte', threshold },
  };
}
function _metaAgreeVariation() {
  return {
    key: 'meta_must_agree',
    label: 'require meta-reasoner agrees with raw consensus',
    predicate: (a) => {
      const m = a.payload?.meta_opinion;
      if (!m) return true;                                                    // missing meta → don't filter (cold-start safe)
      return m.action === a.decision;
    },
    def: { kind: 'meta_must_agree' },
  };
}
function _metaHighConfVariation(threshold) {
  return {
    key: `meta_conf_gte_${Math.round(threshold * 100)}`,
    label: `require meta-reasoner conf ≥ ${Math.round(threshold * 100)}%`,
    predicate: (a) => {
      const m = a.payload?.meta_opinion;
      if (!m) return true;
      return Number(m.confidence) >= threshold;
    },
    def: { kind: 'meta_conf_gte', threshold },
  };
}
function _unanimousQuorumVariation() {
  return {
    key: 'unanimous_quorum',
    label: 'require 4/4 unanimous quorum',
    predicate: (a) => {
      const v = a.payload?.votes;
      if (!v) return false;
      return Math.max(v.BUY || 0, v.SELL || 0, v.HOLD || 0) >= 4;
    },
    def: { kind: 'unanimous_quorum' },
  };
}
function _weightedMatchVariation() {
  return {
    key: 'weighted_must_match',
    label: 'require weighted consensus = raw consensus',
    predicate: (a) => {
      const wc = a.payload?.weighted_consensus;
      if (!wc) return true;
      return wc === a.decision;
    },
    def: { kind: 'weighted_must_match' },
  };
}
function _skipRegimeVariation(regime) {
  return {
    key: `skip_regime_${regime}`,
    label: `skip ${regime} regime`,
    predicate: (a) => {
      const r = a.payload?.regime?.primary || a.payload?.regime || '';
      return r !== regime;
    },
    def: { kind: 'skip_regime', regime },
  };
}
function _mlPwinVariation(threshold) {
  return {
    key: `ml_pwin_gte_${Math.round(threshold * 100)}`,
    label: `require ML p(win) ≥ ${Math.round(threshold * 100)}%`,
    predicate: (a) => {
      const p = Number(a.payload?.ml_features?.pWin || a.payload?.ml_pwin);
      if (!Number.isFinite(p)) return true;                                    // no ML feature → don't filter
      return p >= threshold;
    },
    def: { kind: 'ml_pwin_gte', threshold },
  };
}
// Combined variations — small ANDs of the above. We deliberately keep these
// SHORT (≤2 predicates) to avoid over-fitting the small backtest population.
function _combine(a, b) {
  return {
    key: `${a.key}__AND__${b.key}`,
    label: `${a.label} AND ${b.label}`,
    predicate: (audit) => a.predicate(audit) && b.predicate(audit),
    def: { kind: 'combined', parts: [a.def, b.def] },
  };
}

function _generateVariationPopulation() {
  const single = [
    _confGteVariation(0.86), _confGteVariation(0.88), _confGteVariation(0.90), _confGteVariation(0.92),
    _metaAgreeVariation(),
    _metaHighConfVariation(0.70), _metaHighConfVariation(0.75), _metaHighConfVariation(0.80),
    _unanimousQuorumVariation(),
    _weightedMatchVariation(),
    _skipRegimeVariation('VOL_SPIKE'),
    _skipRegimeVariation('RATE_SHOCK'),
    _skipRegimeVariation('CHOP'),
    _mlPwinVariation(0.55), _mlPwinVariation(0.60), _mlPwinVariation(0.65),
  ];
  // A small curated set of combinations — the most plausible "compound
  // discipline" rules. NOT a Cartesian product (that would explode the
  // population and over-fit).
  const conf88 = single.find(v => v.key === 'conf_gte_88');
  const metaAgree = single.find(v => v.key === 'meta_must_agree');
  const wmatch = single.find(v => v.key === 'weighted_must_match');
  const ml55 = single.find(v => v.key === 'ml_pwin_gte_55');
  const combined = [
    _combine(conf88, metaAgree),
    _combine(conf88, wmatch),
    _combine(metaAgree, wmatch),
    _combine(metaAgree, ml55),
  ];
  return [...single, ...combined];
}

// Re-hydrate a variation predicate from its persisted JSON `def`. Used when
// applying an overlay so the gate-check at trade time has a runnable
// predicate without persisting JS code.
function _predicateFromDef(def) {
  if (!def || !def.kind) return () => true;
  switch (def.kind) {
    case 'conf_gte':           return _confGteVariation(Number(def.threshold)).predicate;
    case 'meta_must_agree':    return _metaAgreeVariation().predicate;
    case 'meta_conf_gte':      return _metaHighConfVariation(Number(def.threshold)).predicate;
    case 'unanimous_quorum':   return _unanimousQuorumVariation().predicate;
    case 'weighted_must_match':return _weightedMatchVariation().predicate;
    case 'skip_regime':        return _skipRegimeVariation(String(def.regime)).predicate;
    case 'ml_pwin_gte':        return _mlPwinVariation(Number(def.threshold)).predicate;
    case 'combined': {
      const parts = (def.parts || []).map(_predicateFromDef);
      return (audit) => parts.every(p => p(audit));
    }
    default: return () => true;
  }
}

// ----- Backtest replay ------------------------------------------------------

async function _loadCloses() {
  const { rows: closes } = await db.query(`
    SELECT t.id, t.symbol, t.strategy, t.created_at, t.pnl, t.market
    FROM trades t
    WHERE t.pnl IS NOT NULL AND t.side = 'SELL'
    ORDER BY t.created_at DESC LIMIT $1
  `, [MAX_CLOSES]);

  const enriched = [];
  for (const c of closes) {
    const pnl = parseFloat(c.pnl);
    if (!Number.isFinite(pnl)) continue;
    // Find the originating BUY's TRADE_EXECUTED audit (same anchoring used by
    // counterfactualService — identical attribution semantics).
    const { rows: a } = await db.query(`
      SELECT decision, confidence, payload
      FROM audit_log
      WHERE event_type = 'TRADE_EXECUTED' AND symbol = $1
        AND decision = 'BUY' AND created_at <= $2
        AND created_at >= $2 - INTERVAL '14 days'
        AND payload->>'strategy' = $3
      ORDER BY created_at DESC LIMIT 1
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

function _runVariation(variation, closes) {
  const baselineN = closes.length;
  const baselinePnl = closes.reduce((s, c) => s + c.pnl, 0);
  const baselineWins = closes.filter(c => c.pnl > 0).length;
  let keptN = 0, droppedN = 0, keptPnl = 0, keptWins = 0;
  for (const c of closes) {
    let keep;
    try { keep = variation.predicate(c.audit); } catch (_) { keep = true; }   // err → don't filter
    if (keep) { keptN++; keptPnl += c.pnl; if (c.pnl > 0) keptWins++; }
    else      { droppedN++; }
  }
  return {
    baselineN, baselinePnl: +baselinePnl.toFixed(2),
    baselineWr: baselineN ? +(baselineWins / baselineN).toFixed(3) : 0,
    keptN, droppedN,
    keptPnl: +keptPnl.toFixed(2),
    keptWr: keptN ? +(keptWins / keptN).toFixed(3) : 0,
    deltaPnl: +(keptPnl - baselinePnl).toFixed(2),
  };
}

// ----- Public refresh: mine + persist proposals -----------------------------

async function refresh({ force = false } = {}) {
  if (_refreshInFlight) return _refreshInFlight;
  if (!force && Date.now() - _refreshAttemptedAt < REFRESH_TTL_MS) {
    return { proposalsInserted: 0, throttled: true };
  }
  _refreshAttemptedAt = Date.now();
  _refreshInFlight = (async () => {
    try {
      const enriched = await _loadCloses();
      if (enriched.length < MIN_BUCKET_CLOSES) {
        return { proposalsInserted: 0, totalCloses: enriched.length, reason: 'insufficient closes' };
      }
      // Bucket by (strategy, regime, market).
      const buckets = new Map();
      for (const c of enriched) {
        const key = `${c.strategy}|${c.regime}|${c.market}`;
        const arr = buckets.get(key) || [];
        arr.push(c);
        buckets.set(key, arr);
      }

      const variations = _generateVariationPopulation();
      const candidates = [];

      for (const [bucketKey, closes] of buckets.entries()) {
        if (closes.length < MIN_BUCKET_CLOSES) continue;
        const [strategy, regime, market] = bucketKey.split('|');
        for (const v of variations) {
          const r = _runVariation(v, closes);
          if (r.droppedN === 0) continue;                                       // identical to baseline — useless
          if (r.keptN < MIN_KEPT_TRADES) continue;                              // over-fit guard
          if (r.keptN / r.baselineN < MIN_KEPT_FRACTION) continue;              // "drop everything" guard
          const required = Math.max(MIN_DELTA_ABS, Math.abs(r.baselinePnl) * MIN_DELTA_PCT);
          if (r.deltaPnl < required) continue;                                  // not strong enough
          candidates.push({
            rule_key: v.key, rule_label: v.label, rule_def: v.def,
            strategy, regime, market, ...r,
          });
        }
      }

      candidates.sort((a, b) => b.deltaPnl - a.deltaPnl);
      const top = candidates.slice(0, TOP_PROPOSALS_PER_REFRESH);

      // Insert as 'pending'. Dedup: if there's ALREADY a pending or applied
      // proposal for the same (rule_key, strategy, regime, market), skip.
      // Dismissed rows DON'T block re-proposing — the operator may want to
      // see a stronger signal later if the underlying data shifted.
      let inserted = 0;
      for (const p of top) {
        try {
          const { rows: existing } = await db.query(`
            SELECT id FROM strategy_proposals
            WHERE rule_key=$1 AND strategy=$2 AND regime=$3 AND market=$4
              AND status IN ('pending', 'applied')
            LIMIT 1
          `, [p.rule_key, p.strategy, p.regime, p.market]);
          if (existing.length) continue;
          await db.query(`
            INSERT INTO strategy_proposals
              (rule_key, rule_label, rule_def, strategy, regime, market,
               baseline_n, baseline_pnl, baseline_wr,
               kept_n, dropped_n, kept_pnl, kept_wr, delta_pnl, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending')
          `, [
            p.rule_key, p.rule_label, JSON.stringify(p.rule_def),
            p.strategy, p.regime, p.market,
            p.baselineN, p.baselinePnl, p.baselineWr,
            p.keptN, p.droppedN, p.keptPnl, p.keptWr, p.deltaPnl,
          ]);
          inserted++;
        } catch (e) { console.warn('[StrategyDiscovery] insert failed:', e.message); }
      }
      return { proposalsInserted: inserted, candidates: candidates.length, bucketsEvaluated: buckets.size, totalCloses: enriched.length };
    } catch (e) {
      console.error('[StrategyDiscovery] refresh failed (swallowed):', e.message);
      return { proposalsInserted: 0, error: e.message };
    }
  })();
  try { return await _refreshInFlight; } finally { _refreshInFlight = null; }
}

async function getProposals({ status = 'pending', limit = 50 } = {}) {
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const { rows } = await db.query(`
    SELECT * FROM strategy_proposals
    WHERE status = $1
    ORDER BY delta_pnl DESC, created_at DESC
    LIMIT $2
  `, [status, lim]);
  return rows;
}

// ----- Apply / Dismiss ------------------------------------------------------

async function applyProposal({ id, appliedBy = 'operator' }) {
  const pid = parseInt(id, 10);
  if (!Number.isFinite(pid)) throw new Error('proposal id required');
  const { rows: prop } = await db.query(`SELECT * FROM strategy_proposals WHERE id=$1`, [pid]);
  if (!prop.length) throw new Error('proposal not found');
  const p = prop[0];
  if (p.status !== 'pending') throw new Error(`cannot apply — status is '${p.status}'`);
  // Insert into active_overlays first; mark proposal applied only on success.
  const ins = await db.query(`
    INSERT INTO active_overlays
      (rule_key, rule_label, rule_def, strategy, regime, market, source_proposal_id, applied_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (rule_key, strategy, regime, market) DO NOTHING
    RETURNING id
  `, [p.rule_key, p.rule_label, p.rule_def, p.strategy, p.regime, p.market, p.id, appliedBy]);
  await db.query(`
    UPDATE strategy_proposals SET status='applied', decided_at=NOW() WHERE id=$1
  `, [pid]);
  _activeOverlaysCache = null;                                                   // bust gate-check cache so next BUY sees the new overlay
  return { ok: true, overlayId: ins.rows[0]?.id || null, proposal: { id: p.id, rule_key: p.rule_key } };
}

async function dismissProposal({ id, dismissedBy = 'operator' }) {
  const pid = parseInt(id, 10);
  if (!Number.isFinite(pid)) throw new Error('proposal id required');
  const r = await db.query(`
    UPDATE strategy_proposals SET status='dismissed', decided_at=NOW(), dismissed_by=$2
    WHERE id=$1 AND status='pending' RETURNING id
  `, [pid, dismissedBy]);
  if (!r.rows.length) throw new Error('proposal not found or already decided');
  return { ok: true, id: r.rows[0].id };
}

async function revokeOverlay({ id }) {
  const oid = parseInt(id, 10);
  if (!Number.isFinite(oid)) throw new Error('overlay id required');
  const r = await db.query(`DELETE FROM active_overlays WHERE id=$1 RETURNING source_proposal_id`, [oid]);
  if (!r.rows.length) throw new Error('overlay not found');
  // Move the source proposal back to 'dismissed' so it doesn't get re-applied
  // accidentally — operator can re-discover it on the next refresh if desired.
  if (r.rows[0].source_proposal_id) {
    await db.query(`UPDATE strategy_proposals SET status='dismissed', decided_at=NOW() WHERE id=$1`,
      [r.rows[0].source_proposal_id]);
  }
  _activeOverlaysCache = null;
  return { ok: true };
}

// ----- Trade-time gate hook -------------------------------------------------
//
// Called from riskManager on every BUY candidate. Returns:
//   { allow: true }                            — no overlay applies, or all pass
//   { allow: false, blockedBy: 'rule_key', reason: '<human readable>' }
//
// Critical: this can ONLY return allow:false. There is no path that returns
// allow:true when the existing gate said allow:false — overlays are
// strictly ADDITIVE filters on top of the existing safety stack.

async function _loadActiveOverlays() {
  if (_activeOverlaysCache && Date.now() - _activeOverlaysLoadedAt < OVERLAYS_CACHE_TTL_MS) {
    return _activeOverlaysCache;
  }
  try {
    const { rows } = await db.query(`SELECT id, rule_key, rule_label, rule_def, strategy, regime, market FROM active_overlays`);
    _activeOverlaysCache = rows.map(r => ({
      ...r,
      _predicate: _predicateFromDef(typeof r.rule_def === 'string' ? JSON.parse(r.rule_def) : r.rule_def),
    }));
    _activeOverlaysLoadedAt = Date.now();
  } catch (e) {
    // On error, return empty list — we MUST NOT add risk by failing open
    // toward "block everything", but we also MUST NOT silently bypass an
    // overlay. Treating as empty is safe because the existing gate stack
    // remains fully in force.
    console.warn('[StrategyDiscovery] overlay load failed (treating as none):', e.message);
    _activeOverlaysCache = [];
    _activeOverlaysLoadedAt = Date.now();
  }
  return _activeOverlaysCache;
}

// signal: the llmService output (consensus, confidence, votes, weightedConsensus, meta, etc.)
// strategy/regime/market: decision context
function _signalToAuditShape({ signal, strategy, regime, market }) {
  // Build the same payload shape the predicates expect (mirrors what
  // TRADE_EXECUTED audit rows carry — see audit emit in agent.js).
  return {
    decision: signal.consensus,
    confidence: signal.confidence,
    payload: {
      strategy, market,
      regime: regime?.primary ? { primary: regime.primary } : (regime || 'unknown'),
      votes: signal.votes,
      weighted_consensus: signal.weightedConsensus,
      meta_opinion: signal.meta ? { action: signal.meta.action, confidence: signal.meta.confidence } : null,
      ml_features: signal.ml_features || null,
      ml_pwin: signal.ml_pwin || null,
    },
  };
}

async function checkOverlays({ signal, strategy, regime, market }) {
  try {
    if (!signal || signal.consensus !== 'BUY') return { allow: true };           // overlays only apply to BUY decisions
    const overlays = await _loadActiveOverlays();
    if (!overlays.length) return { allow: true };
    const audit = _signalToAuditShape({ signal, strategy, regime, market });
    const stratName = strategy || 'day';
    const reg = regime?.primary || regime || 'unknown';
    const mkt = market || 'US';
    for (const o of overlays) {
      // Scope match: overlay applies if its (strategy, regime, market) match
      // the candidate, or if the overlay's field is the wildcard '*'.
      const scopeMatch =
        (o.strategy === '*' || o.strategy === stratName) &&
        (o.regime === '*' || o.regime === reg) &&
        (o.market === '*' || o.market === mkt);
      if (!scopeMatch) continue;
      let pass;
      try { pass = o._predicate(audit); } catch (_) { pass = true; }              // predicate error → don't filter (cold-start safe)
      if (!pass) {
        return {
          allow: false, blockedBy: o.rule_key,
          reason: `Overlay "${o.rule_label}" blocked BUY (strategy=${stratName}, regime=${reg}, market=${mkt})`,
        };
      }
    }
    return { allow: true };
  } catch (e) {
    // Hard contract: gate-check failures DO NOT add risk — return allow:true.
    // The existing quorum/conf/breaker stack remains fully in force.
    console.warn('[StrategyDiscovery] checkOverlays failed (allowing):', e.message);
    return { allow: true };
  }
}

async function getActiveOverlays() {
  const { rows } = await db.query(`
    SELECT id, rule_key, rule_label, rule_def, strategy, regime, market, applied_at, applied_by, source_proposal_id
    FROM active_overlays ORDER BY applied_at DESC
  `);
  return rows;
}

async function getDashboardSummary() {
  const [pending, applied, overlays] = await Promise.all([
    getProposals({ status: 'pending' }),
    getProposals({ status: 'applied', limit: 20 }),
    getActiveOverlays(),
  ]);
  return {
    pendingCount: pending.length, pending,
    appliedCount: applied.length,
    overlays,
    nextRefreshAt: _refreshAttemptedAt + REFRESH_TTL_MS,
    refreshIntervalMs: REFRESH_TTL_MS,
  };
}

module.exports = {
  refresh, getProposals, applyProposal, dismissProposal, revokeOverlay,
  checkOverlays, getActiveOverlays, getDashboardSummary,
  _internal: {
    _generateVariationPopulation, _runVariation, _predicateFromDef,
    _signalToAuditShape, _loadActiveOverlays,
  },
};
