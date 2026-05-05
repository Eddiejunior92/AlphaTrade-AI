// Regime-aware meta-learning layer.
//
// Tracks closed-trade performance per (regime, strategy) and produces a
// regime-conditional adjustment that can ONLY tighten the existing safety
// envelope, never relax it:
//
//   • confidenceBoost ≥ 0   — added to the strategy's confidenceThreshold
//                             inside riskManager.checkQuorum.  Pure
//                             tightening — a regime that has historically
//                             lost demands cleaner setups before a BUY.
//   • regimeMult ∈ [0.85, 1.10]
//                            — sizing nudge clamped tighter on the upside
//                              than on the downside, so bad regimes shrink
//                              size faster than good ones grow it.
//
// SAFETY:
//   • Confidence-boost is non-negative. The base strategy threshold (0.75 /
//     0.80 / 0.85) is the FLOOR; meta layer can only push it higher.
//   • Quorum (minDirectionalAgreement), daily loss budget, drawdown circuit
//     breaker, position cap, max-holdings, and "no averaging-in" all run
//     unchanged — they retain full veto power over anything this layer says.
//   • Until n_trades_in_regime ≥ MIN_SAMPLES, returns neutral (boost=0,
//     mult=1.0). Cold-start = identity.
//   • All public methods swallow errors — never break trading.

const db = require('./db');
const { ALL_REGIMES } = require('./regimeService');

const MIN_SAMPLES   = parseInt(process.env.META_MIN_SAMPLES || '8');
const MAX_BOOST     = 0.10;     // max additive nudge to confidence threshold
const MULT_FLOOR    = 0.85;
const MULT_CEILING  = 1.10;     // asymmetric — easier to shrink than to grow

