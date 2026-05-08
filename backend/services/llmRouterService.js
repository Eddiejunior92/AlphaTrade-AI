// =============================================================================
// LLM Router Service — per-task best-model selection with persistence
// =============================================================================
// Tracks per-(task_type, model_id) success + quality, picks the historically-
// best model for each Council role / sub-task. Falls back to Grok (always
// available via XAI_API_KEY) when the preferred model has been failing or
// has no track record yet.
//
// SAFETY: this is a routing/cost-optimisation only. It NEVER influences
// quorum, gate, sizing, or any safety rail. Failures are swallowed —
// caller falls back to its hard-coded default. The router never picks a
// model that isn't in the allowed pool the caller passes in.
// =============================================================================

const db = require('./db');

const MIN_SAMPLES_BEFORE_TRUST = 8;
const RECENCY_HALF_LIFE_HOURS = 72;
const FALLBACK_MODEL_ID = 'grok';

// In-memory perf cache (refreshed every PERF_CACHE_TTL_MS). DB writes are
// async and non-blocking; reads come from cache so the hot path stays fast.
const PERF_CACHE_TTL_MS = 60 * 1000;
let _perfCache = null;
let _perfCacheTs = 0;

async function _loadPerf() {
  if (_perfCache && Date.now() - _perfCacheTs < PERF_CACHE_TTL_MS) return _perfCache;
  try {
    const r = await db.query(`
      SELECT task_type, model_id, n_calls, n_success, avg_quality, last_success_at, last_error_at
      FROM llm_router_perf
    `);
    const map = {};
    for (const row of r.rows) {
      const key = row.task_type;
      if (!map[key]) map[key] = {};
      map[key][row.model_id] = {
        n_calls: parseInt(row.n_calls) || 0,
        n_success: parseInt(row.n_success) || 0,
        avg_quality: parseFloat(row.avg_quality) || 0,
        last_success_at: row.last_success_at,
        last_error_at: row.last_error_at,
      };
    }
    _perfCache = map;
    _perfCacheTs = Date.now();
    return map;
  } catch (e) {
    // Table may not exist yet on cold boot; degrade silently.
    _perfCache = {};
    _perfCacheTs = Date.now();
    return {};
  }
}

// Score = win-rate × quality × recency. Models with < MIN_SAMPLES_BEFORE_TRUST
// get a Bayesian prior toward 0.5 win-rate so they're not silently locked
// out before earning samples.
function _scoreModel(stat) {
  if (!stat || stat.n_calls === 0) return 0.5;
  const win = stat.n_calls > 0 ? stat.n_success / stat.n_calls : 0;
  const prior = MIN_SAMPLES_BEFORE_TRUST / (MIN_SAMPLES_BEFORE_TRUST + stat.n_calls);
  const smoothedWin = win * (1 - prior) + 0.5 * prior;
  const quality = Math.max(0.1, Math.min(1.0, stat.avg_quality || 0.5));
  let recency = 1.0;
  if (stat.last_error_at) {
    const ageHours = (Date.now() - new Date(stat.last_error_at).getTime()) / 3.6e6;
    // Recent errors damp the score; decay back to 1.0 over RECENCY_HALF_LIFE_HOURS.
    recency = 1 - 0.5 * Math.exp(-ageHours / RECENCY_HALF_LIFE_HOURS);
  }
  return smoothedWin * quality * recency;
}

// Pick the best model for a task. `pool` is the array of allowed model ids
// (e.g. ['gemini','grok','claude','gpt4o']). Returns { modelId, fromHistory }.
async function pickModel(taskType, pool) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return { modelId: FALLBACK_MODEL_ID, fromHistory: false };
  }
  const perf = await _loadPerf();
  const taskPerf = perf[taskType] || {};
  let best = null, bestScore = -1;
  for (const id of pool) {
    const s = _scoreModel(taskPerf[id]);
    if (s > bestScore) { bestScore = s; best = id; }
  }
  if (!best) best = pool.includes(FALLBACK_MODEL_ID) ? FALLBACK_MODEL_ID : pool[0];
  return { modelId: best, fromHistory: !!taskPerf[best] && taskPerf[best].n_calls > 0, score: +bestScore.toFixed(3) };
}

// Record an outcome. Quality is 0..1 (e.g. did response parse as valid JSON,
// did it complete within budget, did the verdict it produced lead to a win).
// Best-effort write — never throws.
async function recordOutcome({ taskType, modelId, success, quality, latencyMs }) {
  try {
    const q = Math.max(0, Math.min(1, parseFloat(quality)));
    await db.query(`
      INSERT INTO llm_router_perf (task_type, model_id, n_calls, n_success, avg_quality, last_success_at, last_error_at, last_latency_ms)
      VALUES ($1, $2, 1, $3, $4, $5, $6, $7)
      ON CONFLICT (task_type, model_id) DO UPDATE SET
        n_calls         = llm_router_perf.n_calls + 1,
        n_success       = llm_router_perf.n_success + EXCLUDED.n_success,
        avg_quality     = (llm_router_perf.avg_quality * llm_router_perf.n_calls + $4) / (llm_router_perf.n_calls + 1),
        last_success_at = COALESCE(EXCLUDED.last_success_at, llm_router_perf.last_success_at),
        last_error_at   = COALESCE(EXCLUDED.last_error_at,   llm_router_perf.last_error_at),
        last_latency_ms = $7
    `, [
      taskType, modelId,
      success ? 1 : 0,
      Number.isFinite(q) ? q : 0.5,
      success ? new Date() : null,
      success ? null : new Date(),
      Number.isFinite(parseInt(latencyMs)) ? parseInt(latencyMs) : null,
    ]);
    _perfCacheTs = 0; // bust cache so next pick reflects this update
  } catch (_) { /* swallow — router is best-effort */ }
}

async function getRouterStatus() {
  const perf = await _loadPerf();
  const out = {};
  for (const task of Object.keys(perf)) {
    out[task] = Object.entries(perf[task]).map(([modelId, s]) => ({
      modelId, ...s, score: +_scoreModel(s).toFixed(3),
    })).sort((a, b) => b.score - a.score);
  }
  return out;
}

module.exports = { pickModel, recordOutcome, getRouterStatus, FALLBACK_MODEL_ID };
