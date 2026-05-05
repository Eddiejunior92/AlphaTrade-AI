// Dynamic LLM Ensemble Weighting Layer.
//
// Learns optimal per-model weights per (strategy × regime × market) from
// realised P&L attributed to the originating BUY's voting models. Used to
// dynamically re-weight the 4 model votes in real time, with a strict
// safety contract: weights can ONLY ever tighten the existing quorum/gate,
// never relax it. The raw 3-of-4 quorum and 85% confidence threshold the
// risk manager already enforces remain fully intact and retain full veto
// power. Weights also feed the per-model prompt block so each LLM is told
// how its peers have historically performed in the current context.
//
// Cold-start safe: when sample counts are below the trust floor, weights
// fall back to the broader (model × strategy) bucket, then to uniform 1.0.
// All errors swallowed; layer can never break the trading loop.

const db = require('./db');

const MIN_SAMPLES_FULL_TRUST = 12;   // ≥12 trades in (model,strat,regime,market) ⇒ full trust
const PRIOR_TRADES = 8;              // Bayesian prior strength
const PRIOR_WIN_RATE = 0.50;         // assume 50% under the prior
// Weights live in [0.5, 1.5] — a 0% wr model is halved, a 100% wr model
// gets 1.5x. Sum is renormalised to N (model count) so on uniform inputs
// the weighted vote tally equals the raw count.
const WEIGHT_FLOOR = 0.5;
const WEIGHT_CEIL = 1.5;
const CACHE_TTL_MS = 60_000;          // 60s — weights change slowly

let _cache = { all: null, byContext: new Map(), updated: 0 };
const KNOWN_MODELS = ['gemini', 'claude', 'gpt4o', 'grok'];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Bayesian win-rate smoothing — pulls low-sample buckets toward 0.50 so a
// 1-trade fluke doesn't move the weight much.
function smoothedWinRate(nTrades, nWins) {
  return (nWins + PRIOR_TRADES * PRIOR_WIN_RATE) / (nTrades + PRIOR_TRADES);
}

// Win-rate → weight map. 0.50 wr → 1.0; 0% wr → 0.5; 100% wr → 1.5.
function winRateToWeight(wr) {
  return clamp(0.5 + (wr - 0.5) * 2.0 + 0.5, WEIGHT_FLOOR, WEIGHT_CEIL);
}

async function loadCache(force = false) {
  if (!force && Date.now() - _cache.updated < CACHE_TTL_MS && _cache.all) return _cache;
  try {
    const [{ rows: rg }, { rows: rm }] = await Promise.all([
      db.query('SELECT model_id, strategy, regime, market, n_trades, n_wins, win_rate, avg_pnl FROM model_regime_performance'),
      db.query('SELECT model_id, strategy, n_trades, n_wins, win_rate, avg_pnl FROM model_performance'),
    ]);
    const byContext = new Map();   // `${strategy}|${regime}|${market}|${model_id}` -> stats
    const byStrat = new Map();     // `${strategy}|${model_id}` -> stats
    for (const r of rg) {
      const key = `${r.strategy}|${r.regime}|${r.market}|${r.model_id}`;
      byContext.set(key, { n: Number(r.n_trades), w: Number(r.n_wins),
                          wr: Number(r.win_rate), avg_pnl: Number(r.avg_pnl) });
    }
    for (const r of rm) {
      const key = `${r.strategy}|${r.model_id}`;
      byStrat.set(key, { n: Number(r.n_trades), w: Number(r.n_wins),
                         wr: Number(r.win_rate), avg_pnl: Number(r.avg_pnl) });
    }
    _cache = { all: { byContext, byStrat }, updated: Date.now() };
  } catch (e) {
    console.error('[LLMWeights] loadCache failed (using uniform weights):', e.message);
    _cache = { all: { byContext: new Map(), byStrat: new Map() }, updated: Date.now() };
  }
  return _cache;
}