let _cache = { byKey: new Map(), updated: 0 };

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS regime_performance (
      regime     TEXT NOT NULL,
      strategy   TEXT NOT NULL,
      n_trades   INTEGER NOT NULL DEFAULT 0,
      n_wins     INTEGER NOT NULL DEFAULT 0,
      gross_pnl  NUMERIC(14,4) NOT NULL DEFAULT 0,
      sum_r      NUMERIC(10,4) NOT NULL DEFAULT 0,
      n_with_r   INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (regime, strategy)
    )
  `);
}

async function loadCache() {
  if (Date.now() - _cache.updated < 30_000 && _cache.byKey.size) return;
  try {
    await ensureSchema();
    const { rows } = await db.query(`SELECT * FROM regime_performance`);
    const m = new Map();
    for (const r of rows) {
      const n = Number(r.n_trades);
      const nWithR = Number(r.n_with_r);
      m.set(`${r.regime}|${r.strategy}`, {
        n, w: Number(r.n_wins), pnl: Number(r.gross_pnl),
        win_rate: n ? Number(r.n_wins) / n : 0,
        avg_pnl: n ? Number(r.gross_pnl) / n : 0,
        avg_r: nWithR ? Number(r.sum_r) / nWithR : 0,
        n_with_r: nWithR,
      });
    }
    _cache = { byKey: m, updated: Date.now() };
  } catch (e) {
    console.warn('[Meta] loadCache failed:', e.message);
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Compute the per-regime adjustments the agent should apply.
// Returns { confidenceBoost, regimeMult, basis } — where basis is the
// (n, win_rate, avg_r) the decision was made on, for logging/audit.
async function getAdjustments(regime, strategy) {
  await loadCache();
  const primary = regime?.primary || 'normal';
  const stat = _cache.byKey.get(`${primary}|${strategy}`);
  const neutral = {
    regime: primary, confidenceBoost: 0, regimeMult: 1.0,
    basis: { n: stat?.n || 0, win_rate: stat?.win_rate ?? null, avg_r: stat?.avg_r ?? null, samples_needed: MIN_SAMPLES },
  };
  if (!stat || stat.n < MIN_SAMPLES) return neutral;

  // --- Confidence boost (non-negative). Worse regimes demand cleaner setups.
  // ≤45% wr → +10pp;  45–50% → +5pp;  50–55% → +2pp;  ≥55% → 0.
  let boost = 0;
  if (stat.win_rate <= 0.45)      boost = MAX_BOOST;
  else if (stat.win_rate <= 0.50) boost = 0.05;
  else if (stat.win_rate <= 0.55) boost = 0.02;
  else                             boost = 0;

  // --- Sizing multiplier from average R-multiple in this regime.
  // Map avg_r ∈ [-1, +1] → mult ∈ [0.85, 1.10]; clamped at source.
  // Half-saturation: every 0.25R of edge changes size by ~5%.
  const rawMult = 1 + 0.20 * (stat.avg_r || 0);     // 0.20 controls aggression
  const regimeMult = +clamp(rawMult, MULT_FLOOR, MULT_CEILING).toFixed(4);

  return {
    regime: primary, confidenceBoost: +boost.toFixed(3), regimeMult,
    basis: { n: stat.n, win_rate: +stat.win_rate.toFixed(3), avg_r: +stat.avg_r.toFixed(3), samples_needed: MIN_SAMPLES },
  };
}

// Online update on every closed trade. pnl is in USD; riskUSD is the per-
// trade $-risk used so we can compute realised R-multiple. Both are the same
// values fed to mlAdaptiveService.recordOutcome — keeps the two layers
// learning from a consistent ledger.
async function recordOutcome({ regime, strategy, pnl, riskUSD }) {
  try {
    const primary = regime?.primary || 'normal';
    const pnlNum = Number(pnl);
    if (!Number.isFinite(pnlNum) || !strategy) return;
    const win = pnlNum > 0 ? 1 : 0;
    const risk = Number(riskUSD);
    const hasR = Number.isFinite(risk) && risk > 0;
    const rMult = hasR ? clamp(pnlNum / risk, -3, 3) : 0;

    await ensureSchema();
    const { rows: [u] } = await db.query(`
      INSERT INTO regime_performance (regime, strategy, n_trades, n_wins, gross_pnl, sum_r, n_with_r, updated_at)
      VALUES ($1, $2, 1, $3, $4, $5, $6, NOW())
      ON CONFLICT (regime, strategy) DO UPDATE SET
        n_trades   = regime_performance.n_trades + 1,
        n_wins     = regime_performance.n_wins + $3,
        gross_pnl  = regime_performance.gross_pnl + $4,
        sum_r      = regime_performance.sum_r + $5,
        n_with_r   = regime_performance.n_with_r + $6,
        updated_at = NOW()
      RETURNING n_trades, n_wins, gross_pnl, sum_r, n_with_r
    `, [primary, strategy, win, pnlNum, hasR ? rMult : 0, hasR ? 1 : 0]);

    // Mirror DB truth into the in-memory cache so the very next decision
    // sees the new sample without waiting for the 30s reload window.
    const n = Number(u.n_trades), w = Number(u.n_wins), pnlSum = Number(u.gross_pnl);
    const nWithR = Number(u.n_with_r), sumR = Number(u.sum_r);
    _cache.byKey.set(`${primary}|${strategy}`, {
      n, w, pnl: pnlSum,
      win_rate: n ? w / n : 0,
      avg_pnl: n ? pnlSum / n : 0,
      avg_r: nWithR ? sumR / nWithR : 0,
      n_with_r: nWithR,
    });
    _cache.updated = Date.now();
    if (n === MIN_SAMPLES || n % 10 === 0) {
      console.log(`[Meta] +${primary}/${strategy} n=${n} wr=${(w / n * 100).toFixed(0)}% avgR=${nWithR ? (sumR / nWithR).toFixed(2) : 'n/a'}`);
    }
  } catch (e) {
    console.error('[Meta] recordOutcome failed (swallowed):', e.message);
  }
}

async function getDashboardSummary() {
  await loadCache();
  const out = [];
  // Always emit a row per regime per strategy so the UI can render an empty
  // grid before any trades have closed in that bucket.
  for (const strategy of ['day', 'swing']) {
    for (const regime of ALL_REGIMES) {
      const v = _cache.byKey.get(`${regime}|${strategy}`);
      out.push({
        regime, strategy,
        n: v?.n || 0,
        win_rate: v?.win_rate ?? null,
        avg_pnl: v?.avg_pnl ?? null,
        avg_r: v?.avg_r ?? null,
        n_with_r: v?.n_with_r || 0,
      });
    }
  }
  return {
    updated_at: _cache.updated ? new Date(_cache.updated).toISOString() : null,
    min_samples: MIN_SAMPLES,
    boost_max: MAX_BOOST,
    mult_band: [MULT_FLOOR, MULT_CEILING],
    rows: out,
  };
}

module.exports = { ensureSchema, loadCache, getAdjustments, recordOutcome, getDashboardSummary, MIN_SAMPLES };
