// expectancyService — per-(symbol, strategy) rolling R-expectancy with
// auto-suspend / reinstate state machine. Phase B — May 2026.
//
// Goal: shut OFF entries on names that demonstrably bleed money, without
// touching any hard rail. A suspension blocks NEW BUYs only — existing
// positions still run their full risk lifecycle (stops, trailing, target,
// flatten). Reinstatement is operator-gated via Discord (`Reinstate SYM`
// or `Reinstate SYM strategy`), authorized via DISCORD_APPROVER_IDS.
//
// SAFETY:
//   • Suspend/reinstate are the ONLY state changes; cannot widen any rail.
//   • Persisted to `symbol_expectancy` (created by db.ensureSchema).
//   • Pre-buy check returns ALLOW on any DB error — fail-OPEN so a DB
//     hiccup never wedges entries (defence-in-depth: the dynamic gate,
//     quorum, daily-loss budget still gate the trade).
//   • All thresholds env-overridable; defaults are conservative.

const db = require('./db');

const MIN_TRADES_FOR_SUSPEND = parseInt(process.env.EXPECTANCY_MIN_TRADES) || 10;
const SUSPEND_R_THRESHOLD    = parseFloat(process.env.EXPECTANCY_SUSPEND_R) || -0.5;

async function _ensureRow(symbol, strategy) {
  await db.query(`
    INSERT INTO symbol_expectancy (symbol, strategy, n_trades, n_wins, sum_r, expectancy_r, suspended)
    VALUES ($1, $2, 0, 0, 0, 0, FALSE)
    ON CONFLICT (symbol, strategy) DO NOTHING
  `, [symbol, strategy]);
}

// Record a closed-trade outcome. `riskUSD` is the per-trade risk recorded at
// BUY time; `pnlUSD` is the realized P&L. R = pnl / risk. Best-effort:
// failures swallowed so a DB hiccup never breaks the close path.
async function recordTradeOutcome({ symbol, strategy, pnlUSD, riskUSD }) {
  if (!symbol || !strategy) return null;
  if (!Number.isFinite(pnlUSD)) return null;
  const risk = Number.isFinite(riskUSD) && riskUSD > 0 ? riskUSD : Math.max(Math.abs(pnlUSD), 1);
  const r = pnlUSD / risk;
  const won = pnlUSD > 0 ? 1 : 0;
  try {
    await _ensureRow(symbol, strategy);
    const { rows } = await db.query(`
      UPDATE symbol_expectancy
      SET n_trades = n_trades + 1,
          n_wins   = n_wins + $3,
          sum_r    = sum_r + $4,
          expectancy_r = (sum_r + $4) / GREATEST(n_trades + 1, 1),
          updated_at = NOW()
      WHERE symbol = $1 AND strategy = $2
      RETURNING n_trades, expectancy_r, suspended
    `, [symbol, strategy, won, r]);
    const row = rows[0];
    if (!row) return null;
    const n = parseInt(row.n_trades);
    const exp = parseFloat(row.expectancy_r);
    const wasSuspended = !!row.suspended;
    if (!wasSuspended && n >= MIN_TRADES_FOR_SUSPEND && exp <= SUSPEND_R_THRESHOLD) {
      await _suspend({ symbol, strategy, expectancy: exp, n });
      return { suspended: true, expectancy: exp, n };
    }
    return { suspended: wasSuspended, expectancy: exp, n };
  } catch (e) {
    console.warn(`[expectancy] record failed for ${symbol}/${strategy}:`, e.message);
    return null;
  }
}

async function _suspend({ symbol, strategy, expectancy, n }) {
  await db.query(`
    UPDATE symbol_expectancy
    SET suspended = TRUE, suspended_at = NOW(), updated_at = NOW()
    WHERE symbol = $1 AND strategy = $2
  `, [symbol, strategy]);
  await db.recordAudit({
    event_type: 'SYMBOL_AUTO_SUSPENDED', symbol, decision: 'HOLD',
    payload: {
      strategy, expectancy_r: +expectancy.toFixed(4),
      n_trades: n,
      suspend_threshold_r: SUSPEND_R_THRESHOLD,
      min_trades: MIN_TRADES_FOR_SUSPEND,
      reason: `Rolling R-expectancy ${expectancy.toFixed(3)} ≤ ${SUSPEND_R_THRESHOLD} after ${n} trades — new entries auto-suspended.`,
    },
  }).catch(() => {});
  console.warn(`[expectancy] AUTO-SUSPEND ${symbol}/${strategy} (R=${expectancy.toFixed(3)}, n=${n})`);
}

