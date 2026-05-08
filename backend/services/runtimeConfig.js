// =============================================================================
// runtimeConfig.js — Phase A.5
// =============================================================================
// Single source of truth for the seven Discord-approvable SAFE_KEYS at runtime.
// Fallback chain per key: DB column (or dynamic_gate_state for the gate)
//                       → environment variable
//                       → documented default.
//
// Cached in-process for 5 seconds so the hot agent loop doesn't hammer the DB.
// Call invalidateRuntimeConfig() from the Discord apply path so an approved
// change takes effect on the next cycle (not after up to 5s of staleness).
//
// CONTRACT: this helper NEVER throws. On any DB error it logs and returns the
// env/default fallback. Trading must never be blocked by a config read.
// CONTRACT: do NOT import this from riskManager.js. The strategy overlay in
// agent.js passes runtime values through to riskManager via the existing
// strategyConfig argument; riskManager remains source-of-truth-agnostic.
// =============================================================================
const db = require('./db');

const TTL_MS = 5_000;
let _cache = null;
let _cacheTs = 0;

// Documented defaults — must match the previous module-load const defaults so
// that removing the const doesn't change behaviour for operators who never
// set the env var.
const DEFAULTS = Object.freeze({
  // dynamicGateService.BASE_GATE = 0.80
  confidence_gate_base: 0.80,
  // dipBuyService.STRICTNESS_MEDIUM = 2 (verified at dipBuyService.js:103-105)
  day_trading_dip_strictness: 2,
  // agent.js previous: parseFloat(process.env.LLM_SKIP_PRICE_BPS || '70')
  llm_skip_price_bps: 70,
  // sentimentService.js previous: SENTIMENT_TTL_SECONDS || '1800'
  sentiment_ttl_seconds: 1800,
  // agent.js previous: AGENT_INTERVAL_SECONDS || '60', floored at 5s
  agent_interval_seconds: 60,
  // strategies.js day.maxHoldings = 6
  max_holdings_day: 6,
  // strategies.js day.maxPositionPct / asx_day.maxPositionPct = 0.04
  // Phase B (May 2026): renamed `max_position_pct` → `max_position_pct_day`
  // to make the day-strategy scope explicit. Swing strategies keep their
  // own 5% cap from strategies.js — this key never affects them.
  max_position_pct_day: 0.04,
});

// Bounds match the validators in discordApprovalService.SAFE_KEYS — the same
// values an operator would have to clear to push a change in via Discord.
// Defence-in-depth in case a bad row lands in the DB outside that path.
const BOUNDS = Object.freeze({
  confidence_gate_base:       { min: 0.65, max: 0.90, parse: parseFloat },
  day_trading_dip_strictness: { min: 0,    max: 3,    parse: parseInt   },
  llm_skip_price_bps:         { min: 10,   max: 200,  parse: parseInt   },
  sentiment_ttl_seconds:      { min: 300,  max: 7200, parse: parseInt   },
  agent_interval_seconds:     { min: 5,    max: 300,  parse: parseInt   },
  // Bound max_holdings_day at 10 to match SAFE_KEYS validator. Earlier
  // revision used 20 here, which would have allowed a corrupted DB row to
  // widen day-strategy exposure beyond the approval contract.
  max_holdings_day:           { min: 1,    max: 10,   parse: parseInt   },
  max_position_pct_day:       { min: 0.005,max: 0.05, parse: parseFloat },
});

function _coerce(key, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const b = BOUNDS[key];
  const n = b.parse(raw);
  if (!Number.isFinite(n)) return null;
  if (n < b.min || n > b.max) return null;
  return n;
}

function _envFor(key) {
  switch (key) {
    case 'confidence_gate_base':       return null; // no env override; lives in dynamic_gate_state
    case 'day_trading_dip_strictness': return process.env.DAY_TRADING_DIP_REQUIREMENT_STRICTNESS;
    case 'llm_skip_price_bps':         return process.env.LLM_SKIP_PRICE_BPS;
    case 'sentiment_ttl_seconds':      return process.env.SENTIMENT_TTL_SECONDS;
    case 'agent_interval_seconds':     return process.env.AGENT_INTERVAL_SECONDS;
    case 'max_holdings_day':           return null; // no env; portfolio col only
    case 'max_position_pct_day':       return null; // no env; portfolio col only
    default:                           return null;
  }
}

