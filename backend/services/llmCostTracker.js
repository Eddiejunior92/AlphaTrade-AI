// =============================================================================
// LLM Cost Tracker
// =============================================================================
// Single source of truth for "how much are we ACTUALLY paying OpenRouter / xAI
// per day". Every LLM call site in the codebase calls `recordUsage(...)` after
// the HTTP response lands, passing the provider-returned `usage` block. We:
//
//   1. Look up real per-token rates for the model (input + output)
//   2. Compute cost in USD with full precision
//   3. Insert one row into `llm_usage_logs` (persistent, survives restart)
//   4. Bump fast in-memory counters for hot-path consumers
//
// The daily performance report queries `llm_usage_logs` aggregated by service
// + market for the trading day so it can show TRUE gross spend instead of the
// previous flat-rate estimate.
//
// SAFETY: every recordUsage call is best-effort and never throws — if pricing
// is missing or the DB write fails, we log and move on. LLM tracking must
// NEVER break a trading cycle.
// =============================================================================

const db = require('./db');

// ---- Pricing table (USD per 1M tokens) -------------------------------------
// Sourced from public OpenRouter / xAI rate cards as of 2025-Q2. Keep this
// table in sync when models are upgraded — it's the only place to edit.
// `match` is a substring matched case-insensitively against the model_id.
// First match wins, so put more specific entries first.
const PRICING = [
  // xAI Grok family
  { match: 'grok-4-fast-non-reasoning', in_per_m: 0.20, out_per_m: 0.50 },
  { match: 'grok-4-fast',               in_per_m: 0.20, out_per_m: 0.50 },
  { match: 'grok-4',                    in_per_m: 3.00, out_per_m: 15.00 },
  { match: 'grok-3-mini',               in_per_m: 0.30, out_per_m: 0.50 },
  { match: 'grok-3',                    in_per_m: 3.00, out_per_m: 15.00 },
  { match: 'grok-2-mini',               in_per_m: 0.30, out_per_m: 0.50 },
  { match: 'grok-2',                    in_per_m: 2.00, out_per_m: 10.00 },
  // Google Gemini
  { match: 'gemini-2.0-flash',          in_per_m: 0.10, out_per_m: 0.40 },
  { match: 'gemini-1.5-flash',          in_per_m: 0.075, out_per_m: 0.30 },
  { match: 'gemini-1.5-pro',            in_per_m: 1.25, out_per_m: 5.00 },
  // Anthropic Claude
  { match: 'claude-3.7-sonnet',         in_per_m: 3.00, out_per_m: 15.00 },
  { match: 'claude-3-5-sonnet',         in_per_m: 3.00, out_per_m: 15.00 },
  { match: 'claude-3-5-haiku',          in_per_m: 0.80, out_per_m: 4.00 },
  { match: 'claude-3-opus',             in_per_m: 15.00, out_per_m: 75.00 },
  // OpenAI
  { match: 'gpt-4o-mini',               in_per_m: 0.15, out_per_m: 0.60 },
  { match: 'gpt-4o',                    in_per_m: 2.50, out_per_m: 10.00 },
  { match: 'gpt-4-turbo',               in_per_m: 10.00, out_per_m: 30.00 },
];

// Conservative fallback so unknown models still bill SOMETHING (better than $0
// — that would silently under-report). Rough mid-range estimate.
const FALLBACK = { in_per_m: 1.00, out_per_m: 3.00 };

function _lookupPricing(modelId) {
  const id = String(modelId || '').toLowerCase();
  for (const p of PRICING) {
    if (id.includes(p.match)) return p;
  }
  return FALLBACK;
}

// Compute USD cost from a provider `usage` block. OpenRouter and xAI both
// return `{ prompt_tokens, completion_tokens, total_tokens }`. If `usage` is
// missing (some providers omit it on stream/error), we estimate by total
// tokens × output rate (conservative — assumes everything was output).
function computeCost(modelId, usage) {
  const pricing = _lookupPricing(modelId);
  if (!usage || typeof usage !== 'object') return 0;
  const promptT = Number(usage.prompt_tokens) || 0;
  const completionT = Number(usage.completion_tokens) || 0;
  if (promptT === 0 && completionT === 0) {
    const total = Number(usage.total_tokens) || 0;
    return +(total * pricing.out_per_m / 1e6).toFixed(6);
  }
  const cost = (promptT * pricing.in_per_m + completionT * pricing.out_per_m) / 1e6;
  return +cost.toFixed(6);
}

