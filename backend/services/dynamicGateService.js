// =============================================================================
// Dynamic Gate Service — Smart Safety Layer
// =============================================================================
// Manages the EFFECTIVE confidence-gate threshold within a HARD-CLAMPED band:
//
//   • SAFETY_FLOOR = 0.65  — gate can never drop below this, ever.
//   • SAFETY_CEIL  = 0.90  — gate can never exceed this (avoid lock-out).
//
// Two inputs adjust the gate:
//   1. Council suggestion — Intelligence Council can suggest a delta in
//      [-0.10, +0.10]. Applied additively, then re-clamped to [0.65, 0.90].
//   2. Auto-adaptive win-rate guard — runs daily over closed trades:
//        • 3-day rolling win-rate < 0.42  → PIN gate at 0.85 (tight defensive)
//        • 3-day rolling win-rate > 0.55  → release pin, allow Council to
//                                            return gate to 0.80 baseline
//      The pin is an UPWARD-only override: it can only RAISE the gate, never
//      lower it. While pinned, the council can still tighten further but
//      cannot loosen below the pin value.
//
// SAFETY:
//   • Hard rails (daily-loss budget, drawdown breaker, kill switch, atomic
//     cash math, audit chain, 3-of-N quorum, max_position_pct, recovery
//     buffer, ASX min notional) are NEVER touched by this service.
//   • This service ONLY emits the confidence-gate threshold consumed by
//     riskManager.checkQuorum's `gateOverride` parameter, which itself
//     re-clamps to [SAFETY_FLOOR, SAFETY_CEIL] as defence-in-depth.
//   • The `getCurrentGate` value is the BASE gate; existing regime/macro
//     boosts still tighten on top via checkQuorum's existing `confidenceBoost`.
// =============================================================================

const db = require('./db');

const SAFETY_FLOOR = 0.65;
const SAFETY_CEIL  = 0.90;
const BASE_GATE    = 0.80; // matches existing strategies.confidenceThreshold
const PIN_THRESHOLD_LOSING = 0.42; // 3-day WR below this → pin at PIN_VALUE
const PIN_THRESHOLD_WINNING = 0.55; // 3-day WR above this → release pin
const PIN_VALUE    = 0.85;
const PIN_DAYS_REQUIRED = 3;

function clampGate(v) {
  if (!Number.isFinite(v)) return BASE_GATE;
  return Math.max(SAFETY_FLOOR, Math.min(SAFETY_CEIL, v));
}

// In-memory cache so the hot path doesn't hit the DB on every signal.
let _state = null;
let _stateTs = 0;
const STATE_TTL_MS = 30 * 1000;

async function _ensureState() {
  if (_state && Date.now() - _stateTs < STATE_TTL_MS) return _state;
  try {
    const r = await db.query(`SELECT * FROM dynamic_gate_state ORDER BY id DESC LIMIT 1`);
    _state = r.rows[0] || {
      base_gate: BASE_GATE,
      council_delta: 0,
      pinned: false,
      pin_value: null,
      pin_reason: null,
      updated_at: new Date(),
    };
    _stateTs = Date.now();
  } catch (_) {
    _state = { base_gate: BASE_GATE, council_delta: 0, pinned: false, pin_value: null };
    _stateTs = Date.now();
  }
  return _state;
}

// Returns the EFFECTIVE base gate after applying council delta + win-rate pin.
// This is what callers pass to riskManager.checkQuorum's `gateOverride`.
async function getCurrentGate({ strategy = 'day', market = 'US' } = {}) {
  const s = await _ensureState();
  const base = parseFloat(s.base_gate) || BASE_GATE;
  const delta = parseFloat(s.council_delta) || 0;
  let gate = clampGate(base + delta);
  if (s.pinned && Number.isFinite(parseFloat(s.pin_value))) {
    // Pin is upward-only — never relax below the pin value.
    gate = Math.max(gate, parseFloat(s.pin_value));
  }
  return clampGate(gate);
}

