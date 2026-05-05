// Intelligent Safety Suggestion Layer.
//
// Analyses recent realised P&L per strategy + leverages the counterfactual
// replay layer to produce a small, bounded set of data-backed safety
// suggestions for the user. The user — and ONLY the user — decides whether
// to apply or reject each suggestion via the dashboard. Nothing is ever
// applied automatically.
//
// Hard design rules (the safety contract for this layer):
//
//   1. WHITELISTED KINDS ONLY. The applier dispatches via a hard-coded
//      `KINDS` whitelist; an unknown kind is rejected before any state is
//      touched. We will never invent new tunable surfaces — every kind maps
//      onto an *existing* audited writer the user could already invoke
//      themselves through the dashboard (setRiskScale, setStrategyEnabled).
//
//   2. BOUNDED SUGGESTIONS. risk_scale_change can only target the three
//      pre-defined tiers (conservative / balanced / aggressive); we never
//      generate or apply arbitrary numeric overrides. strategy_disable can
//      only set enabled=false (existing positions keep their stops; only
//      new entries are paused). We do NOT generate strategy_enable
//      suggestions — re-enabling a previously-disabled strategy is an
//      explicit user decision, not something this layer should nudge.
//
//   3. IMMUTABLE HARD RAILS. The 3-of-4 quorum, the kill switch, the 5%
//      drawdown circuit breaker, the trailing-stop ratchet, the no-
//      averaging-in rule, and the per-tier confidence/loss-cap floors are
//      NEVER reachable from this surface — they are not knobs we expose.
//      Switching to the Conservative tier *raises* the confidence gate to
//      85% and *lowers* the daily loss cap to $100 — both safety-positive.
//
//   4. EXPIRY. Every suggestion expires after 24h so a stale read of the
//      market state can't be applied days later. Expired suggestions are
//      also blocked from being applied at the apply endpoint as a
//      defence-in-depth check.
//
//   5. AUDITED. Both apply and reject transitions write a tamper-evident
//      audit row (SUGGESTION_APPLIED / SUGGESTION_REJECTED) so every
//      decision is on the chain.

const db = require('./db');
const counterfactual = require('./counterfactualService');

// Hard-coded whitelist of applicable suggestion kinds. The applier dispatches
// strictly off this map; an unknown kind is refused before any state writer
// is invoked. Adding a new kind requires an explicit code change here.
// Defence-in-depth: 'aggressive' is DELIBERATELY excluded from the whitelist.
// Generation also never produces an aggressive suggestion, but excluding it
// here means even a row inserted directly into the DB cannot be applied via
// this surface to escalate to the most aggressive tier. The user must still
// switch to aggressive themselves via the explicit Risk Scale selector.
const KINDS = Object.freeze({
  risk_scale_change: { allowed_targets: ['global'], allowed_values: ['conservative', 'balanced'] },
  strategy_disable:  { allowed_targets: '*', allowed_values: ['disabled'] },
});

const REFRESH_TTL_MS = 30 * 60 * 1000;
const MIN_GLOBAL_CLOSES = 15;
const MIN_STRATEGY_CLOSES = 15;
const RECENT_WINDOW_GLOBAL = 30;
const RECENT_WINDOW_STRATEGY = 15;

// Throttle/dedupe (same pattern as causal/counterfactual services).
let _refreshAttemptedAt = Date.now();
let _refreshInFlight = null;

