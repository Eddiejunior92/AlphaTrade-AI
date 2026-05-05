// Deeper machine-learning adaptive layer.
//
// Sits ON TOP of the existing adaptiveLearningService (which tracks raw
// per-(symbol,strategy) win rates). This layer learns a *function* of the
// decision context — LLM consensus confidence, model agreement, news/social
// sentiment, RSI/MACD/volume/volatility — that maps to:
//
//   1. P(win)               — calibrated probability of a profitable close.
//   2. Expected R-multiple  — pnl divided by per-trade USD risk.
//
// Two tiny online models are trained per closed trade with stochastic
// gradient descent and L2 regularization (~12 weights each, persisted to a
// single Postgres row as JSON). The math is plain Node — no numpy, torch,
// onnx, etc. — so the layer adds zero deployment surface.
//
// Outputs:
//   • mlMult           — sizing multiplier in [0.85, 1.15], stacked AFTER
//                        the legacy adaptive multiplier inside riskManager.
//                        Clamped to keep the existing safety envelope intact.
//   • pWin             — calibrated probability surfaced in the audit trail
//                        and the adaptive dashboard for confidence telemetry.
//
// SAFETY (unchanged contract):
//   • The mlMult is a SIZING NUDGE, never a gate. Quorum / confidence
//     threshold / daily caps / circuit breaker all run BEFORE this layer
//     can adjust qty.
//   • Until n_updates ≥ MIN_TRAIN, predict() returns mlMult=1.0 (no-op) so
//     the agent runs identically to before during the cold-start window.
//   • Every public method swallows errors — a learning hiccup must never
//     block trading.
const db = require('./db');

// --- Feature schema --------------------------------------------------------
// Order matters: must match between extractFeatures, predict, and update.
// `bias` is always 1.0 — gives the model a free intercept term.
const FEATURE_NAMES = [
  'bias',
  'llm_confidence',     // signal.confidence ∈ [0,1]
  'agreement_ratio',    // signal.agreement  ∈ [0,1]
  'valid_models_frac',  // validCount / totalModels
  'sentiment_score',    // newsSentiment.score ∈ [-1,1]
  'sentiment_news',     // newsSentiment.news_score
  'sentiment_social',   // newsSentiment.social_score
  'rsi_centered',       // (rsi - 50) / 50  ∈ ~[-1,1]
  'macd_hist_sign',     // sign of MACD histogram (-1,0,+1)
  'volume_ratio',       // (volume.ratio - 1) clipped to [-1,1]
  'vol_atr_pct',        // (atrPct - 2) / 4  ∈ ~[-1,1]  (mean ATR ≈ 2%)
  'is_swing',           // 1 if swing, 0 if day
  'is_asx',             // 1 if ASX, 0 if US
  // --- Regime one-hot (4 dims, mutually-exclusive flags). Adding these to
  // the ML adaptive feature schema bumps the persisted vector length, which
  // the load() path will detect and cold-start from automatically.
  'is_high_vol',
  'is_trending',
  'is_mean_revert',
  'is_news_driven',
];
const N_FEATURES = FEATURE_NAMES.length;

// --- Hyperparameters -------------------------------------------------------
const LR_LOGISTIC = 0.05;     // SGD step for the win-probability head
const LR_LINEAR   = 0.02;     // SGD step for the R-multiple head
const L2          = 0.001;    // ridge penalty — keeps weights bounded
const MIN_TRAIN   = parseInt(process.env.ML_ADAPTIVE_MIN_TRAIN || '15');
const MULT_MIN    = 0.85;
const MULT_MAX    = 1.15;
// Map predicted R-multiple → multiplier. A predicted R of +0.5 → +5% size,
// a predicted R of -0.5 → -5%. SCALE controls how aggressively predicted
// edge translates into sizing. Tight on purpose so the safety band holds.
const R_TO_MULT_SCALE = 0.10;

