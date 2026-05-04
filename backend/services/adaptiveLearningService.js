// Adaptive learning layer — analyzes the agent's own track record from
// audit_log + trades and feeds it back as (a) a prompt block for the LLMs and
// (b) a position-size multiplier. CRITICALLY: this never relaxes safety. The
// quorum, confidence gate, daily caps, and circuit breaker remain unchanged.
// The size multiplier is clamped to [0.7, 1.2] and is applied AFTER all gates
// inside riskManager.evaluateBuy.
const db = require('./db');

const MIN_SAMPLES_FOR_TRUST = 5;          // need ≥5 closed trades before nudging size
const MULT_FLOOR = 0.70;
const MULT_CEILING = 1.20;

let _cache = { perfBySymbolStrategy: new Map(), perfByModelStrategy: new Map(), updated: 0 };

// Pull all closed trades (with a non-null pnl) joined with the SIGNAL audit row
// that produced them so we can attribute outcomes to (a) per-model votes and
// (b) per-symbol+strategy track record. We pair on symbol + nearest preceding
// SIGNAL within 10 minutes of the executed BUY.
async function recomputeFromHistory() {
  // Only consider sells/closes that booked a P&L (the BUY rows have pnl=null).
  const { rows: closes } = await db.query(`
    SELECT t.id, t.symbol, t.strategy, t.created_at, t.pnl
    FROM trades t
    WHERE t.pnl IS NOT NULL AND t.side = 'SELL'
    ORDER BY t.created_at DESC
    LIMIT 2000
  `);

  // Per (symbol, strategy) bucket
  const symStrat = new Map();      // key="SYM|strat" → {n, w, pnl}
  const modelStrat = new Map();    // key="model|strat" → {n, w, pnl}

  for (const c of closes) {
    const pnl = parseFloat(c.pnl);
    if (!Number.isFinite(pnl)) continue;
    const strat = c.strategy || 'day';
    const win = pnl > 0 ? 1 : 0;

    // (symbol, strategy)
    const k1 = `${c.symbol}|${strat}`;
    const a = symStrat.get(k1) || { n: 0, w: 0, pnl: 0 };
    a.n += 1; a.w += win; a.pnl += pnl;
    symStrat.set(k1, a);

    // Find the originating SIGNAL audit row to credit per-model performance.
    // We look back up to 24h for safety; the matching BUY happened minutes
    // after the SIGNAL, and the SELL closed it later (could be hours/days).
    const { rows: sig } = await db.query(`
      SELECT models FROM audit_log
      WHERE event_type = 'SIGNAL' AND symbol = $1
        AND decision = 'BUY' AND created_at <= $2
        AND created_at >= $2 - INTERVAL '7 days'
        AND payload->>'strategy' = $3
      ORDER BY created_at DESC
      LIMIT 1
    `, [c.symbol, c.created_at, strat]);

    const models = sig[0]?.models || [];
    for (const m of models) {
      if (!m || m.error || m.action !== 'BUY') continue;
      const k2 = `${m.model}|${strat}`;
      const b = modelStrat.get(k2) || { n: 0, w: 0, pnl: 0 };
      b.n += 1; b.w += win; b.pnl += pnl;
      modelStrat.set(k2, b);
    }
  }

  // Persist. Both tables are tiny (≤200 rows total) — full upserts each pass.
  await db.query('BEGIN');
  try {
    for (const [key, v] of symStrat) {
      const [symbol, strategy] = key.split('|');
      await db.query(`
        INSERT INTO symbol_strategy_performance (symbol, strategy, n_trades, n_wins, win_rate, avg_pnl, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6, NOW())
        ON CONFLICT (symbol, strategy) DO UPDATE SET
          n_trades = EXCLUDED.n_trades,
          n_wins   = EXCLUDED.n_wins,
          win_rate = EXCLUDED.win_rate,
          avg_pnl  = EXCLUDED.avg_pnl,
          updated_at = NOW()
      `, [symbol, strategy, v.n, v.w, v.n ? v.w / v.n : 0, v.n ? v.pnl / v.n : 0]);
    }
    for (const [key, v] of modelStrat) {
      const [model_id, strategy] = key.split('|');
      await db.query(`
        INSERT INTO model_performance (model_id, strategy, n_trades, n_wins, gross_pnl, win_rate, avg_pnl, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
        ON CONFLICT (model_id, strategy) DO UPDATE SET
          n_trades = EXCLUDED.n_trades,
          n_wins   = EXCLUDED.n_wins,
          gross_pnl = EXCLUDED.gross_pnl,
          win_rate = EXCLUDED.win_rate,
          avg_pnl  = EXCLUDED.avg_pnl,
          updated_at = NOW()
      `, [model_id, strategy, v.n, v.w, v.pnl, v.n ? v.w / v.n : 0, v.n ? v.pnl / v.n : 0]);
    }
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  // Refresh in-memory cache
  _cache = {
    perfBySymbolStrategy: symStrat,
    perfByModelStrategy: modelStrat,
    updated: Date.now(),
  };
  return { symbolBuckets: symStrat.size, modelBuckets: modelStrat.size, sourceCloses: closes.length };
}

async function loadCache() {
  if (Date.now() - _cache.updated < 60_000 && _cache.perfBySymbolStrategy.size) return;
  try {
    const ss = await db.query('SELECT * FROM symbol_strategy_performance');
    const ms = await db.query('SELECT * FROM model_performance');
    const a = new Map(), b = new Map();
    for (const r of ss.rows) a.set(`${r.symbol}|${r.strategy}`, {
      n: Number(r.n_trades), w: Number(r.n_wins), pnl: Number(r.avg_pnl) * Number(r.n_trades),
      win_rate: Number(r.win_rate), avg_pnl: Number(r.avg_pnl),
    });
    for (const r of ms.rows) b.set(`${r.model_id}|${r.strategy}`, {
      n: Number(r.n_trades), w: Number(r.n_wins), pnl: Number(r.gross_pnl),
      win_rate: Number(r.win_rate), avg_pnl: Number(r.avg_pnl),
    });
    _cache = { perfBySymbolStrategy: a, perfByModelStrategy: b, updated: Date.now() };
  } catch (e) {
    // Schema not ensured yet — silently no-op (size mult=1.0, no prompt block).
  }
}

// Returns a clamped multiplier in [0.7, 1.2]. Pure size adjustment, never a gate.
async function getSizingMultiplier(symbol, strategy) {
  await loadCache();
  const v = _cache.perfBySymbolStrategy.get(`${symbol}|${strategy}`);
  if (!v || v.n < MIN_SAMPLES_FOR_TRUST) return 1.0;
  // Map win_rate centered at 50% to a multiplier.
  // 30% wr → 0.70, 50% wr → 1.00, 70%+ wr → 1.20
  const raw = 1.0 + (v.win_rate - 0.5) * 1.0;
  return +Math.max(MULT_FLOOR, Math.min(MULT_CEILING, raw)).toFixed(3);
}

// Compact track-record block injected into the LLM prompt (informational).
async function getCalibrationHints(symbol, strategy) {
  await loadCache();
  const v = _cache.perfBySymbolStrategy.get(`${symbol}|${strategy}`);
  const lines = [];
  if (v && v.n >= MIN_SAMPLES_FOR_TRUST) {
    const wr = (v.win_rate * 100).toFixed(0);
    const ap = v.avg_pnl >= 0 ? `+$${v.avg_pnl.toFixed(2)}` : `-$${Math.abs(v.avg_pnl).toFixed(2)}`;
    lines.push(`Self-track record on ${symbol} (${strategy}): ${v.n} closed trades, win rate ${wr}%, avg P&L ${ap}/trade.`);
  } else if (v) {
    lines.push(`Self-track record on ${symbol} (${strategy}): only ${v.n} closed trade(s) — too few to weight, evaluate on merits.`);
  } else {
    lines.push(`Self-track record on ${symbol} (${strategy}): no closed trades yet on this name + strategy.`);
  }

  // Per-model summary for this strategy (any symbol).
  const perModel = [];
  for (const [k, v] of _cache.perfByModelStrategy) {
    const [mid, st] = k.split('|');
    if (st !== strategy) continue;
    if (v.n < MIN_SAMPLES_FOR_TRUST) continue;
    perModel.push(`${mid} ${(v.win_rate * 100).toFixed(0)}%`);
  }
  if (perModel.length) lines.push(`Model win rates (${strategy}, this agent): ${perModel.join(' · ')}.`);
  return lines.length ? `Adaptive learning (your own track record):\n  ${lines.join('\n  ')}` : null;
}

async function getDashboardSummary() {
  await loadCache();
  const symbols = [];
  for (const [k, v] of _cache.perfBySymbolStrategy) {
    const [symbol, strategy] = k.split('|');
    symbols.push({ symbol, strategy, n: v.n, win_rate: v.win_rate, avg_pnl: v.avg_pnl });
  }
  const models = [];
  for (const [k, v] of _cache.perfByModelStrategy) {
    const [model_id, strategy] = k.split('|');
    models.push({ model_id, strategy, n: v.n, win_rate: v.win_rate, avg_pnl: v.avg_pnl });
  }
  return {
    updated_at: _cache.updated ? new Date(_cache.updated).toISOString() : null,
    symbols: symbols.sort((a, b) => b.n - a.n).slice(0, 50),
    models: models.sort((a, b) => b.n - a.n),
  };
}

module.exports = { recomputeFromHistory, getSizingMultiplier, getCalibrationHints, getDashboardSummary };