// Pure generator. Returns an array of candidate suggestion objects (NOT yet
// persisted). The runtime persistence step deduplicates against pending rows
// via the (kind, target, suggested_value) partial unique index.
async function generateCandidates({ portfolio, strategies }) {
  const out = [];

  // Pull last RECENT_WINDOW_GLOBAL global closes.
  const { rows: recent } = await db.query(`
    SELECT pnl, strategy FROM trades
    WHERE pnl IS NOT NULL AND side = 'SELL'
    ORDER BY created_at DESC LIMIT $1
  `, [RECENT_WINDOW_GLOBAL]);

  if (recent.length >= MIN_GLOBAL_CLOSES) {
    const total = recent.reduce((s, t) => s + parseFloat(t.pnl), 0);
    const wins = recent.filter(t => parseFloat(t.pnl) > 0).length;
    const wr = wins / recent.length;
    const currentScale = portfolio?.risk_scale || 'balanced';

    // Counterfactual support: if any pre-computed bucket shows a tightening
    // counterfactual would have IMPROVED net P&L meaningfully, that's
    // additional evidence supporting a step DOWN to conservative.
    let cfSupport = null;
    try {
      const cfSummary = await counterfactual.getDashboardSummary();
      const tightenImprovers = (cfSummary?.buckets || []).filter(b =>
        b.topImprover && (b.topImprover.key?.startsWith('tighter_conf_') || b.topImprover.key === 'unanimous_quorum')
      );
      if (tightenImprovers.length >= 2) {
        cfSupport = `${tightenImprovers.length} contexts where tightening the gate would have improved P&L`;
      }
    } catch (_) {}

    // RULE 1 — Step DOWN to conservative when recent performance is poor.
    // Triggered by net loss OR weak win-rate. Only fires when not already
    // at the safest tier.
    if (currentScale !== 'conservative' && (total < -50 || wr < 0.40 || cfSupport)) {
      const reasons = [];
      if (total < -50) reasons.push(`net P&L $${total.toFixed(2)} over last ${recent.length} closes`);
      if (wr < 0.40) reasons.push(`win-rate ${(wr * 100).toFixed(0)}%`);
      if (cfSupport) reasons.push(cfSupport);
      out.push({
        kind: 'risk_scale_change',
        target: 'global',
        current_value: currentScale,
        suggested_value: 'conservative',
        severity: total < -100 ? 'high' : 'medium',
        rationale: `Step down to Conservative tier. Triggers: ${reasons.join('; ')}. Conservative raises the entry confidence gate to 85% and tightens the daily loss cap to $100 — a bounded, reversible safety nudge. Quorum, kill switch, and circuit breaker are unchanged.`,
        evidence: { window: recent.length, winRate: +wr.toFixed(3), netPnL: +total.toFixed(2), currentScale, counterfactualSupport: cfSupport },
      });
    }

    // RULE 2 — Step UP from conservative to balanced when performance is
    // strong. We DELIBERATELY never auto-suggest jumping to aggressive —
    // the leap to the most aggressive tier should always be a deliberate
    // user decision, not a nudge.
    if (currentScale === 'conservative' && total > 50 && wr > 0.60) {
      out.push({
        kind: 'risk_scale_change',
        target: 'global',
        current_value: currentScale,
        suggested_value: 'balanced',
        severity: 'low',
        rationale: `Step up to Balanced tier. Recent ${recent.length} closes show ${(wr * 100).toFixed(0)}% win-rate and +$${total.toFixed(2)} net P&L — performance supports the larger position band. Balanced still maintains the 80% confidence gate and $200/day loss cap. Always reversible.`,
        evidence: { window: recent.length, winRate: +wr.toFixed(3), netPnL: +total.toFixed(2), currentScale },
      });
    }
  }

  // RULE 3 — Disable an underperforming strategy. Only fires for currently
  // ENABLED strategies with at least MIN_STRATEGY_CLOSES recent closes,
  // weak win-rate AND material net loss. Disabling pauses NEW entries —
  // existing positions keep their stops and trailing logic.
  for (const s of strategies || []) {
    if (!s.enabled) continue;
    const { rows: srows } = await db.query(`
      SELECT pnl FROM trades
      WHERE pnl IS NOT NULL AND side = 'SELL' AND strategy = $1
      ORDER BY created_at DESC LIMIT $2
    `, [s.name, RECENT_WINDOW_STRATEGY]);
    if (srows.length < MIN_STRATEGY_CLOSES) continue;
    const total = srows.reduce((acc, t) => acc + parseFloat(t.pnl), 0);
    const wins = srows.filter(t => parseFloat(t.pnl) > 0).length;
    const wr = wins / srows.length;
    if (wr < 0.35 && total < -30) {
      out.push({
        kind: 'strategy_disable',
        target: s.name,
        current_value: 'enabled',
        suggested_value: 'disabled',
        severity: total < -100 ? 'high' : 'medium',
        rationale: `Pause ${s.label || s.name}. Last ${srows.length} closes: ${(wr * 100).toFixed(0)}% win-rate, $${total.toFixed(2)} net P&L. Disabling stops NEW entries; existing positions keep their stops + trailing-stop ratchet. Re-enable any time from the Strategies tab.`,
        evidence: { window: srows.length, winRate: +wr.toFixed(3), netPnL: +total.toFixed(2), strategy: s.name },
      });
    }
  }

  return out;
}