// Apply a council suggestion. `delta` in [-0.10, +0.10]. Negative loosens
// (allowed only down to SAFETY_FLOOR), positive tightens (up to SAFETY_CEIL).
// While the win-rate pin is active the suggestion is recorded but the
// effective gate stays pinned upward.
async function applyCouncilSuggestion({ delta, reason, source = 'council' }) {
  const cleanDelta = Math.max(-0.10, Math.min(0.10, parseFloat(delta) || 0));
  await db.query(`
    INSERT INTO dynamic_gate_state (base_gate, council_delta, pinned, pin_value, pin_reason, source, reason, updated_at)
    SELECT $1, $2, COALESCE((SELECT pinned FROM dynamic_gate_state ORDER BY id DESC LIMIT 1), FALSE),
                  (SELECT pin_value FROM dynamic_gate_state ORDER BY id DESC LIMIT 1),
                  (SELECT pin_reason FROM dynamic_gate_state ORDER BY id DESC LIMIT 1),
                  $3, $4, NOW()
  `, [BASE_GATE, cleanDelta, source, String(reason || '').slice(0, 200)]);
  _stateTs = 0;
  await db.recordAudit({
    event_type: 'DYNAMIC_GATE_ADJUSTED',
    payload: { source, delta: cleanDelta, reason, effective_gate: await getCurrentGate() },
  });
}

// Compute 3-day rolling win-rate from trade_memory and apply/release pin.
// Idempotent — safe to run from the daily report.
async function evaluateAutoAdaptive({ strategy = null } = {}) {
  let r;
  try {
    const args = [];
    let where = `WHERE created_at >= NOW() - INTERVAL '3 days'`;
    if (strategy) { where += ` AND strategy = $1`; args.push(strategy); }
    r = await db.query(`
      SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE won)::int AS w
      FROM trade_memory ${where}
    `, args);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const n = r.rows[0]?.n || 0;
  const w = r.rows[0]?.w || 0;
  if (n < PIN_DAYS_REQUIRED) return { ok: true, action: 'insufficient_samples', n, w };
  const winRate = w / n;
  const prev = await _ensureState();
  const wasPinned = !!prev.pinned;

  let action = 'no_change';
  let pinned = wasPinned;
  let pinValue = parseFloat(prev.pin_value) || null;
  let pinReason = prev.pin_reason || null;

  if (winRate < PIN_THRESHOLD_LOSING) {
    pinned = true;
    pinValue = PIN_VALUE;
    pinReason = `3d WR ${(winRate*100).toFixed(1)}% < ${(PIN_THRESHOLD_LOSING*100).toFixed(0)}% (n=${n})`;
    action = wasPinned ? 'pin_refreshed' : 'pin_engaged';
  } else if (winRate > PIN_THRESHOLD_WINNING && wasPinned) {
    pinned = false;
    pinValue = null;
    pinReason = `3d WR ${(winRate*100).toFixed(1)}% > ${(PIN_THRESHOLD_WINNING*100).toFixed(0)}% (n=${n})`;
    action = 'pin_released';
  }

  if (action !== 'no_change') {
    await db.query(`
      INSERT INTO dynamic_gate_state (base_gate, council_delta, pinned, pin_value, pin_reason, source, reason, updated_at)
      VALUES ($1, $2, $3, $4, $5, 'auto_adaptive', $6, NOW())
    `, [BASE_GATE, parseFloat(prev.council_delta) || 0, pinned, pinValue, pinReason, `${action}: ${pinReason}`]);
    _stateTs = 0;
    await db.recordAudit({
      event_type: 'DYNAMIC_GATE_PIN_CHANGE',
      payload: { action, win_rate: +winRate.toFixed(3), n_trades: n, pin_value: pinValue, reason: pinReason },
    });
  }
  return { ok: true, action, n, w, winRate: +winRate.toFixed(3), pinned, pinValue };
}

async function getStatus() {
  const s = await _ensureState();
  const effective = await getCurrentGate();
  return {
    safety_floor: SAFETY_FLOOR,
    safety_ceiling: SAFETY_CEIL,
    base_gate: parseFloat(s.base_gate) || BASE_GATE,
    council_delta: parseFloat(s.council_delta) || 0,
    pinned: !!s.pinned,
    pin_value: s.pin_value != null ? parseFloat(s.pin_value) : null,
    pin_reason: s.pin_reason || null,
    effective_gate: effective,
    last_updated: s.updated_at,
  };
}

module.exports = {
  getCurrentGate,
  applyCouncilSuggestion,
  evaluateAutoAdaptive,
  getStatus,
  clampGate,
  SAFETY_FLOOR, SAFETY_CEIL, BASE_GATE,
};
