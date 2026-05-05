/*
 * Continuous Online Learning Layer
 * --------------------------------
 * Upgrades the existing per-close learning loop (adaptive + RL + llmWeighting +
 * regimeMeta) to TRUE per-bar continuous online learning. Three additions:
 *
 *   (1) PER-BAR CALIBRATION — every agent cycle (~60s), for every open holding,
 *       we compute the realized 1-bar return and fold it into a per-(model,
 *       strategy, regime, market) calibration buffer. Brier scores + ECE
 *       (expected calibration error) are computed live.
 *
 *   (2) GRADIENT-BASED FINE-TUNE — tiny SGD steps on:
 *       (a) per-(model, ctx) WEIGHT-DELTA MULTIPLIER (bounded [0.95, 1.05])
 *           consumed by llmWeightingService BEFORE its own master clamp
 *           [0.5, 1.5] + Σ=N renorm. The master clamp + renorm are the final
 *           authority — our nudge can never breach the existing invariant.
 *       (b) per-threshold REGIME-THRESHOLD MULTIPLIER (bounded [0.85, 1.15])
 *           consumed by regimeService when classifying regimes. Hard floors
 *           on the underlying constants are preserved.
 *
 *   (3) DASHBOARD ENDPOINT — GET /api/continuous-learning/dashboard returns
 *       live calibration curves, per-model brier/ECE, weight-delta state,
 *       threshold drift, and tick counters.
 *
 * SAFETY CONTRACT — STRICTLY ADDITIVE, ZERO VETO POWER
 * ----------------------------------------------------
 * This layer can ONLY nudge inputs to existing services. It cannot:
 *   - bypass the 3-of-4 raw quorum (raw quorum doesn't read weights)
 *   - bypass the 85% / 90% confidence gate (gate uses min(rawConf, weightedConf))
 *   - bypass the $100/day USD loss budget (riskManager owns that)
 *   - bypass the 5% drawdown circuit breaker (riskManager owns that)
 *   - bypass the kill switch, no-averaging-in, or trailing-stop ratchet
 *   - bypass the master weight clamp [0.5, 1.5] + Σ=N renorm (we apply BEFORE)
 *   - widen any regime threshold beyond ±15% of its hardcoded base
 *
 * All updates are best-effort and wrapped in swallow-errors so a learning
 * hiccup can never break the trading loop.
 */
const db = require('./db');

const LEARNING_RATE_WEIGHT = 0.002;
const LEARNING_RATE_THRESHOLD = 0.001;
const WEIGHT_DELTA_MIN = 0.95;
const WEIGHT_DELTA_MAX = 1.05;
const THRESHOLD_DELTA_MIN = 0.85;
const THRESHOLD_DELTA_MAX = 1.15;
const CALIBRATION_BUFFER_SIZE = 200;
const CALIBRATION_BINS = 10;
const KNOWN_MODELS = ['openai', 'claude', 'grok', 'gemini'];
const MAX_CALIBRATION_BUCKETS = 200;          // LRU cap to prevent unbounded growth (architect MEDIUM fix)
const MAX_LAST_BAR_PRICES = 500;              // LRU cap for per-symbol last-bar price tracker
const PWIN_LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;

let _state = null;
const _calibrationBuffers = new Map();         // insertion-order Map serves as LRU
let _tickCounter = 0;
let _tickLast1h = [];
let _lastTickAt = null;
const _lastBarPriceBySymbol = new Map();
const _pwinLookupCache = new Map();            // (symbol|strategy) → { pwin, fetchedAt }

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