// Persist candidate suggestions, deduping against the partial unique index
// on (kind, target, suggested_value) where status='pending'. On conflict we
// UPDATE the rationale + evidence + severity so a fresh refresh keeps the
// row's evidence current without piling up duplicates.
async function persistCandidates(candidates) {
  let inserted = 0, updated = 0;
  for (const c of candidates) {
    try {
      const { rows } = await db.query(`
        INSERT INTO safety_suggestions
          (kind, target, current_value, suggested_value, severity, rationale, evidence, status, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'pending', NOW() + INTERVAL '24 hours')
        ON CONFLICT (kind, target, suggested_value) WHERE status = 'pending'
        DO UPDATE SET
          severity   = EXCLUDED.severity,
          rationale  = EXCLUDED.rationale,
          evidence   = EXCLUDED.evidence,
          expires_at = NOW() + INTERVAL '24 hours'
        RETURNING (xmax = 0) AS inserted
      `, [c.kind, c.target, c.current_value, c.suggested_value, c.severity, c.rationale, JSON.stringify(c.evidence)]);
      if (rows[0]?.inserted) inserted++; else updated++;
    } catch (e) {
      console.warn(`[Safety] persist suggestion failed (${c.kind}/${c.target}):`, e.message);
    }
  }
  // Sweep expired pendings.
  const exp = await db.query(`UPDATE safety_suggestions SET status='expired'
                              WHERE status='pending' AND expires_at < NOW() RETURNING id`);
  return { inserted, updated, expired: exp.rowCount };
}

// Public refresh — TTL-throttled and in-flight deduped. portfolio + strategies
// are passed in by the caller (agent.js scheduler) so this service has no
// circular dependency on the agent.
async function refresh({ force = false, portfolio, strategies } = {}) {
  if (_refreshInFlight) return _refreshInFlight;
  if (!force && Date.now() - _refreshAttemptedAt < REFRESH_TTL_MS) {
    return { generated: 0, throttled: true };
  }
  _refreshAttemptedAt = Date.now();
  _refreshInFlight = (async () => {
    try {
      const candidates = await generateCandidates({ portfolio, strategies });
      const persistResult = await persistCandidates(candidates);
      return { generated: candidates.length, ...persistResult };
    } catch (e) {
      console.error('[Safety] refresh failed (swallowed):', e.message);
      return { generated: 0, error: e.message };
    }
  })();
  try { return await _refreshInFlight; } finally { _refreshInFlight = null; }
}

async function listPending() {
  const { rows } = await db.query(`
    SELECT id, kind, target, current_value, suggested_value, severity, rationale, evidence,
           created_at, expires_at
    FROM safety_suggestions
    WHERE status = 'pending' AND expires_at > NOW()
    ORDER BY
      CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      created_at DESC
  `);
  return rows;
}

async function listRecent(limit = 20) {
  const { rows } = await db.query(`
    SELECT id, kind, target, current_value, suggested_value, severity, rationale, evidence,
           status, created_at, expires_at, decided_at, decided_by, applier_result
    FROM safety_suggestions
    ORDER BY created_at DESC LIMIT $1
  `, [Math.min(50, Math.max(1, parseInt(limit) || 20))]);
  return rows;
}

function _validateAgainstWhitelist(row) {
  const kind = KINDS[row.kind];
  if (!kind) throw new Error(`Suggestion kind '${row.kind}' is not whitelisted — refusing to apply.`);
  if (kind.allowed_targets !== '*' && !kind.allowed_targets.includes(row.target)) {
    throw new Error(`Target '${row.target}' is not allowed for kind '${row.kind}'.`);
  }
  if (!kind.allowed_values.includes(row.suggested_value)) {
    throw new Error(`Suggested value '${row.suggested_value}' is not allowed for kind '${row.kind}'.`);
  }
  if (new Date(row.expires_at) < new Date()) {
    throw new Error('Suggestion has expired (24h window) — refresh to re-evaluate.');
  }
}