// Public: getWeights({strategy, regime, market}) → { weights: {model_id: w}, sources: {...}, ok }
//
// Resolution order per model:
//   1. (model, strategy, regime, market) bucket if n ≥ MIN_SAMPLES_FULL_TRUST
//   2. Blend of (1) and (model, strategy) when (1) has some data but < trust
//   3. (model, strategy) bucket only if (1) is empty
//   4. Uniform 1.0 if no data anywhere (cold-start)
// Always renormalised so the weight sum equals the model count — keeps the
// downstream weighted vote tally on the same scale as the raw vote tally.
async function getWeights({ strategy, regime, market }) {
  const cache = await loadCache();
  const ctx = cache.all;
  const strat = strategy || 'day';
  const reg = regime?.primary || regime || 'unknown';
  const mkt = market || 'US';
  const out = {};
  const sources = {};
  for (const id of KNOWN_MODELS) {
    const ctxKey = `${strat}|${reg}|${mkt}|${id}`;
    const stratKey = `${strat}|${id}`;
    const ctxStats = ctx.byContext.get(ctxKey);
    const stratStats = ctx.byStrat.get(stratKey);
    let wr, source, n = 0;
    if (ctxStats && ctxStats.n >= MIN_SAMPLES_FULL_TRUST) {
      wr = smoothedWinRate(ctxStats.n, ctxStats.w);
      source = 'context'; n = ctxStats.n;
    } else if (ctxStats && ctxStats.n > 0 && stratStats && stratStats.n > 0) {
      // Blend — weight context by its sample count vs the trust floor.
      const wCtx = ctxStats.n / MIN_SAMPLES_FULL_TRUST;
      const wrCtx = smoothedWinRate(ctxStats.n, ctxStats.w);
      const wrStrat = smoothedWinRate(stratStats.n, stratStats.w);
      wr = wCtx * wrCtx + (1 - wCtx) * wrStrat;
      source = 'blend'; n = ctxStats.n + stratStats.n;
    } else if (stratStats && stratStats.n > 0) {
      wr = smoothedWinRate(stratStats.n, stratStats.w);
      source = 'strategy'; n = stratStats.n;
    } else {
      wr = PRIOR_WIN_RATE;
      source = 'cold-start'; n = 0;
    }
    out[id] = { weight: winRateToWeight(wr), wr, n, source };
    sources[id] = source;
  }
  // Renormalise so Σ weights = number of models — this keeps the weighted
  // vote tally on the same numeric scale as the raw vote count, so safety
  // floors / agreement counts that any code reads downstream don't drift.
  const sum = Object.values(out).reduce((s, x) => s + x.weight, 0);
  const target = KNOWN_MODELS.length;
  if (sum > 0) {
    const k = target / sum;
    for (const id of KNOWN_MODELS) out[id].weight = +(out[id].weight * k).toFixed(3);
  }
  return { ok: true, strategy: strat, regime: reg, market: mkt, weights: out };
}

// Render a compact prompt block — shows each model's current weight + sample
// size + source so every LLM can see how its peers have performed in the
// current context. Keep tight (one line per model).
function renderForPrompt(weightSnap) {
  if (!weightSnap || !weightSnap.ok) return null;
  const { strategy, regime, market, weights } = weightSnap;
  const lines = [];
  lines.push(`Dynamic ensemble weights (strategy=${strategy} · regime=${regime} · market=${market}):`);
  for (const id of KNOWN_MODELS) {
    const w = weights[id];
    if (!w) continue;
    const wrStr = w.n > 0 ? `wr ${(w.wr * 100).toFixed(0)}% on n=${w.n}` : 'cold-start';
    lines.push(`  ${id.padEnd(7)} weight ${w.weight.toFixed(2)} (${wrStr}, src=${w.source})`);
  }
  lines.push('  (informational — weights only TIGHTEN the existing quorum/gate, never relax)');
  return lines.join('\n');
}

// REAL-TIME hook — called from adaptiveLearningService.recordOutcome with
// regime + market resolved from the originating TRADE_EXECUTED audit row.
// Best-effort; never throws; per-model attribution failures swallow silently.
async function recordContextOutcome({ symbol, strategy, regime, market, pnl, models }) {
  try {
    if (!Array.isArray(models) || !models.length) return;
    const reg = regime?.primary || regime || 'unknown';
    const mkt = market || 'US';
    const strat = strategy || 'day';
    const win = pnl > 0 ? 1 : 0;
    const pnlNum = Number(pnl) || 0;
    for (const m of models) {
      if (!m || m.error || m.action !== 'BUY' || !m.model) continue;
      try {
        await db.query(`
          INSERT INTO model_regime_performance
            (model_id, strategy, regime, market, n_trades, n_wins, gross_pnl, win_rate, avg_pnl, updated_at)
          VALUES ($1, $2, $3, $4, 1, $5, $6, $5::float, $6, NOW())
          ON CONFLICT (model_id, strategy, regime, market) DO UPDATE SET
            n_trades  = model_regime_performance.n_trades + 1,
            n_wins    = model_regime_performance.n_wins + $5,
            gross_pnl = model_regime_performance.gross_pnl + $6,
            win_rate  = (model_regime_performance.n_wins + $5)::float
                        / (model_regime_performance.n_trades + 1),
            avg_pnl   = (model_regime_performance.gross_pnl + $6)
                        / (model_regime_performance.n_trades + 1),
            updated_at = NOW()
        `, [m.model, strat, reg, mkt, win, pnlNum]);
      } catch (_) { /* per-row swallow */ }
    }
    // Bust the cache so the very next cycle sees the fresh weights.
    _cache.updated = 0;
  } catch (e) {
    console.error('[LLMWeights] recordContextOutcome failed (swallowed):', e.message);
  }
}

async function getDashboardSummary() {
  await loadCache(true);
  const ctx = _cache.all;
  return {
    contextBuckets: ctx.byContext.size,
    strategyBuckets: ctx.byStrat.size,
    knownModels: KNOWN_MODELS,
    minSamplesFullTrust: MIN_SAMPLES_FULL_TRUST,
    priorTrades: PRIOR_TRADES,
    weightRange: [WEIGHT_FLOOR, WEIGHT_CEIL],
  };
}

module.exports = {
  getWeights, renderForPrompt, recordContextOutcome, getDashboardSummary,
  KNOWN_MODELS, MIN_SAMPLES_FULL_TRUST,
};