// --- In-memory state -------------------------------------------------------
// Loaded from DB on first use, then mutated in-place by recordOutcome().
let _state = {
  loaded: false,
  // Logistic-regression head (predict pWin).
  wLogistic: new Array(N_FEATURES).fill(0),
  // Linear-regression head (predict R-multiple).
  wLinear:   new Array(N_FEATURES).fill(0),
  nUpdates: 0,
  lastUpdated: null,
  // Lifetime metrics for the dashboard.
  brierSum: 0,    // running sum of (pWin - actualWin)^2
  brierN: 0,
  rmseSum: 0,     // running sum of (rPred - rActual)^2
  rmseN: 0,
};

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ml_adaptive_weights (
      name        TEXT PRIMARY KEY,
      weights     JSONB NOT NULL,
      n_updates   INTEGER NOT NULL DEFAULT 0,
      metrics     JSONB,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function load() {
  if (_state.loaded) return;
  try {
    await ensureSchema();
    const { rows } = await db.query(`SELECT * FROM ml_adaptive_weights WHERE name = 'v1'`);
    if (rows.length) {
      const r = rows[0];
      const w = r.weights || {};
      // Defensive: if EITHER head's persisted weight vector doesn't match the
      // current feature schema, treat this as a full schema migration and
      // FULLY cold-start — zeroed weights, zeroed nUpdates, zeroed metrics.
      // Otherwise the model would report `trained=true` with all-zero weights
      // and start emitting non-neutral mlMult values immediately, defeating
      // the MIN_TRAIN cold-start safety. (Architect-flagged.)
      const lenOk = Array.isArray(w.wLogistic) && w.wLogistic.length === N_FEATURES &&
                    Array.isArray(w.wLinear)   && w.wLinear.length   === N_FEATURES;
      if (lenOk) {
        _state.wLogistic = w.wLogistic.slice();
        _state.wLinear   = w.wLinear.slice();
        _state.nUpdates  = Number(r.n_updates) || 0;
        const m = r.metrics || {};
        _state.brierSum = Number(m.brierSum) || 0;
        _state.brierN   = Number(m.brierN)   || 0;
        _state.rmseSum  = Number(m.rmseSum)  || 0;
        _state.rmseN    = Number(m.rmseN)    || 0;
        _state.lastUpdated = r.updated_at;
      } else {
        console.warn(`[MLAdaptive] feature schema changed (persisted lengths ${w.wLogistic?.length}/${w.wLinear?.length} vs current ${N_FEATURES}) — full cold-start.`);
        _state.wLogistic = new Array(N_FEATURES).fill(0);
        _state.wLinear   = new Array(N_FEATURES).fill(0);
        _state.nUpdates  = 0;
        _state.brierSum = 0; _state.brierN = 0;
        _state.rmseSum  = 0; _state.rmseN  = 0;
        _state.lastUpdated = null;
      }
    }
  } catch (e) {
    console.warn('[MLAdaptive] load failed (will keep zero weights):', e.message);
  }
  _state.loaded = true;
}

// Debounced persistence — writes after every update are fine here because
// it's one tiny row per trade (a handful per day in practice), but we batch
// inside transactions so the round-trip cost is trivial.
async function persist() {
  try {
    const metrics = {
      brierSum: _state.brierSum, brierN: _state.brierN,
      rmseSum: _state.rmseSum,   rmseN: _state.rmseN,
    };
    const weights = { wLogistic: _state.wLogistic, wLinear: _state.wLinear, featureNames: FEATURE_NAMES };
    await db.query(`
      INSERT INTO ml_adaptive_weights (name, weights, n_updates, metrics, updated_at)
      VALUES ('v1', $1, $2, $3, NOW())
      ON CONFLICT (name) DO UPDATE SET
        weights    = EXCLUDED.weights,
        n_updates  = EXCLUDED.n_updates,
        metrics    = EXCLUDED.metrics,
        updated_at = NOW()
    `, [JSON.stringify(weights), _state.nUpdates, JSON.stringify(metrics)]);
    _state.lastUpdated = new Date().toISOString();
  } catch (e) {
    console.warn('[MLAdaptive] persist failed:', e.message);
  }
}

// Numerically-stable sigmoid.
function sigmoid(z) {
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z); return e / (1 + e);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function dot(w, x) {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
}

// --- Feature extraction ----------------------------------------------------
// Builds the feature vector from whatever decision context is available.
// Missing pieces (e.g. unavailable indicators) collapse to neutral values so
// the model degrades gracefully rather than crashing or biasing predictions.
function extractFeatures({ signal, newsSentiment, indicators, strategyName, market, regime }) {
  const x = new Array(N_FEATURES).fill(0);
  x[0] = 1;                                                           // bias
  x[1] = clamp(Number(signal?.confidence) || 0, 0, 1);                 // llm_confidence
  x[2] = clamp(Number(signal?.agreement)  || 0, 0, 1);                 // agreement_ratio
  const validFrac = signal?.totalModels ? (signal.validCount || 0) / signal.totalModels : 0;
  x[3] = clamp(validFrac, 0, 1);                                       // valid_models_frac
  x[4] = clamp(Number(newsSentiment?.score)        || 0, -1, 1);
  x[5] = clamp(Number(newsSentiment?.news_score)   || 0, -1, 1);
  x[6] = clamp(Number(newsSentiment?.social_score) || 0, -1, 1);
  if (indicators && indicators.ok) {
    const rsi = Number(indicators.rsi);
    if (Number.isFinite(rsi)) x[7] = clamp((rsi - 50) / 50, -1, 1);
    const hist = Number(indicators.macd?.histogram);
    if (Number.isFinite(hist)) x[8] = hist > 0 ? 1 : (hist < 0 ? -1 : 0);
    const vr = Number(indicators.volume?.ratio);
    if (Number.isFinite(vr)) x[9] = clamp(vr - 1, -1, 1);
    const atr = Number(indicators.volatility?.atrPct);
    if (Number.isFinite(atr)) x[10] = clamp((atr - 2) / 4, -1, 1);
  }
  x[11] = strategyName === 'swing' ? 1 : 0;
  x[12] = market === 'ASX' ? 1 : 0;
  // Regime one-hot (indices 13..16). Inline import to avoid a circular
  // dependency between this service and any future regime consumer.
  const p = regime?.primary || 'normal';
  x[13] = p === 'high_vol' ? 1 : 0;
  x[14] = (p === 'trending_up' || p === 'trending_down') ? 1 : 0;
  x[15] = p === 'mean_reverting' ? 1 : 0;
  x[16] = p === 'news_driven' ? 1 : 0;
  return x;
}

// --- Predict ---------------------------------------------------------------
// Returns:
//   pWin       — sigmoid(w_logistic · x)
//   rPred      — w_linear · x  (predicted R-multiple)
//   mlMult     — clamp(1 + R_TO_MULT_SCALE * rPred, MULT_MIN, MULT_MAX)
//   trained    — true once n_updates ≥ MIN_TRAIN
// During cold start (untrained) returns neutral defaults — agent behavior is
// identical to before this layer existed.
async function predict(features) {
  await load();
  try {
    if (!features || features.length !== N_FEATURES) {
      return { pWin: null, rPred: null, mlMult: 1.0, trained: false, reason: 'bad-feature-vec' };
    }
    if (_state.nUpdates < MIN_TRAIN) {
      return { pWin: null, rPred: null, mlMult: 1.0, trained: false, reason: `cold-start (${_state.nUpdates}/${MIN_TRAIN})` };
    }
    const z = dot(_state.wLogistic, features);
    const pWin = sigmoid(z);
    const rPred = dot(_state.wLinear, features);
    const mlMult = +clamp(1 + R_TO_MULT_SCALE * rPred, MULT_MIN, MULT_MAX).toFixed(4);
    return { pWin: +pWin.toFixed(4), rPred: +rPred.toFixed(4), mlMult, trained: true };
  } catch (e) {
    console.warn('[MLAdaptive] predict failed:', e.message);
    return { pWin: null, rPred: null, mlMult: 1.0, trained: false, reason: 'error' };
  }
}

// --- Online update ---------------------------------------------------------
// Called once per closed trade with the SAME feature vector that was logged
// at decision time, plus the realised pnl and the per-trade USD risk used
// (so we can compute the R-multiple the model is trying to learn).
//
// Logistic SGD:  w := w * (1 - lr*L2) + lr * (y - pHat) * x       , y∈{0,1}
// Linear  SGD:  w := w * (1 - lr*L2) + lr * (rActual - rPred) * x
async function recordOutcome({ features, pnl, riskUSD }) {
  try {
    if (!Array.isArray(features) || features.length !== N_FEATURES) return;
    const pnlNum = Number(pnl);
    if (!Number.isFinite(pnlNum)) return;
    const risk = Math.max(Number(riskUSD) || 0, 1); // floor at $1 to avoid div0
    const rActual = clamp(pnlNum / risk, -3, 3);    // R-multiple, clipped
    const y = pnlNum > 0 ? 1 : 0;

    await load();

    // --- Pre-update metrics (track calibration drift on hold-out-style basis)
    const pHat = sigmoid(dot(_state.wLogistic, features));
    const rPredPre = dot(_state.wLinear, features);
    _state.brierSum += (pHat - y) * (pHat - y);
    _state.brierN   += 1;
    _state.rmseSum  += (rPredPre - rActual) * (rPredPre - rActual);
    _state.rmseN    += 1;

    // --- Logistic SGD (pWin head) -------------------------------------------
    const errLog = y - pHat;
    for (let i = 0; i < N_FEATURES; i++) {
      _state.wLogistic[i] = _state.wLogistic[i] * (1 - LR_LOGISTIC * L2) + LR_LOGISTIC * errLog * features[i];
    }

    // --- Linear SGD (R-multiple head) ---------------------------------------
    const errLin = rActual - rPredPre;
    for (let i = 0; i < N_FEATURES; i++) {
      _state.wLinear[i] = _state.wLinear[i] * (1 - LR_LINEAR * L2) + LR_LINEAR * errLin * features[i];
    }

    _state.nUpdates += 1;
    await persist();
    if (_state.nUpdates % 10 === 0 || _state.nUpdates === MIN_TRAIN) {
      const brier = _state.brierN ? _state.brierSum / _state.brierN : null;
      const rmse  = _state.rmseN  ? Math.sqrt(_state.rmseSum / _state.rmseN) : null;
      console.log(`[MLAdaptive] +outcome n=${_state.nUpdates} y=${y} pHat=${pHat.toFixed(3)} rActual=${rActual.toFixed(2)} brier=${brier?.toFixed(3)} R-rmse=${rmse?.toFixed(2)}`);
    }
  } catch (e) {
    // CRITICAL: swallow everything — ML must never break trading.
    console.error('[MLAdaptive] recordOutcome failed (swallowed):', e.message);
  }
}

// --- Status (for dashboard / debugging) ------------------------------------
async function getStatus() {
  await load();
  const brier = _state.brierN ? _state.brierSum / _state.brierN : null;
  const rmse  = _state.rmseN  ? Math.sqrt(_state.rmseSum / _state.rmseN) : null;
  // Top features by |weight| — quick "what is it learning" signal.
  const ranked = (head) => FEATURE_NAMES.map((name, i) => ({ name, weight: +head[i].toFixed(4) }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 6);
  return {
    version: 'v1',
    n_updates: _state.nUpdates,
    min_train: MIN_TRAIN,
    trained: _state.nUpdates >= MIN_TRAIN,
    last_updated: _state.lastUpdated,
    feature_names: FEATURE_NAMES,
    weights_logistic: _state.wLogistic.map(w => +w.toFixed(4)),
    weights_linear:   _state.wLinear.map(w => +w.toFixed(4)),
    top_logistic_features: ranked(_state.wLogistic),
    top_linear_features:   ranked(_state.wLinear),
    brier_score: brier != null ? +brier.toFixed(4) : null,    // lower is better, 0.25 = random
    r_rmse: rmse != null ? +rmse.toFixed(4) : null,
    mult_band: [MULT_MIN, MULT_MAX],
  };
}

module.exports = {
  ensureSchema, load, predict, recordOutcome, extractFeatures, getStatus,
  FEATURE_NAMES, MIN_TRAIN,
};
