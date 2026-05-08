// =============================================================================
// Discord Approval Service — config-only, hard-allowlisted parameter changes
// =============================================================================
// Listens for Discord chat commands like:
//   • "Approve #3"           → applies pending suggestion #3 if its target
//                              parameter is in SAFE_KEYS
//   • "Reject #3"            → marks suggestion #3 as rejected
//   • "Status"               → posts current pending suggestions list
//   • "Gate status"          → posts current dynamic gate state
//
// SAFETY — this is the most dangerous surface in the new layer, treat with
// extreme paranoia:
//   • SAFE_KEYS is a HARD-CODED allowlist. Anything not in this list cannot
//     be changed via Discord, ever, regardless of what a suggestion proposes.
//   • DENIED categories: kill_switch, circuit_breaker, max_position_pct,
//     max_daily_loss_usd, max_daily_drawdown_pct, atomic_cash, audit_chain,
//     recovery_buffer, quorum_count, the 0.65 safety floor. Any suggestion
//     mentioning these is rejected with an explanatory audit row.
//   • Each apply produces a `CONFIG_CHANGE_APPROVED` audit row + a
//     `pending_suggestions.status='applied'` update.
//   • The Discord operator must be the one who originally configured the
//     bot — there's no second-factor here. The DISCORD_BOT_TOKEN gating
//     in discordChatService is the access boundary.
// =============================================================================

const db = require('./db');
const dynamicGate = require('./dynamicGateService');

// ---------------------------------------------------------------------------
// Approver authorization — only operators on the allowlist may apply OR
// reject suggestions. Read DISCORD_APPROVER_IDS as a comma-separated list of
// Discord user IDs (preferred) or user tags (e.g. "name#0001"). When the env
// var is missing or empty we DENY-ALL approvals (fail-closed): the only way
// to enable Discord approvals is to explicitly list approver IDs. `Status`
// and `Gate` read-only commands remain available to anyone who can message
// the bot, since they expose only state already visible in the dashboard.
// ---------------------------------------------------------------------------
function _getApproverAllowlist() {
  const raw = process.env.DISCORD_APPROVER_IDS || '';
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}
function _isApprover(msg) {
  const allow = _getApproverAllowlist();
  if (allow.size === 0) return false; // fail-closed when unset
  const id = msg?.author?.id;
  const tag = msg?.author?.tag;
  return (id && allow.has(id)) || (tag && allow.has(tag));
}

// Phase A hygiene (May 2026) — visibility-only. Auth logic above is
// unchanged; this just surfaces how many approvers were parsed so
// operators notice misconfigured DISCORD_APPROVER_IDS at boot instead
// of finding out the first time they try to Approve a suggestion.
function getApproverCount() { return _getApproverAllowlist().size; }
function getApproverIds() { return Array.from(_getApproverAllowlist()); }
(function _logApproversAtModuleLoad() {
  try {
    const ids = getApproverIds();
    if (ids.length === 0) {
      console.warn('[DISCORD-APPROVERS] WARNING: zero approvers configured, all approvals will fail-closed');
    } else {
      console.log(`[DISCORD-APPROVERS] parsed ${ids.length} approver IDs: [${ids.join(', ')}]`);
    }
  } catch (e) {
    console.warn('[DISCORD-APPROVERS] startup log failed:', e.message);
  }
})();

