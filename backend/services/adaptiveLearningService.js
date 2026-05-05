// Adaptive learning layer — analyzes the agent's own track record from
// audit_log + trades and feeds it back as (a) a prompt block for the LLMs and
// (b) a position-size multiplier. CRITICALLY: this never relaxes safety. The
// quorum, confidence gate, daily caps, and circuit breaker remain unchanged.
// The size multiplier is clamped to [0.7, 1.2] and is applied AFTER all gates
// inside riskManager.evaluateBuy.
const db = require('./db');
const llmWeighting = require('./llmWeightingService');

const MIN_SAMPLES_FOR_TRUST = 5;          // need ≥5 closed trades before nudging size
const MULT_FLOOR = 0.70;
const MULT_CEILING = 1.20;
const RECENT_WINDOW = 30;                  // rolling buffer per (symbol,strategy)
const RECENT_MIN_FOR_BLEND = 4;            // need ≥4 recent samples to tilt sizing
const RECENT_BLEND_WEIGHT = 0.35;          // 35% recent, 65% all-time

let _cache = { perfBySymbolStrategy: new Map(), perfByModelStrategy: new Map(), updated: 0 };
// In-memory rolling window of last RECENT_WINDOW closed-trade pnls per
// (symbol|strategy). Updated synchronously on every close so the very next
// LLM cycle sees the new data point. Lost on restart — re-warmed on demand.
const _recent = new Map();

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

function recentStats(symbol, strategy) {
  const arr = _recent.get(`${symbol}|${strategy}`) || [];
  if (!arr.length) return null;
  const wins = arr.filter(x => x.pnl > 0).length;
  const sumPnl = arr.reduce((s, x) => s + x.pnl, 0);
  // Last 5 — short-term streak signal for the LLM hint.
  const last5 = arr.slice(-5);
  const last5Wins = last5.filter(x => x.pnl > 0).length;
  return {
    n: arr.length,
    win_rate: wins / arr.length,
    avg_pnl: sumPnl / arr.length,
    last5: last5.map(x => x.pnl > 0 ? 'W' : 'L').join(''),
    last5_wr: last5.length ? last5Wins / last5.length : null,
  };
}

// Returns a clamped multiplier in [0.7, 1.2]. Pure size adjustment, never a gate.
// Real-time aware: blends all-time win rate with the in-memory rolling window
// so the very next decision after a close already reflects the new outcome.
async function getSizingMultiplier(symbol, strategy) {
  await loadCache();
  const allTime = _cache.perfBySymbolStrategy.get(`${symbol}|${strategy}`);
  const recent = recentStats(symbol, strategy);
  // Need at least one trustworthy source.
  const haveAllTime = allTime && allTime.n >= MIN_SAMPLES_FOR_TRUST;
  const haveRecent = recent && recent.n >= RECENT_MIN_FOR_BLEND;
  if (!haveAllTime && !haveRecent) return 1.0;

  let blendedWr;
  if (haveAllTime && haveRecent) {
    blendedWr = (1 - RECENT_BLEND_WEIGHT) * allTime.win_rate + RECENT_BLEND_WEIGHT * recent.win_rate;
  } else if (haveAllTime) {
    blendedWr = allTime.win_rate;
  } else {
    // Recent-only: be a bit more conservative — pull halfway toward neutral.
    blendedWr = 0.5 + 0.5 * (recent.win_rate - 0.5);
  }
  // Map win_rate centered at 50% to a multiplier.
  // 30% wr → 0.70, 50% wr → 1.00, 70%+ wr → 1.20
  const raw = 1.0 + (blendedWr - 0.5) * 1.0;
  return +Math.max(MULT_FLOOR, Math.min(MULT_CEILING, raw)).toFixed(3);
}