async function _readDb() {
  // confidence_gate_base lives in dynamic_gate_state (its own table) — read the
  // latest row. Everything else is in portfolio (lazily ALTER'd by the
  // discordApprovalService apply paths). Both queries are tolerant of missing
  // columns/tables on a brand-new DB.
  const out = {};
  try {
    const r = await db.query(`SELECT base_gate FROM dynamic_gate_state ORDER BY id DESC LIMIT 1`);
    if (r.rows[0] && r.rows[0].base_gate != null) out.confidence_gate_base = r.rows[0].base_gate;
  } catch (e) {
    console.warn('[RUNTIME-CONFIG] dynamic_gate_state read failed, falling back:', e.message);
  }
  try {
    // Portfolio is a single-row table. SELECT * so a missing column doesn't
    // throw the whole query — just yields undefined for that key.
    const r = await db.query(`SELECT * FROM portfolio LIMIT 1`);
    const row = r.rows[0] || {};
    if (row.day_trading_dip_strictness != null) out.day_trading_dip_strictness = row.day_trading_dip_strictness;
    if (row.llm_skip_price_bps         != null) out.llm_skip_price_bps         = row.llm_skip_price_bps;
    if (row.sentiment_ttl_seconds      != null) out.sentiment_ttl_seconds      = row.sentiment_ttl_seconds;
    if (row.agent_interval_seconds     != null) out.agent_interval_seconds     = row.agent_interval_seconds;
    if (row.max_holdings_day           != null) out.max_holdings_day           = row.max_holdings_day;
    if (row.max_position_pct_day       != null) out.max_position_pct_day       = row.max_position_pct_day;
  } catch (e) {
    console.warn('[RUNTIME-CONFIG] portfolio read failed, falling back:', e.message);
  }
  return out;
}

function _resolve(key, dbVal) {
  // DB → env → default, each coerced against BOUNDS.
  const fromDb = _coerce(key, dbVal);
  if (fromDb != null) return fromDb;
  const fromEnv = _coerce(key, _envFor(key));
  if (fromEnv != null) return fromEnv;
  return DEFAULTS[key];
}

// Synchronous getter — returns the last successfully-resolved snapshot or the
// pure defaults if no resolve has run yet. Refreshes the cache lazily in the
// background (fire-and-forget) so callers never block.
function getRuntimeConfig() {
  const now = Date.now();
  if (_cache && now - _cacheTs < TTL_MS) return _cache;
  // Cache stale (or cold). Kick off async refresh; meanwhile return the
  // last-known-good (or defaults). This keeps the hot path strictly sync —
  // critical because runCycle / dipBuyService / agent loop all call this.
  _refreshAsync();
  return _cache || _bootSnapshot();
}

let _refreshing = false;
async function _refreshAsync() {
  if (_refreshing) return;
  _refreshing = true;
  try {
    const dbVals = await _readDb();
    const next = {};
    for (const k of Object.keys(DEFAULTS)) next[k] = _resolve(k, dbVals[k]);
    _cache = Object.freeze(next);
    _cacheTs = Date.now();
  } catch (e) {
    console.warn('[RUNTIME-CONFIG] refresh failed, retaining previous snapshot:', e.message);
    if (!_cache) { _cache = _bootSnapshot(); _cacheTs = Date.now(); }
  } finally {
    _refreshing = false;
  }
}

function _bootSnapshot() {
  // Cold-start fallback used until the first async refresh lands. Resolves
  // env→default for every key (DB unread). Frozen so callers can't mutate.
  const snap = {};
  for (const k of Object.keys(DEFAULTS)) snap[k] = _resolve(k, null);
  return Object.freeze(snap);
}

function invalidateRuntimeConfig() {
  _cacheTs = 0;
  // Don't await the refresh here — invalidation is fire-and-forget. The next
  // getRuntimeConfig() call will see the cache is stale and trigger a refresh.
}

// Async warm-up for boot paths that want a guaranteed-fresh first read.
async function warmRuntimeConfig() {
  await _refreshAsync();
  return _cache || _bootSnapshot();
}

module.exports = {
  getRuntimeConfig,
  invalidateRuntimeConfig,
  warmRuntimeConfig,
  DEFAULTS,
  BOUNDS,
};