// Apply a suggestion. The applier dispatches strictly off the whitelist;
// the existing audited writers do the actual state mutation. We never bypass
// them. Caller (the Express endpoint) supplies a `decided_by` tag for the
// audit trail.
//
// Concurrency: the SELECT FOR UPDATE + the terminal UPDATE both run on a
// single dedicated client inside an explicit BEGIN/COMMIT so the row lock
// actually holds across the writer call. The terminal UPDATE additionally
// guards on status='pending' and treats 0-rows-updated as a hard failure
// (defence-in-depth against any transactional gap). If two requests race on
// the same id, only the first commits; the second blocks on the row lock,
// re-reads status='applied', and is rejected before any writer runs.
async function applySuggestion(id, { decided_by = 'user', applierFns } = {}) {
  if (!applierFns?.setRiskScale || !applierFns?.setStrategyEnabled) {
    throw new Error('applierFns missing required writers');
  }
  const client = await db.pool.connect();
  let applierResult, finalRow;
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT * FROM safety_suggestions WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [parseInt(id)],
    );
    const row = sel.rows[0];
    if (!row) { await client.query('ROLLBACK'); throw new Error('Suggestion not found or no longer pending.'); }
    try { _validateAgainstWhitelist(row); }
    catch (e) { await client.query('ROLLBACK'); throw e; }

    // Idempotency guard. Re-read current state INSIDE the row lock and
    // compare to the suggested value. If they already match, this is a
    // partial-failure retry (writer succeeded earlier but the terminal
    // commit didn't): skip the writer and just mark the suggestion applied.
    // Defends against the "writer ran, commit failed, user retries → double
    // mutation" failure mode that would otherwise be possible because the
    // writer + suggestion update are in different transactions.
    const portfolio = await db.getPortfolio().catch(() => null);
    if (row.kind === 'risk_scale_change') {
      const already = (portfolio?.risk_scale || null) === row.suggested_value;
      if (!already) await applierFns.setRiskScale(row.suggested_value);
      applierResult = { writer: 'setRiskScale', value: row.suggested_value, idempotent_skip: already };
    } else if (row.kind === 'strategy_disable') {
      const flagCol = row.target === 'day' ? 'day_enabled'
                    : row.target === 'swing' ? 'swing_enabled'
                    : row.target === 'asx_swing' ? 'asx_swing_enabled' : null;
      const alreadyDisabled = flagCol ? !portfolio?.[flagCol] : false;
      if (!alreadyDisabled) await applierFns.setStrategyEnabled(row.target, false);
      applierResult = { writer: 'setStrategyEnabled', target: row.target, enabled: false, idempotent_skip: alreadyDisabled };
    } else {
      await client.query('ROLLBACK');
      throw new Error(`No applier wired for kind '${row.kind}' — refused.`);
    }

    const upd = await client.query(
      `UPDATE safety_suggestions
       SET status = 'applied', decided_at = NOW(), decided_by = $1, applier_result = $2::jsonb
       WHERE id = $3 AND status = 'pending'`,
      [decided_by, JSON.stringify(applierResult), row.id],
    );
    if (upd.rowCount !== 1) {
      // Defence-in-depth — should be unreachable because we hold the lock,
      // but if it ever happens we hard-fail rather than silently double-apply.
      await client.query('ROLLBACK');
      throw new Error('Race detected: suggestion no longer pending at terminal update.');
    }
    await client.query('COMMIT');
    finalRow = { ...row, status: 'applied', applierResult };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  try {
    await db.recordAudit({
      event_type: 'SUGGEST_APPLY',
      // `decision` column is varchar(16); use short codes and keep the full
      // kind in the JSON payload for queryability.
      decision: finalRow.kind === 'risk_scale_change' ? 'risk_scale' : 'strat_disable',
      payload: {
        id: finalRow.id, kind: finalRow.kind, target: finalRow.target,
        current_value: finalRow.current_value, suggested_value: finalRow.suggested_value,
        rationale: finalRow.rationale, evidence: finalRow.evidence,
        decided_by, applierResult,
      },
    });
  } catch (e) { console.warn('[Safety] applied audit write failed:', e.message); }
  return finalRow;
}

async function rejectSuggestion(id, { decided_by = 'user', reason = null } = {}) {
  const client = await db.pool.connect();
  let finalRow;
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT * FROM safety_suggestions WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [parseInt(id)],
    );
    const row = sel.rows[0];
    if (!row) { await client.query('ROLLBACK'); throw new Error('Suggestion not found or no longer pending.'); }
    const upd = await client.query(
      `UPDATE safety_suggestions
       SET status = 'rejected', decided_at = NOW(), decided_by = $1, applier_result = $2::jsonb
       WHERE id = $3 AND status = 'pending'`,
      [decided_by, JSON.stringify({ reason: reason || null }), row.id],
    );
    if (upd.rowCount !== 1) {
      await client.query('ROLLBACK');
      throw new Error('Race detected: suggestion no longer pending at terminal update.');
    }
    await client.query('COMMIT');
    finalRow = { ...row, status: 'rejected' };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
  try {
    await db.recordAudit({
      event_type: 'SUGGEST_REJECT',
      decision: finalRow.kind === 'risk_scale_change' ? 'risk_scale' : 'strat_disable',
      payload: { id: finalRow.id, kind: finalRow.kind, target: finalRow.target, reason, decided_by },
    });
  } catch (e) { console.warn('[Safety] rejected audit write failed:', e.message); }
  return finalRow;
}

async function getDashboardSummary() {
  const pending = await listPending();
  const { rows: counts } = await db.query(`
    SELECT status, COUNT(*)::int AS n FROM safety_suggestions GROUP BY status
  `);
  const byStatus = Object.fromEntries(counts.map(r => [r.status, r.n]));
  return {
    pendingCount: pending.length,
    byStatus,
    kinds: Object.keys(KINDS),
    refreshTtlMin: REFRESH_TTL_MS / 60000,
    expiryHours: 24,
    pending,
  };
}

module.exports = {
  refresh, listPending, listRecent, applySuggestion, rejectSuggestion,
  getDashboardSummary, KINDS,
};
