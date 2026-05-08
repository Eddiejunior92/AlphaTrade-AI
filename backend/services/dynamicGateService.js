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

// Phase B (May 2026): regime meta-layer. Raise-only adjustments to the gate
// based on the LIVE regime classification. The four invariants enforced by
// computeRegimeAdjustment + getCurrentGate compose:
//   1. raise-only       — adjustment is always ≥ 0 (never relaxes the gate)
//   2. capped at +0.05  — single-cycle regime tightening cannot exceed 5pp
//   3. clamped [F, C]   — final gate stays inside [SAFETY_FLOOR, SAFETY_CEIL]
//   4. pin precedence   — the auto-adaptive WR pin still wins (Math.max)
const REGIME_ADJ_MAX = 0.05;
const REGIME_RULES = Object.freeze({
  high_vol:      0.03, // wider tape — demand more conviction
  news_driven:   0.02, // headline risk — demand more conviction
  low_liquidity: 0.02, // microstructure risk — demand more conviction
  // any other regime label (trending, mean_reverting, normal, etc.) → 0
});

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

// Phase B (May 2026): pure raise-only regime adjustment. Returns the # of pp
// to ADD to the base+council gate based on the live regime classification.
// CONTRACT (asserted by tests + final getCurrentGate clamps):
//   • Always ≥ 0 (raise-only — can never loosen the gate)
//   • Always ≤ REGIME_ADJ_MAX (single-cycle bound)
//   • Pure / null-safe / never throws
function computeRegimeAdjustment(regime) {
  if (!regime) return 0;
  // Accept either a regimeService output ({ primary, ... }) or a bare string.
  const label = typeof regime === 'string'
    ? regime
    : String(regime.primary || regime.regime || '').toLowerCase();
  if (!label) return 0;
  const raw = REGIME_RULES[label];
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(REGIME_ADJ_MAX, Math.max(0, raw));
}

// Returns the EFFECTIVE base gate after composing:
//   base + council_delta + regime_adjustment, then pin-max, then clamp.
// Called per-signal (riskManager.checkQuorum gateOverride).
//
// Composition order MATTERS. Regime adj is applied BEFORE the pin so the pin
// can still raise above a high regime adj but cannot LOWER below it. Final
// clamp guarantees the [SAFETY_FLOOR, SAFETY_CEIL] band is sacrosanct.
async function getCurrentGate({ strategy = 'day', market = 'US', regime = null } = {}) {
  const s = await _ensureState();
  const base = parseFloat(s.base_gate) || BASE_GATE;
  const delta = parseFloat(s.council_delta) || 0;
  const regimeAdj = computeRegimeAdjustment(regime);
  let gate = clampGate(base + delta + regimeAdj);
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

async function getStatus({ regime = null } = {}) {
  const s = await _ensureState();
  const effective = await getCurrentGate({ regime });
  const regimeAdj = computeRegimeAdjustment(regime);
  return {
    safety_floor: SAFETY_FLOOR,
    safety_ceiling: SAFETY_CEIL,
    base_gate: parseFloat(s.base_gate) || BASE_GATE,
    council_delta: parseFloat(s.council_delta) || 0,
    regime_adjustment: regimeAdj,
    regime_adjustment_max: REGIME_ADJ_MAX,
    regime_input: regime ? (typeof regime === 'string' ? regime : regime.primary || null) : null,
    pinned: !!s.pinned,
    pin_value: s.pin_value != null ? parseFloat(s.pin_value) : null,
    pin_reason: s.pin_reason || null,
    effective_gate: effective,
    last_updated: s.updated_at,
  };
}

// Phase A hygiene (May 2026): on boot, confirm dynamic_gate_state has at
// least one row. If it's empty, insert the default baseline so getStatus()
// returns a real DB-backed value from cycle one (instead of an in-memory
// default that masks "the table has been empty all along"). Idempotent.
async function initStateAtBoot() {
  try {
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM dynamic_gate_state`);
    if ((r.rows[0]?.n || 0) > 0) {
      _stateTs = 0; // force fresh read on next getCurrentGate
      console.log('[DYNAMIC-GATE] state row present — boot init skipped');
      return { ok: true, action: 'noop' };
    }
    await db.query(`
      INSERT INTO dynamic_gate_state
        (base_gate, council_delta, pinned, pin_value, pin_reason, source, reason, updated_at)
      VALUES ($1, 0, FALSE, NULL, NULL, 'boot_init', 'first-row insert at boot', NOW())
    `, [BASE_GATE]);
    _stateTs = 0;
    await db.recordAudit({
      event_type: 'DYNAMIC_GATE_INITIALISED',
      payload: { base_gate: BASE_GATE, source: 'boot_init' },
    });
    console.log(`[DYNAMIC-GATE] inserted default state row (base_gate=${BASE_GATE})`);
    return { ok: true, action: 'inserted', base_gate: BASE_GATE };
  } catch (e) {
    console.warn('[DYNAMIC-GATE] initStateAtBoot failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Phase A.5: external callers (Discord apply path, runtimeConfig invalidation)
// can force the next getCurrentGate() to bypass the 30s in-memory cache.
function invalidateCache() { _stateTs = 0; }

module.exports = {
  invalidateCache,
  getCurrentGate,
  applyCouncilSuggestion,
  evaluateAutoAdaptive,
  getStatus,
  clampGate,
  computeRegimeAdjustment,
  initStateAtBoot,
  SAFETY_FLOOR, SAFETY_CEIL, BASE_GATE, REGIME_ADJ_MAX, REGIME_RULES,
};