// Compact track-record block injected into the LLM prompt (informational).
async function getCalibrationHints(symbol, strategy) {
  await loadCache();
  const v = _cache.perfBySymbolStrategy.get(`${symbol}|${strategy}`);
  const recent = recentStats(symbol, strategy);
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
  if (recent && recent.n >= 2) {
    const rwr = (recent.win_rate * 100).toFixed(0);
    const ap = recent.avg_pnl >= 0 ? `+$${recent.avg_pnl.toFixed(2)}` : `-$${Math.abs(recent.avg_pnl).toFixed(2)}`;
    const last5 = recent.last5 ? ` (last5=${recent.last5})` : '';
    lines.push(`Recent on ${symbol}: last ${recent.n} closes — ${rwr}% win, avg ${ap}${last5}.`);
    if (recent.last5_wr != null && recent.n >= 3) {
      if (recent.last5_wr >= 0.8) lines.push(`Hot streak — your recent setups on ${symbol} have been working; weight a constructive setup slightly higher, but the confidence gate still rules.`);
      else if (recent.last5_wr <= 0.2) lines.push(`Cold streak — your recent setups on ${symbol} have been losing; demand a clearly cleaner setup before BUY.`);
    }
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

// ---------------------------------------------------------------------------
// REAL-TIME hook — call once for every closed trade (non-null pnl SELL),
// including stop-loss SELLs and force-flatten SELLs. Updates:
//   1. In-memory rolling window (immediate effect on next LLM cycle).
//   2. symbol_strategy_performance row (incremental upsert).
//   3. model_performance rows for each model that voted BUY on the originating
//      SIGNAL (best-effort lookup; silent no-op if no SIGNAL row found).
// CRITICAL: never throws. Failures are logged and swallowed so a learning
// hiccup can never block trade execution or the trading cycle.
// ---------------------------------------------------------------------------
async function recordOutcome({ symbol, strategy, pnl, closedAt }) {
  try {
    if (!symbol || !strategy || !Number.isFinite(parseFloat(pnl))) return;
    const sym = String(symbol).toUpperCase();
    const strat = String(strategy);
    const pnlNum = parseFloat(pnl);
    const ts = closedAt ? new Date(closedAt) : new Date();
    const win = pnlNum > 0 ? 1 : 0;

    // 1. Push to in-memory rolling window (cap at RECENT_WINDOW).
    const key = `${sym}|${strat}`;
    const arr = _recent.get(key) || [];
    arr.push({ pnl: pnlNum, ts: ts.getTime() });
    if (arr.length > RECENT_WINDOW) arr.splice(0, arr.length - RECENT_WINDOW);
    _recent.set(key, arr);

    // 2. ATOMIC incremental upsert. Postgres computes the new totals from the
    //    live row (not from a stale cached read), so concurrent SELLs cannot
    //    lose updates. RETURNING gives us the post-write truth which we then
    //    mirror into the in-memory cache.
    const { rows: [updated] } = await db.query(`
      INSERT INTO symbol_strategy_performance (symbol, strategy, n_trades, n_wins, win_rate, avg_pnl, updated_at)
      VALUES ($1, $2, 1, $3, $3::float, $4, NOW())
      ON CONFLICT (symbol, strategy) DO UPDATE SET
        n_trades = symbol_strategy_performance.n_trades + 1,
        n_wins   = symbol_strategy_performance.n_wins + $3,
        win_rate = (symbol_strategy_performance.n_wins + $3)::float
                   / (symbol_strategy_performance.n_trades + 1),
        avg_pnl  = ((symbol_strategy_performance.avg_pnl * symbol_strategy_performance.n_trades) + $4)
                   / (symbol_strategy_performance.n_trades + 1),
        updated_at = NOW()
      RETURNING n_trades, n_wins, win_rate, avg_pnl
    `, [sym, strat, win, pnlNum]);

    // Mirror DB truth into in-memory cache (no read-modify-write — values
    // come straight from RETURNING so concurrent writers can't desync).
    await loadCache();
    const nTrades = Number(updated.n_trades);
    const nWins = Number(updated.n_wins);
    const winRate = Number(updated.win_rate);
    const avgPnl = Number(updated.avg_pnl);
    _cache.perfBySymbolStrategy.set(key, {
      n: nTrades, w: nWins, pnl: avgPnl * nTrades,
      win_rate: winRate, avg_pnl: avgPnl,
    });
    _cache.updated = Date.now();

    // 3. Per-model attribution — look up the actually-executed opening BUY
    //    (TRADE_EXECUTED audit, NOT SIGNAL — SIGNAL rows can exist for BUYs
    //    that were later rejected by the risk gate). Best-effort; silent if
    //    no row found. The TRADE_EXECUTED audit row already carries the
    //    voting models in its `models` column AND the regime + market keys
    //    we need for the dynamic-weighting context bucket.
    try {
      const { rows: sig } = await db.query(`
        SELECT models, payload FROM audit_log
        WHERE event_type = 'TRADE_EXECUTED' AND symbol = $1
          AND decision = 'BUY' AND created_at <= $2
          AND created_at >= $2 - INTERVAL '14 days'
          AND payload->>'strategy' = $3
        ORDER BY created_at DESC
        LIMIT 1
      `, [sym, ts.toISOString(), strat]);
      const models = sig[0]?.models || [];
      // Feed the dynamic-weighting layer with regime + market resolved from
      // the originating BUY audit. Best-effort; never blocks the rest of
      // attribution.
      try {
        const regime = sig[0]?.payload?.regime || null;
        const market = sig[0]?.payload?.market || 'US';
        await llmWeighting.recordContextOutcome({
          symbol: sym, strategy: strat, regime, market, pnl: pnlNum, models,
        });
      } catch (_) { /* swallow */ }
      for (const m of models) {
        if (!m || m.error || m.action !== 'BUY' || !m.model) continue;
        const mkey = `${m.model}|${strat}`;
        const { rows: [mu] } = await db.query(`
          INSERT INTO model_performance (model_id, strategy, n_trades, n_wins, gross_pnl, win_rate, avg_pnl, updated_at)
          VALUES ($1, $2, 1, $3, $4, $3::float, $4, NOW())
          ON CONFLICT (model_id, strategy) DO UPDATE SET
            n_trades  = model_performance.n_trades + 1,
            n_wins    = model_performance.n_wins + $3,
            gross_pnl = model_performance.gross_pnl + $4,
            win_rate  = (model_performance.n_wins + $3)::float
                        / (model_performance.n_trades + 1),
            avg_pnl   = (model_performance.gross_pnl + $4)
                        / (model_performance.n_trades + 1),
            updated_at = NOW()
          RETURNING n_trades, n_wins, gross_pnl, win_rate, avg_pnl
        `, [m.model, strat, win, pnlNum]);
        _cache.perfByModelStrategy.set(mkey, {
          n: Number(mu.n_trades), w: Number(mu.n_wins), pnl: Number(mu.gross_pnl),
          win_rate: Number(mu.win_rate), avg_pnl: Number(mu.avg_pnl),
        });
      }
    } catch (e) {
      // Per-model attribution is best-effort — never fails the outcome record.
      console.warn(`[Adaptive] per-model attribution failed for ${sym}: ${e.message}`);
    }

    console.log(`[Adaptive] +outcome ${sym}/${strat} pnl=${pnlNum.toFixed(2)} → n=${nTrades} wr=${(winRate * 100).toFixed(0)}% recent=${arr.length}`);
  } catch (e) {
    // CRITICAL: swallow everything — adaptive learning must never break trading.
    console.error('[Adaptive] recordOutcome failed (swallowed):', e.message);
  }
}

module.exports = { recomputeFromHistory, getSizingMultiplier, getCalibrationHints, getDashboardSummary, recordOutcome };