// ---- Schema ----------------------------------------------------------------
async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS llm_usage_logs (
      id                BIGSERIAL PRIMARY KEY,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      service           TEXT        NOT NULL,        -- ensemble | sentiment | premarket | knowledge_graph | fundamentals | options | earnings | meta | chat
      market            TEXT        NOT NULL,        -- US | ASX | SHARED
      model_id          TEXT        NOT NULL,
      prompt_tokens     INTEGER     NOT NULL DEFAULT 0,
      completion_tokens INTEGER     NOT NULL DEFAULT 0,
      total_tokens      INTEGER     NOT NULL DEFAULT 0,
      cost_usd          NUMERIC(12,6) NOT NULL DEFAULT 0
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS llm_usage_logs_created_idx ON llm_usage_logs (created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS llm_usage_logs_market_service_idx ON llm_usage_logs (market, service, created_at DESC)`);
}

// ---- Recording -------------------------------------------------------------
// In-memory counters keyed by `${market}|${service}` for fast hot-path reads
// (e.g. dashboard live counters). Reset on process restart — DB is the
// authoritative store for the daily report.
const memCounters = new Map();

function _bumpMem(market, service, cost, totalTokens) {
  const k = `${market}|${service}`;
  const cur = memCounters.get(k) || { calls: 0, tokens: 0, cost_usd: 0 };
  cur.calls += 1;
  cur.tokens += totalTokens;
  cur.cost_usd += cost;
  memCounters.set(k, cur);
}

// Best-effort: never throws. Pass the FULL provider response (`res.data`).
// We extract `usage` ourselves so callers don't have to remember.
async function recordUsage({ service, market, modelId, response }) {
  try {
    const usage = response?.usage || null;
    if (!usage) return;  // some streaming/error responses lack usage
    const cost = computeCost(modelId, usage);
    const total = Number(usage.total_tokens) || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
    const mkt = (market || 'SHARED').toUpperCase();
    const svc = String(service || 'unknown');
    _bumpMem(mkt, svc, cost, total);
    await db.query(
      `INSERT INTO llm_usage_logs (service, market, model_id, prompt_tokens, completion_tokens, total_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [svc, mkt, String(modelId), Number(usage.prompt_tokens) || 0, Number(usage.completion_tokens) || 0, total, cost]
    );
  } catch (e) {
    // Swallow — tracker failures must NEVER break a trading cycle.
    console.error('[LLMCost] recordUsage failed (swallowed):', e.message);
  }
}

// ---- Aggregation for daily report -----------------------------------------
// Returns per-service cost rollup for one market on one trading date. The
// trading-date filter uses (created_at AT TIME ZONE $tz)::date so ASX
// sessions that span midnight UTC are correctly attributed.
//
// Shared overhead (premarket header, meta-reasoner, chat) is split 50/50
// between US and ASX so each market's report shows its TRUE share of the
// daily LLM bill.
async function getDailyCostsByMarket({ tradingDate, market, tz }) {
  const directQ = await db.query(
    `SELECT service,
            COUNT(*)::int       AS calls,
            SUM(total_tokens)::bigint AS tokens,
            SUM(cost_usd)::float AS cost_usd
       FROM llm_usage_logs
      WHERE market = $1
        AND (created_at AT TIME ZONE $3)::date = $2::date
      GROUP BY service
      ORDER BY cost_usd DESC`,
    [market, tradingDate, tz]
  );
  const sharedQ = await db.query(
    `SELECT service,
            COUNT(*)::int       AS calls,
            SUM(total_tokens)::bigint AS tokens,
            SUM(cost_usd)::float AS cost_usd
       FROM llm_usage_logs
      WHERE market = 'SHARED'
        AND (created_at AT TIME ZONE $2)::date = $1::date
      GROUP BY service
      ORDER BY cost_usd DESC`,
    [tradingDate, tz]
  );

  const directBreakdown = directQ.rows.map(r => ({
    service: r.service,
    calls: r.calls,
    tokens: Number(r.tokens) || 0,
    cost_usd: +(r.cost_usd || 0),
    shared: false,
  }));
  // Shared services serve BOTH markets — so the report shows the full call
  // and token totals (informational), but only HALF the cost is attributed
  // to this market. This way US.cost + ASX.cost = full daily spend without
  // double-counting (the previous Math.round/2 over-attributed odd counts —
  // e.g. 1 shared call became 1 in US + 1 in ASX = inflated 2).
  const sharedBreakdown = sharedQ.rows.map(r => ({
    service: r.service,
    calls: r.calls,                                      // full count (informational)
    tokens: Number(r.tokens) || 0,                       // full token count
    cost_usd: +((r.cost_usd || 0) / 2).toFixed(4),       // exactly halved
    shared: true,
  }));

  const breakdown = [...directBreakdown, ...sharedBreakdown];
  // Totals: cost is the source of truth (halved for shared so two markets
  // sum to actual spend). For calls/tokens we sum direct + half of shared
  // using floor — keeps the headline number from inflating on odd counts
  // while preserving the per-row full counts in the breakdown.
  const total_cost_usd = +breakdown.reduce((a, b) => a + b.cost_usd, 0).toFixed(4);
  const total_calls = directBreakdown.reduce((a, b) => a + b.calls, 0)
    + sharedBreakdown.reduce((a, b) => a + Math.floor(b.calls / 2), 0);
  const total_tokens = directBreakdown.reduce((a, b) => a + b.tokens, 0)
    + sharedBreakdown.reduce((a, b) => a + Math.floor(b.tokens / 2), 0);
  return { total_calls, total_tokens, total_cost_usd, breakdown };
}

function getMemCounters() {
  const out = {};
  for (const [k, v] of memCounters) out[k] = v;
  return out;
}

module.exports = {
  ensureSchema,
  recordUsage,
  computeCost,
  getDailyCostsByMarket,
  getMemCounters,
  PRICING,  // exported for tests / debug
};