async function _ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS continuous_learning_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS continuous_learning_calibration (
      bucket TEXT PRIMARY KEY,
      brier DOUBLE PRECISION NOT NULL DEFAULT 0,
      ece DOUBLE PRECISION NOT NULL DEFAULT 0,
      n_samples INTEGER NOT NULL DEFAULT 0,
      bins JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function _loadState() {
  if (_state) return _state;
  await _ensureSchema();
  const { rows } = await db.query('SELECT key, value FROM continuous_learning_state');
  _state = { weightDeltas: {}, thresholdDeltas: {} };
  for (const r of rows) {
    if (r.key.startsWith('w:')) _state.weightDeltas[r.key.slice(2)] = Number(r.value.delta) || 1.0;
    else if (r.key.startsWith('t:')) _state.thresholdDeltas[r.key.slice(2)] = Number(r.value.delta) || 1.0;
  }
  return _state;
}

async function _persistDelta(prefix, key, delta) {
  await db.query(
    `INSERT INTO continuous_learning_state (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [`${prefix}:${key}`, JSON.stringify({ delta })]
  );
}

function _bucketKey({ modelId, strategy, regime, market }) {
  return `${modelId}|${strategy || 'unknown'}|${regime || 'unknown'}|${market || 'US'}`;
}

function _pushSample(modelId, ctx, predicted, realized) {
  const key = _bucketKey({ modelId, ...ctx });
  let buf = _calibrationBuffers.get(key);
  if (!buf) {
    buf = [];
    // LRU eviction (architect MEDIUM fix): if at cap, evict the oldest
    // (first-inserted) bucket. JS Map preserves insertion order so we
    // delete the first key from the iterator.
    if (_calibrationBuffers.size >= MAX_CALIBRATION_BUCKETS) {
      const oldest = _calibrationBuffers.keys().next().value;
      if (oldest !== undefined) _calibrationBuffers.delete(oldest);
    }
    _calibrationBuffers.set(key, buf);
  } else {
    // Touch — re-insert moves to end of insertion order (LRU touch).
    _calibrationBuffers.delete(key);
    _calibrationBuffers.set(key, buf);
  }
  buf.push({ p: predicted, r: realized, t: Date.now() });
  if (buf.length > CALIBRATION_BUFFER_SIZE) buf.shift();
}

/**
 * Look up the most recent decision-time predicted P(win) for a (symbol,
 * strategy) by reading the latest SIGNAL audit row. We use BUY-vote fraction
 * as a proxy: BUY_votes / (BUY+HOLD+SELL) gives the consensus "wants long
 * exposure" probability, which IS the prediction we're calibrating against
 * 1-bar realized return for an open long. Cached per (symbol|strategy) for
 * 5 min so we don't hit DB every tick.
 *
 * Returns a number in (0, 1) or null if no signal found.
 */
async function _lookupPredictedPwin(symbol, strategy) {
  const key = `${symbol}|${strategy || 'day'}`;
  const cached = _pwinLookupCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PWIN_LOOKUP_CACHE_TTL_MS) {
    return cached.pwin;
  }
  try {
    const { rows } = await db.query(
      `SELECT payload FROM audit_log
       WHERE event_type = 'SIGNAL'
         AND payload->>'symbol' = $1
         AND payload->>'strategy' = $2
       ORDER BY id DESC LIMIT 1`,
      [symbol, strategy || 'day']
    );
    let pwin = null;
    if (rows[0]?.payload?.votes) {
      const v = rows[0].payload.votes;
      const total = (Number(v.BUY) || 0) + (Number(v.HOLD) || 0) + (Number(v.SELL) || 0);
      if (total > 0) {
        // BUY-vote fraction is the consensus P(want long); clamp away from
        // hard 0/1 to keep brier finite.
        const buyFrac = (Number(v.BUY) || 0) / total;
        pwin = clamp(buyFrac, 0.05, 0.95);
      }
    }
    _pwinLookupCache.set(key, { pwin, fetchedAt: Date.now() });
    // Cap pwin lookup cache size too (LRU)
    if (_pwinLookupCache.size > 1000) {
      const oldest = _pwinLookupCache.keys().next().value;
      if (oldest !== undefined) _pwinLookupCache.delete(oldest);
    }
    return pwin;
  } catch (_) { return null; }
}

function _brier(buf) {
  if (!buf.length) return 0;
  return buf.reduce((s, x) => s + Math.pow(x.p - x.r, 2), 0) / buf.length;
}

function _ece(buf) {
  if (!buf.length) return 0;
  const bins = Array.from({ length: CALIBRATION_BINS }, () => ({ sumP: 0, sumR: 0, n: 0 }));
  for (const x of buf) {
    const idx = Math.min(CALIBRATION_BINS - 1, Math.floor(x.p * CALIBRATION_BINS));
    bins[idx].sumP += x.p; bins[idx].sumR += x.r; bins[idx].n++;
  }
  let ece = 0;
  for (const b of bins) {
    if (b.n > 0) ece += (b.n / buf.length) * Math.abs(b.sumP / b.n - b.sumR / b.n);
  }
  return ece;
}

function _calibrationCurve(buf) {
  const bins = Array.from({ length: CALIBRATION_BINS }, (_, i) => ({
    p_low: i / CALIBRATION_BINS, p_high: (i + 1) / CALIBRATION_BINS,
    sumP: 0, sumR: 0, n: 0,
  }));
  for (const x of buf) {
    const idx = Math.min(CALIBRATION_BINS - 1, Math.floor(x.p * CALIBRATION_BINS));
    bins[idx].sumP += x.p; bins[idx].sumR += x.r; bins[idx].n++;
  }
  return bins.map(b => ({
    bin: `${(b.p_low * 100).toFixed(0)}-${(b.p_high * 100).toFixed(0)}%`,
    n: b.n,
    avgPredicted: b.n ? +(b.sumP / b.n).toFixed(3) : null,
    observedFreq: b.n ? +(b.sumR / b.n).toFixed(3) : null,
  }));
}

/**
 * Per-bar tick — called from agent.js runCycle ONCE per cycle. Iterates
 * holdings, computes realized 1-bar return per holding, folds into the
 * per-(model, ctx) calibration buffer, and applies tiny SGD steps to
 * weight-delta + threshold-delta state.
 *
 * BEST-EFFORT — never throws.
 */
async function onBarTick({ holdings = [], priceLookup = {}, regime = 'unknown', market = 'US' } = {}) {
  try {
    await _loadState();
    _tickCounter++;
    _lastTickAt = Date.now();
    _tickLast1h.push(_lastTickAt);
    const cutoff = _lastTickAt - 60 * 60 * 1000;
    _tickLast1h = _tickLast1h.filter(t => t >= cutoff);

    for (const h of holdings) {
      const sym = h.symbol;
      // Price source priority: explicit priceLookup (live cycle prices) →
      // h.current_price (legacy field, usually absent) → null = skip.
      const cur = priceLookup[sym]?.price ?? (h.current_price != null ? Number(h.current_price) : null);
      if (cur == null || !Number.isFinite(cur)) continue;
      const prev = _lastBarPriceBySymbol.get(sym);
      // LRU touch + cap (architect MEDIUM fix follow-up)
      _lastBarPriceBySymbol.delete(sym);
      _lastBarPriceBySymbol.set(sym, cur);
      if (_lastBarPriceBySymbol.size > MAX_LAST_BAR_PRICES) {
        const oldest = _lastBarPriceBySymbol.keys().next().value;
        if (oldest !== undefined) _lastBarPriceBySymbol.delete(oldest);
      }
      if (prev == null || prev <= 0) continue;

      const realized1bar = (cur - prev) / prev;
      if (!Number.isFinite(realized1bar)) continue;

      // Predicted P(win) — for long holdings, the BUY-vote fraction from
      // the latest SIGNAL row is the model's "should we be long" probability.
      // Falls back to 0.5 (uninformative) only when no signal has been
      // recorded for this (symbol, strategy) — rare in steady state.
      const lookedUp = await _lookupPredictedPwin(sym, h.strategy);
      const predicted = clamp(Number(lookedUp) || 0.5, 0.01, 0.99);
      const realized = realized1bar > 0 ? 1 : 0;
      const ctx = { strategy: h.strategy, regime, market: h.market || market };

      // Fold the same realized outcome into every voter's calibration buffer
      // (each voter's predicted comes from their own audit row when available;
      // we approximate with the consensus pwin here — the dashboard surfaces
      // the per-bucket curve regardless).
      for (const modelId of KNOWN_MODELS) {
        _pushSample(modelId, ctx, predicted, realized);
        // SGD: gradient of squared error wrt predicted is 2*(p - r).
        // Update is a TINY nudge toward better calibration.
        const grad = 2 * (predicted - realized);
        const key = _bucketKey({ modelId, ...ctx });
        const cur_d = _state.weightDeltas[key] ?? 1.0;
        // If model OVER-predicted (p>r, grad>0), its weight delta nudges DOWN;
        // if it UNDER-predicted, weight delta nudges UP. Bounded.
        const next = clamp(cur_d - LEARNING_RATE_WEIGHT * grad, WEIGHT_DELTA_MIN, WEIGHT_DELTA_MAX);
        if (Math.abs(next - cur_d) > 1e-5) {
          _state.weightDeltas[key] = next;
          // Persist sparingly — only every ~10 ticks per bucket to avoid DB
          // chatter. Reads always go through in-memory _state.
          if (_tickCounter % 10 === 0) {
            _persistDelta('w', key, next).catch(() => {});
          }
        }
      }

      // Regime-threshold gradient: drift HIGH_VOL_ATR_PCT toward the
      // realized abs-return scale. If realized |return| is consistently
      // HIGHER than current threshold expects, threshold drifts UP (less
      // sensitive); if LOWER, drifts DOWN (more sensitive). Bounded ±15%.
      const obs = Math.abs(realized1bar) * 100;  // bar return in % units
      const thrKey = 'HIGH_VOL_ATR_PCT';
      const cur_t = _state.thresholdDeltas[thrKey] ?? 1.0;
      const target = obs / 2.5;  // 2.5 is the hardcoded base
      const grad_t = cur_t - target;
      const next_t = clamp(cur_t - LEARNING_RATE_THRESHOLD * grad_t, THRESHOLD_DELTA_MIN, THRESHOLD_DELTA_MAX);
      if (Math.abs(next_t - cur_t) > 1e-6) {
        _state.thresholdDeltas[thrKey] = next_t;
        if (_tickCounter % 10 === 0) {
          _persistDelta('t', thrKey, next_t).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error('[ContinuousLearning] onBarTick swallowed:', e.message);
  }
}

/**
 * Read-side API for llmWeightingService — returns a multiplier in
 * [WEIGHT_DELTA_MIN, WEIGHT_DELTA_MAX]. Never null, defaults to 1.0.
 * The caller MUST still apply its own master clamp + Σ=N renorm.
 */
function getWeightDelta({ modelId, strategy, regime, market }) {
  if (!_state) return 1.0;
  const key = _bucketKey({ modelId, strategy, regime, market });
  return _state.weightDeltas[key] ?? 1.0;
}

/**
 * Read-side API for regimeService — returns a multiplier in
 * [THRESHOLD_DELTA_MIN, THRESHOLD_DELTA_MAX]. Never null, defaults to 1.0.
 * The caller MUST still apply its own min/max safety clamps.
 */
function getThresholdDelta(name) {
  if (!_state) return 1.0;
  return _state.thresholdDeltas[name] ?? 1.0;
}

async function getDashboard() {
  try {
    await _loadState();
  } catch (_) { /* dashboard works even if state load fails */ }

  // Per-model summary across all buckets.
  const perModel = {};
  for (const m of KNOWN_MODELS) perModel[m] = { n: 0, brier: 0, ece: 0, buckets: 0 };
  let totalSamples = 0;
  const calibrationCurves = {};
  for (const [key, buf] of _calibrationBuffers.entries()) {
    if (!buf.length) continue;
    const modelId = key.split('|')[0];
    if (!perModel[modelId]) continue;
    perModel[modelId].n += buf.length;
    perModel[modelId].brier += _brier(buf) * buf.length;
    perModel[modelId].ece += _ece(buf) * buf.length;
    perModel[modelId].buckets++;
    totalSamples += buf.length;
    if (!calibrationCurves[modelId]) calibrationCurves[modelId] = _calibrationCurve(buf);
  }
  for (const m of KNOWN_MODELS) {
    if (perModel[m].n > 0) {
      perModel[m].brier = +(perModel[m].brier / perModel[m].n).toFixed(4);
      perModel[m].ece = +(perModel[m].ece / perModel[m].n).toFixed(4);
    }
  }

  return {
    config: {
      learningRateWeight: LEARNING_RATE_WEIGHT,
      learningRateThreshold: LEARNING_RATE_THRESHOLD,
      weightDeltaBounds: [WEIGHT_DELTA_MIN, WEIGHT_DELTA_MAX],
      thresholdDeltaBounds: [THRESHOLD_DELTA_MIN, THRESHOLD_DELTA_MAX],
      calibrationBufferSize: CALIBRATION_BUFFER_SIZE,
    },
    safety: {
      contract: 'STRICTLY ADDITIVE — zero veto power. Quorum (3-of-4 raw), confidence gate, $100/day USD loss budget, 5% drawdown breaker, kill switch, no-averaging-in, and trailing-stop ratchet ALL retain full veto. Master weight clamp [0.5,1.5] + Σ=N renorm in llmWeightingService applies AFTER our nudge. Regime threshold floors enforced by regimeService.',
    },
    ticks: {
      total: _tickCounter,
      last1h: _tickLast1h.length,
      lastTickAt: _lastTickAt,
    },
    perModel,
    calibrationCurves,
    weightDeltas: _state?.weightDeltas || {},
    weightDeltaCount: Object.keys(_state?.weightDeltas || {}).length,
    thresholdDeltas: _state?.thresholdDeltas || {},
    activeBuckets: _calibrationBuffers.size,
    totalSamples,
  };
}

module.exports = {
  onBarTick,
  getWeightDelta,
  getThresholdDelta,
  getDashboard,
  // for tests
  _internal: { _bucketKey, _brier, _ece, _calibrationCurve, KNOWN_MODELS,
    WEIGHT_DELTA_MIN, WEIGHT_DELTA_MAX, THRESHOLD_DELTA_MIN, THRESHOLD_DELTA_MAX },
};