// ---------------------------------------------------------------------------
// SAFE_KEYS — every key here MUST have:
//   • a `validate(value)` that returns {ok, reason?, normalised?}
//   • an `apply(value)` that performs the change (DB update or memory poke)
// New keys require explicit code review. NEVER add anything that touches
// the rails listed in the safety section above.
// ---------------------------------------------------------------------------
const SAFE_KEYS = {
  // Dynamic gate base — clamped 0.65-0.90 in dynamicGateService anyway.
  // Phase A.5: INSERTs a new row into `dynamic_gate_state` (mirroring the
  // Council/auto-adaptive write path). This is the table that
  // dynamicGateService.getCurrentGate() reads, so the change actually
  // takes effect on the next cycle. Also invalidates the 30s in-memory
  // gate cache so callers don't see stale state.
  confidence_gate_base: {
    description: 'Base confidence gate (clamped 0.65-0.90). INSERTs a new row into dynamic_gate_state.',
    validate: (v) => {
      const n = parseFloat(v);
      if (!Number.isFinite(n)) return { ok: false, reason: 'not a number' };
      if (n < 0.65 || n > 0.90) return { ok: false, reason: 'must be 0.65-0.90' };
      return { ok: true, normalised: n };
    },
    apply: async (n) => {
      // Phase A.5 fix: write the EXACT approved gate value directly into
      // dynamic_gate_state. Earlier revision routed through
      // applyCouncilSuggestion(), but that helper clamps delta to ±0.10
      // around BASE_GATE=0.80, making approved values below 0.70
      // unreachable. Direct INSERT preserves the latest pin state and
      // resets council_delta to 0 (the operator just set the absolute
      // base, so any prior delta is superseded). Audit correlation: the
      // CONFIG_CHANGE_APPROVED row written by applySuggestion() carries
      // suggestion_id; the DYNAMIC_GATE_ADJUSTED row written below
      // carries source='discord_approval' for cross-reference.
      // Final value is still hard-clamped to SAFETY_FLOOR / SAFETY_CEIL
      // by getCurrentGate() — defence-in-depth.
      await db.query(`
        INSERT INTO dynamic_gate_state (base_gate, council_delta, pinned, pin_value, pin_reason, source, reason, updated_at)
        SELECT $1, 0,
               COALESCE((SELECT pinned    FROM dynamic_gate_state ORDER BY id DESC LIMIT 1), FALSE),
               (SELECT pin_value  FROM dynamic_gate_state ORDER BY id DESC LIMIT 1),
               (SELECT pin_reason FROM dynamic_gate_state ORDER BY id DESC LIMIT 1),
               'discord_approval', $2, NOW()
      `, [n, `Discord approval: set base_gate to ${n}`]);
      dynamicGate.invalidateCache();
      await db.recordAudit({
        event_type: 'DYNAMIC_GATE_ADJUSTED',
        payload: {
          source: 'discord_approval',
          new_base_gate: n,
          reason: `Discord approval: set base_gate to ${n}`,
          effective_gate: await dynamicGate.getCurrentGate(),
        },
      });
    },
  },
  day_trading_dip_strictness: {
    description: 'Day-trading dip requirement strictness (0-3)',
    validate: (v) => {
      const n = parseInt(v);
      if (!Number.isFinite(n) || n < 0 || n > 3) return { ok: false, reason: 'must be 0-3' };
      return { ok: true, normalised: n };
    },
    apply: async (n) => {
      // This is read from env at runtime; we expose a portfolio override col.
      await db.query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS day_trading_dip_strictness INTEGER`);
      await db.query(`UPDATE portfolio SET day_trading_dip_strictness = $1`, [n]);
    },
  },
  llm_skip_price_bps: {
    description: 'LLM skip cache price-drift threshold (10-200 bps)',
    validate: (v) => {
      const n = parseInt(v);
      if (!Number.isFinite(n) || n < 10 || n > 200) return { ok: false, reason: 'must be 10-200' };
      return { ok: true, normalised: n };
    },
    apply: async (n) => {
      await db.query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS llm_skip_price_bps INTEGER`);
      await db.query(`UPDATE portfolio SET llm_skip_price_bps = $1`, [n]);
    },
  },
  sentiment_ttl_seconds: {
    description: 'Sentiment cache TTL (300-7200 seconds)',
    validate: (v) => {
      const n = parseInt(v);
      if (!Number.isFinite(n) || n < 300 || n > 7200) return { ok: false, reason: 'must be 300-7200' };
      return { ok: true, normalised: n };
    },
    apply: async (n) => {
      await db.query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS sentiment_ttl_seconds INTEGER`);
      await db.query(`UPDATE portfolio SET sentiment_ttl_seconds = $1`, [n]);
    },
  },
  agent_interval_seconds: {
    description: 'Master cycle interval (30-300 seconds)',
    validate: (v) => {
      const n = parseInt(v);
      if (!Number.isFinite(n) || n < 30 || n > 300) return { ok: false, reason: 'must be 30-300' };
      return { ok: true, normalised: n };
    },
    apply: async (n) => {
      await db.query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS agent_interval_seconds INTEGER`);
      await db.query(`UPDATE portfolio SET agent_interval_seconds = $1`, [n]);
    },
  },
  max_holdings_day: {
    description: 'Max concurrent day holdings (1-10)',
    validate: (v) => {
      const n = parseInt(v);
      if (!Number.isFinite(n) || n < 1 || n > 10) return { ok: false, reason: 'must be 1-10' };
      return { ok: true, normalised: n };
    },
    apply: async (n) => {
      await db.query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS max_holdings_day INTEGER`);
      await db.query(`UPDATE portfolio SET max_holdings_day = $1`, [n]);
    },
  },
  // Per-name position cap, in equity %. Operator-decision May 2026: moved
  // from DENIED → SAFE with a HARD upper bound of 5%. The validator below
  // is the ONLY gate that can change this via Discord; every other safety
  // rail (quorum, confidence floor, daily-loss budget, drawdown breaker,
  // kill switch, recovery buffer, atomic cash) is untouched. Effective only
  // for the day strategies (US `day` and `asx_day`); swing strategies keep
  // their own 5% cap from strategies.js. Persisted to portfolio override
  // column; strategy loader picks it up if present.
  max_position_pct: {
    description: 'Per-name position cap as fraction of equity (0.01-0.05)',
    validate: (v) => {
      const n = parseFloat(v);
      if (!Number.isFinite(n)) return { ok: false, reason: 'not a number' };
      // HARD UPPER BOUND — 5%. Anything bigger requires a code change AND
      // an architect review; Discord cannot push past this.
      if (n < 0.01 || n > 0.05) return { ok: false, reason: 'must be 0.01-0.05 (1-5%)' };
      return { ok: true, normalised: n };
    },
    apply: async (n) => {
      await db.query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS max_position_pct_day NUMERIC`);
      await db.query(`UPDATE portfolio SET max_position_pct_day = $1`, [n]);
      // Audit the change with the dedicated event type the operator asked for.
      await db.recordAudit({
        event_type: 'POSITION_CAP_INCREASED',
        payload: {
          new_cap_pct: n,
          source: 'discord_approval',
          reason: 'operator-approved suggestion via Discord',
        },
      });
    },
  },
};