// Pre-BUY gate. Returns { allow:true } on any DB error (fail-open).
async function shouldAllowEntry(symbol, strategy) {
  if (!symbol || !strategy) return { allow: true };
  try {
    const { rows } = await db.query(
      `SELECT suspended, expectancy_r, n_trades FROM symbol_expectancy WHERE symbol = $1 AND strategy = $2`,
      [symbol, strategy]
    );
    const row = rows[0];
    if (!row || !row.suspended) return { allow: true };
    return {
      allow: false,
      reason: 'symbol_auto_suspended',
      expectancy_r: parseFloat(row.expectancy_r),
      n_trades: parseInt(row.n_trades),
    };
  } catch (e) {
    return { allow: true, _error: e.message };
  }
}

// Operator-driven reinstate. `approver` is the Discord user tag for the
// audit row. Returns { ok, reason }.
async function reinstate({ symbol, strategy, approver }) {
  if (!symbol) return { ok: false, reason: 'missing_symbol' };
  try {
    const { rowCount, rows } = await db.query(`
      UPDATE symbol_expectancy
      SET suspended = FALSE, reinstated_at = NOW(), updated_at = NOW()
      WHERE symbol = $1 AND ($2::text IS NULL OR strategy = $2) AND suspended = TRUE
      RETURNING strategy, expectancy_r, n_trades
    `, [symbol, strategy || null]);
    if (rowCount === 0) return { ok: false, reason: 'not_suspended' };
    for (const r of rows) {
      await db.recordAudit({
        event_type: 'SYMBOL_REINSTATED', symbol, decision: 'HOLD',
        payload: {
          strategy: r.strategy, approver: approver || 'unknown',
          expectancy_r_at_reinstate: parseFloat(r.expectancy_r),
          n_trades: parseInt(r.n_trades),
        },
      }).catch(() => {});
    }
    return { ok: true, count: rowCount, rows };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function getStatus(symbol, strategy) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM symbol_expectancy WHERE symbol = $1 AND strategy = $2`,
      [symbol, strategy]
    );
    return rows[0] || null;
  } catch (_) { return null; }
}

async function listSuspended() {
  try {
    const { rows } = await db.query(
      `SELECT symbol, strategy, expectancy_r, n_trades, suspended_at FROM symbol_expectancy WHERE suspended = TRUE ORDER BY suspended_at DESC LIMIT 50`
    );
    return rows;
  } catch (_) { return []; }
}

// ---------- pure helpers exposed for unit tests (no DB I/O) ----------
function _shouldAutoSuspendPure({ n_trades, expectancy_r,
  minTrades = MIN_TRADES_FOR_SUSPEND, suspendThreshold = SUSPEND_R_THRESHOLD }) {
  if (!Number.isFinite(n_trades) || !Number.isFinite(expectancy_r)) return false;
  return n_trades >= minTrades && expectancy_r <= suspendThreshold;
}

function _computeExpectancyPure(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { n_trades: 0, n_wins: 0, total_r: 0, expectancy_r: 0 };
  }
  let n_wins = 0, total_r = 0;
  for (const t of trades) {
    const risk = Number.isFinite(t.riskUSD) && t.riskUSD > 0 ? t.riskUSD : Math.max(Math.abs(t.pnlUSD || 0), 1);
    total_r += (t.pnlUSD || 0) / risk;
    if ((t.pnlUSD || 0) > 0) n_wins++;
  }
  return {
    n_trades: trades.length,
    n_wins,
    total_r: +total_r.toFixed(6),
    expectancy_r: +(total_r / trades.length).toFixed(6),
  };
}

module.exports = {
  recordTradeOutcome,
  shouldAllowEntry,
  reinstate,
  getStatus,
  listSuspended,
  MIN_TRADES_FOR_SUSPEND,
  SUSPEND_R_THRESHOLD,
  _shouldAutoSuspendPure,
  _computeExpectancyPure,
};