// Key normalisation — accept variations like "Confidence Gate" → "confidence_gate_base"
const KEY_ALIASES = {
  'confidence_gate': 'confidence_gate_base',
  'gate': 'confidence_gate_base',
  'dip_strictness': 'day_trading_dip_strictness',
  'skip_bps': 'llm_skip_price_bps',
  'sentiment_ttl': 'sentiment_ttl_seconds',
  'interval': 'agent_interval_seconds',
  'cycle_interval': 'agent_interval_seconds',
  'max_day_holdings': 'max_holdings_day',
};

// DENIED keys — explicit denylist (some are also implicitly denied by NOT
// being in SAFE_KEYS, but a hardcoded list lets us return a clear message).
// `max_position_pct` was previously DENIED; moved to SAFE_KEYS May 2026 with
// a HARD upper bound of 5% in its validator. All other safety rails remain
// in this denylist and CANNOT be changed via Discord under any circumstances.
const DENIED_KEYS = new Set([
  'kill_switch', 'circuit_breaker', 'max_daily_loss_usd',
  'max_daily_drawdown_pct', 'recovery_buffer_seconds', 'min_directional_agreement',
  'safety_floor', 'atomic_cash', 'audit_chain', 'asx_execution_wired',
]);

function normaliseKey(rawKey) {
  const k = String(rawKey || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (DENIED_KEYS.has(k)) return { denied: true, key: k };
  if (SAFE_KEYS[k]) return { key: k };
  if (KEY_ALIASES[k]) return { key: KEY_ALIASES[k] };
  return { unknown: true, key: k };
}

// ---------------------------------------------------------------------------
// Pending suggestions CRUD
// ---------------------------------------------------------------------------
async function addSuggestion({ title, target_key, target_value, impact, effort, confidence, rationale, source }) {
  const r = await db.query(`
    INSERT INTO pending_suggestions
      (title, target_key, target_value, impact, effort, confidence, rationale, source, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
    RETURNING id
  `, [
    String(title || '').slice(0, 200),
    String(target_key || '').slice(0, 80),
    String(target_value),
    impact || 'M',
    effort || 'M',
    parseFloat(confidence) || 0.5,
    String(rationale || '').slice(0, 1000),
    source || 'meta_review',
  ]);
  return r.rows[0]?.id;
}

async function listPending(limit = 20) {
  const r = await db.query(`
    SELECT id, title, target_key, target_value, impact, effort, confidence, rationale, source, status, created_at
    FROM pending_suggestions
    WHERE status = 'pending'
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
  return r.rows;
}

async function getById(id) {
  const r = await db.query(`SELECT * FROM pending_suggestions WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function markStatus(id, status, applyResult) {
  await db.query(`UPDATE pending_suggestions SET status=$1, applied_at=NOW(), apply_result=$2 WHERE id=$3`,
    [status, JSON.stringify(applyResult || {}), id]);
}

// ---------------------------------------------------------------------------
// Apply a suggestion. Returns {ok, reason?, applied?}.
// ALL paths produce an audit row.
// ---------------------------------------------------------------------------
async function applySuggestion(id, { discordUser } = {}) {
  const sug = await getById(id);
  if (!sug) return { ok: false, reason: `no suggestion #${id}` };
  if (sug.status !== 'pending') return { ok: false, reason: `#${id} status=${sug.status}` };
  const norm = normaliseKey(sug.target_key);
  if (norm.denied) {
    await markStatus(id, 'rejected', { reason: 'denied_key', key: norm.key });
    await db.recordAudit({
      event_type: 'CONFIG_CHANGE_DENIED',
      payload: { suggestion_id: id, key: sug.target_key, reason: 'denied_safety_critical', source: 'discord_approval', discord_user: discordUser || null },
    });
    return { ok: false, reason: `key '${sug.target_key}' is safety-critical and cannot be changed via Discord` };
  }
  if (norm.unknown) {
    await markStatus(id, 'rejected', { reason: 'unknown_key', key: norm.key });
    await db.recordAudit({
      event_type: 'CONFIG_CHANGE_DENIED',
      payload: { suggestion_id: id, key: sug.target_key, reason: 'not_in_allowlist', source: 'discord_approval', discord_user: discordUser || null },
    });
    return { ok: false, reason: `key '${sug.target_key}' is not in the approval allowlist` };
  }
  const spec = SAFE_KEYS[norm.key];
  const validation = spec.validate(sug.target_value);
  if (!validation.ok) {
    await markStatus(id, 'rejected', { reason: 'validation_failed', detail: validation.reason });
    await db.recordAudit({
      event_type: 'CONFIG_CHANGE_DENIED',
      payload: { suggestion_id: id, key: norm.key, reason: 'validation_failed', detail: validation.reason, source: 'discord_approval', discord_user: discordUser || null },
    });
    return { ok: false, reason: `validation failed: ${validation.reason}` };
  }
  try {
    await spec.apply(validation.normalised);
  } catch (e) {
    await markStatus(id, 'failed', { reason: 'apply_threw', detail: e.message });
    await db.recordAudit({
      event_type: 'CONFIG_CHANGE_FAILED',
      payload: { suggestion_id: id, key: norm.key, reason: 'apply_threw', detail: e.message, source: 'discord_approval', discord_user: discordUser || null },
    });
    return { ok: false, reason: `apply threw: ${e.message}` };
  }
  await markStatus(id, 'applied', { value: validation.normalised });
  await db.recordAudit({
    event_type: 'CONFIG_CHANGE_APPROVED',
    payload: {
      suggestion_id: id, key: norm.key, value: validation.normalised,
      title: sug.title, source: 'discord_approval',
      discord_user: discordUser || null,
    },
  });
  // Phase A.5: drop the 5s runtimeConfig cache so the next cycle re-reads
  // DB values for every SAFE_KEY. Cheap (single timestamp reset). Failures
  // are swallowed — config invalidation must never block an approval.
  try {
    require('./runtimeConfig').invalidateRuntimeConfig();
  } catch (e) {
    console.warn('[DISCORD-APPROVAL] runtimeConfig invalidate failed:', e.message);
  }
  return { ok: true, applied: { key: norm.key, value: validation.normalised } };
}

async function rejectSuggestion(id, { discordUser } = {}) {
  const sug = await getById(id);
  if (!sug) return { ok: false, reason: `no suggestion #${id}` };
  if (sug.status !== 'pending') return { ok: false, reason: `#${id} status=${sug.status}` };
  await markStatus(id, 'rejected', { reason: 'manual_reject', discord_user: discordUser || null });
  await db.recordAudit({
    event_type: 'CONFIG_CHANGE_REJECTED',
    payload: { suggestion_id: id, key: sug.target_key, source: 'discord_approval', discord_user: discordUser || null },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Discord message routing — returns null if message wasn't an approval
// command (caller should fall through to chat). Otherwise returns a string
// to post back.
// ---------------------------------------------------------------------------
const APPROVE_RE = /^\s*approve\s*#?\s*(\d+)\s*$/i;
const REJECT_RE  = /^\s*reject\s*#?\s*(\d+)\s*$/i;
const STATUS_RE  = /^\s*(status|pending|suggestions)\s*$/i;
const GATE_RE    = /^\s*gate\s*(status)?\s*$/i;

async function tryHandle(text, msg) {
  const t = String(text || '').trim();
  const discordUser = msg?.author?.tag || msg?.author?.id || null;
  const isApprover = _isApprover(msg);

  let m = t.match(APPROVE_RE);
  if (m) {
    const id = parseInt(m[1]);
    if (!isApprover) {
      // Fail-closed: log unauthorized attempts to audit so operator can see
      // who tried to apply changes from where.
      try {
        await db.recordAudit({
          event_type: 'CONFIG_CHANGE_UNAUTHORIZED',
          payload: { suggestion_id: id, attempted: 'approve', discord_user: discordUser, source: 'discord_approval' },
        });
      } catch (_) {}
      return `🔒 Not authorized. Only operators in \`DISCORD_APPROVER_IDS\` can approve suggestions.`;
    }
    const res = await applySuggestion(id, { discordUser });
    return res.ok
      ? `✅ Approved #${id} — applied \`${res.applied.key}\`=\`${res.applied.value}\`. Logged to audit.`
      : `❌ Could not approve #${id}: ${res.reason}`;
  }
  m = t.match(REJECT_RE);
  if (m) {
    const id = parseInt(m[1]);
    if (!isApprover) {
      try {
        await db.recordAudit({
          event_type: 'CONFIG_CHANGE_UNAUTHORIZED',
          payload: { suggestion_id: id, attempted: 'reject', discord_user: discordUser, source: 'discord_approval' },
        });
      } catch (_) {}
      return `🔒 Not authorized. Only operators in \`DISCORD_APPROVER_IDS\` can reject suggestions.`;
    }
    const res = await rejectSuggestion(id, { discordUser });
    return res.ok ? `🗑️ Rejected #${id}.` : `❌ Could not reject #${id}: ${res.reason}`;
  }
  if (STATUS_RE.test(t)) {
    const list = await listPending(10);
    if (!list.length) return '📭 No pending suggestions.';
    const lines = list.map(s => `**#${s.id}** [${s.impact}/${s.effort}, ${(parseFloat(s.confidence)*100).toFixed(0)}%] ${s.title}\n   → \`${s.target_key}\`=\`${s.target_value}\``);
    return `📋 **Pending Suggestions** (${list.length})\n${lines.join('\n')}\n\nReply \`Approve #N\` or \`Reject #N\`.`;
  }
  if (GATE_RE.test(t)) {
    const s = await dynamicGate.getStatus();
    return `🛡️ **Dynamic Gate**\n• Effective: **${(s.effective_gate*100).toFixed(0)}%** (floor ${(s.safety_floor*100).toFixed(0)}%, ceil ${(s.safety_ceiling*100).toFixed(0)}%)\n• Base: ${(s.base_gate*100).toFixed(0)}%  •  Council Δ: ${s.council_delta >= 0 ? '+' : ''}${(s.council_delta*100).toFixed(1)}pp\n• Pinned: ${s.pinned ? `YES @ ${(s.pin_value*100).toFixed(0)}% — ${s.pin_reason}` : 'no'}`;
  }
  return null; // not an approval command — caller falls through to chat
}

module.exports = {
  tryHandle,
  addSuggestion, listPending, applySuggestion, rejectSuggestion,
  SAFE_KEYS, DENIED_KEYS,
};
