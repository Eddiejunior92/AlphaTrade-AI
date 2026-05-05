// Reinforcement learning layer for execution & position management.
//
// What it does
// ------------
// During every cycle, for every open position, this service looks at the
// current market regime, the holding's unrealised P&L, and how far above the
// entry price it has travelled, and picks one of a small set of EXECUTION
// adjustments that are then applied to the trailing-stop / partial-profit
// computation. When the position closes, the realised R-multiple is fed back
// as the reward and we update the Q-table for every decision recorded along
// the way (Monte Carlo return — terminal-reward credit assignment).
//
// Why tabular Q-learning (and not deep RL)
// ---------------------------------------
// Trade volume is small (tens to low hundreds per week). A discretised state
// space (~5 × 3 × 5 × 5 = 375 cells) × 5 actions fits easily in Postgres,
// converges with very few samples, is fully introspectable from a dashboard,
// and has zero new heavy dependencies.
//
// State features (compact, discretised — every feature is a known input)
//   • regime         — from regimeService (5 buckets)
//   • strategy       — day / swing / asx_swing
//   • mfe_bucket     — max-favourable-excursion since entry, in %
//                      buckets: <0, 0–1, 1–3, 3–5, >5
//   • pnl_bucket     — current unrealised P&L %
//                      buckets: <-1, -1–0, 0–1, 1–3, >3
//
// Action set (intentionally tight — every action keeps existing safety rails)
//   • NONE          — use strategy defaults
//   • TIGHTEN       — trail × 0.7              (shrink room, lock profits faster)
//   • LOOSEN        — trail × 1.4              (give a clear winner more room)
//   • ARM_EARLY     — activate × 0.5           (start trailing closer to entry)
//   • LOCK_IN       — trail = 0.7%, activate = immediate
//                     (only takes effect once in profit; behaves like a
//                      partial-profit lock without introducing a new SELL path)
//
// Critically, the existing trailing-stop ratchet (in riskManager.computeTrailingUpdate)
// only EVER moves the stop UP. So even the "LOOSEN" action cannot weaken an
// already-armed stop — it can only widen the trail anchor for FUTURE peaks.
// The hard stop loss, daily loss budget, % drawdown circuit breaker, kill
// switch, quorum gate, and confidence gate are not touched by this layer.
//
// Reward
// ------
// Realised R-multiple = pnlUSD / riskUSD, clipped to ±3. Same scale ML adaptive
// uses, so units are comparable.
//
// Persistence
// -----------
//   • rl_q_table(state, action, q_value, n_visits, last_updated)  — PK (state, action)
//   • Per-decision log goes into the existing audit_log under
//     event_type='RL_EXEC_DECISION' so we can replay decisions per trade
//     without inventing a new table.

const db = require('./db');

const ACTIONS = ['NONE', 'TIGHTEN', 'LOOSEN', 'ARM_EARLY', 'LOCK_IN'];

const ALPHA = 0.20;          // learning rate
const EPSILON_BASE = 0.10;   // baseline exploration rate
const EPSILON_FLOOR = 0.02;  // floor exploration once well-trained
const EPSILON_DECAY_AT = 200; // decay schedule anchor (n_visits)

// Bounded multipliers. Even with the worst possible action choice, the trail
// pct cannot drift outside these bounds vs the strategy default.
const TRAIL_MULT_MIN = 0.5;
const TRAIL_MULT_MAX = 1.5;

// Hard floor on the LOCK_IN action's trail pct so a misbehaving Q-table can
// never reduce the trail below this.
const LOCK_IN_TRAIL_PCT = 0.007;
// Tiny but truthy arm pct so the riskManager's `if (!armPct) return null`
// guard passes — at any positive unrealised P&L the trail will arm
// immediately. (A literal 0 reads as falsy and would silently disable
// trailing entirely.)
const LOCK_IN_ARM_PCT   = 0.0001;

// Per (symbol, strategy) memo of the last RL decision we audit-logged. We
// write a new RL_EXEC_DECISION row whenever the action OR the state changes,
// or after AUDIT_RELOG_CYCLES skips with no change. Including state in the
// change-detector means every distinct (state, action) pair traversed during
// a holding gets at least one audit row → reward attribution stays unbiased.
// Memo is bounded to AUDIT_MEMO_MAX entries with FIFO eviction so a long-
// running process can't leak unbounded memory across symbol/strategy churn.
const _lastAudit = new Map();
const AUDIT_RELOG_CYCLES = 10;
const AUDIT_MEMO_MAX = 500;
function clearAuditMemo(symbol, strategy) {
  _lastAudit.delete(`${symbol}|${strategy}`);
}

let _cache = null;          // Map<state|action, {q,n}>
let _loadedAt = 0;

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rl_q_table (
      state         TEXT NOT NULL,
      action        TEXT NOT NULL,
      q_value       DOUBLE PRECISION NOT NULL DEFAULT 0,
      n_visits      INTEGER NOT NULL DEFAULT 0,
      last_updated  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (state, action)
    )
  `);
}

async function loadCache(force = false) {
  if (!force && _cache && Date.now() - _loadedAt < 60_000) return _cache;
  await ensureSchema();
  const { rows } = await db.query(`SELECT state, action, q_value, n_visits FROM rl_q_table`);
  const map = new Map();
  for (const r of rows) map.set(`${r.state}|${r.action}`, { q: +r.q_value, n: +r.n_visits });
  _cache = map; _loadedAt = Date.now();
  return _cache;
}

// ---------------------------------------------------------------------------
// State discretisation. Every input is best-effort: missing values fall back
// to safe defaults so a partial cache miss never blocks a recommendation.
function bucketMfe(pct) {
  if (!Number.isFinite(pct)) return 'na';
  if (pct < 0) return 'neg';
  if (pct < 1) return 'lo';
  if (pct < 3) return 'mid';
  if (pct < 5) return 'hi';
  return 'xhi';
}
function bucketPnl(pct) {
  if (!Number.isFinite(pct)) return 'na';
  if (pct < -1) return 'down';
  if (pct < 0)  return 'red';
  if (pct < 1)  return 'flat';
  if (pct < 3)  return 'up';
  return 'big';
}
function buildStateKey({ regime, strategy, mfePct, pnlPct }) {
  return `${regime || 'normal'}|${strategy || 'unknown'}|mfe:${bucketMfe(mfePct)}|pnl:${bucketPnl(pnlPct)}`;
}

function epsilonFor(totalVisits) {
  if (totalVisits >= EPSILON_DECAY_AT) return EPSILON_FLOOR;
  const t = totalVisits / EPSILON_DECAY_AT;
  return EPSILON_BASE * (1 - t) + EPSILON_FLOOR * t;
}

// Pick action by ε-greedy. When the table has no data for this state we fall
// back to NONE — the strategy default — which is the safe no-op.
function pickAction(cache, state) {
  const visits = ACTIONS.map(a => cache.get(`${state}|${a}`)?.n || 0);
  const totalN = visits.reduce((s, v) => s + v, 0);
  const eps = epsilonFor(totalN);
  if (totalN === 0 || Math.random() < eps) {
    return { action: ACTIONS[Math.floor(Math.random() * ACTIONS.length)], explore: true, eps, totalN };
  }
  let bestA = 'NONE', bestQ = -Infinity;
  for (const a of ACTIONS) {
    const q = cache.get(`${state}|${a}`)?.q ?? 0;
    if (q > bestQ) { bestQ = q; bestA = a; }
  }
  return { action: bestA, explore: false, eps, totalN, q: bestQ };
}

// ---------------------------------------------------------------------------
// Translate an action into a bounded adjustment to the strategy's trailing
// config. Hard min/max clamps make this safe regardless of Q-table state.
function applyAction(action, strategyConfig) {
  const baseTrail = Number(strategyConfig?.trailingStopPct) || 0;
  const baseArm   = Number(strategyConfig?.trailingActivatePct) || 0;
  if (!baseTrail || !baseArm) return null; // strategy doesn't trail (e.g. day)

  let trailMult = 1, armMult = 1;
  let lockIn = false;
  switch (action) {
    case 'TIGHTEN':   trailMult = 0.7; break;
    case 'LOOSEN':    trailMult = 1.4; break;
    case 'ARM_EARLY': armMult   = 0.5; break;
    case 'LOCK_IN':   lockIn = true; break;
    case 'NONE':
    default:          break;
  }
  trailMult = Math.max(TRAIL_MULT_MIN, Math.min(TRAIL_MULT_MAX, trailMult));
  armMult   = Math.max(TRAIL_MULT_MIN, Math.min(TRAIL_MULT_MAX, armMult));

  const trail = lockIn ? LOCK_IN_TRAIL_PCT : baseTrail * trailMult;
  const arm   = lockIn ? LOCK_IN_ARM_PCT   : baseArm   * armMult;

  return {
    ...strategyConfig,
    trailingStopPct: +trail.toFixed(5),
    trailingActivatePct: +arm.toFixed(5),
    _rl: { action, trailMult, armMult, lockIn,
           baseTrail, baseArm,
           appliedTrail: +trail.toFixed(5), appliedArm: +arm.toFixed(5) },
  };
}

// ---------------------------------------------------------------------------
// Public: per-position recommendation. Returns the (possibly-modified) config
// to feed into computeTrailingUpdate, plus a state record we audit so the
// close-time learner can credit the right (state, action) cells.
//
// Failures swallow into a safe NONE recommendation — RL must never break
// trading. Every code path returns a usable strategyConfig.
async function recommendForHolding({ holding, currentPrice, regime, strategyConfig }) {
  try {
    if (!strategyConfig?.trailingStopPct || !strategyConfig?.trailingActivatePct) {
      return { action: 'NONE', adjustedConfig: strategyConfig, state: null };
    }
    const entry = parseFloat(holding?.avg_cost) || 0;
    if (!entry || !currentPrice) {
      return { action: 'NONE', adjustedConfig: strategyConfig, state: null };
    }
    const pnlPct = ((currentPrice - entry) / entry) * 100;
    const peak = Math.max(parseFloat(holding?.highest_price) || entry, currentPrice);
    const mfePct = ((peak - entry) / entry) * 100;

    const state = buildStateKey({
      regime, strategy: holding?.strategy || strategyConfig?.name,
      mfePct, pnlPct,
    });
    const cache = await loadCache();
    const choice = pickAction(cache, state);

    const adjustedConfig = applyAction(choice.action, strategyConfig) || strategyConfig;

    // Debounced audit. Only write when the action changes for this
    // (symbol, strategy) or every AUDIT_RELOG_CYCLES same-action skips —
    // keeps the hash-chained audit log from being hammered every cycle.
    const memoKey = `${holding.symbol}|${holding.strategy}`;
    const memo = _lastAudit.get(memoKey);
    const shouldLog = !memo
      || memo.action !== choice.action
      || memo.state !== state
      || memo.skips >= AUDIT_RELOG_CYCLES;
    if (shouldLog) {
      // FIFO bound: when at capacity, evict oldest insertion order entry
      // before adding the new one. Map iterators preserve insertion order.
      if (!memo && _lastAudit.size >= AUDIT_MEMO_MAX) {
        const oldestKey = _lastAudit.keys().next().value;
        if (oldestKey !== undefined) _lastAudit.delete(oldestKey);
      }
      _lastAudit.delete(memoKey); // re-insert to refresh insertion order
      _lastAudit.set(memoKey, { action: choice.action, state, skips: 0 });
      db.recordAudit({
        event_type: 'RL_EXEC_DECISION',
        symbol: holding.symbol,
        decision: 'HOLD',
        payload: {
          strategy: holding.strategy,
          rl_state: state,
          rl_action: choice.action,
          rl_explore: choice.explore,
          rl_eps: +choice.eps.toFixed(3),
          rl_total_n: choice.totalN,
          pnl_pct: +pnlPct.toFixed(3),
          mfe_pct: +mfePct.toFixed(3),
          regime: regime || 'normal',
          applied_trail_pct: adjustedConfig?.trailingStopPct,
          applied_arm_pct: adjustedConfig?.trailingActivatePct,
        },
      }).catch(() => {});
    } else {
      _lastAudit.set(memoKey, { action: choice.action, state, skips: memo.skips + 1 });
    }

    return {
      action: choice.action,
      explore: choice.explore,
      state,
      adjustedConfig,
    };
  } catch (e) {
    console.warn('[RL] recommendForHolding failed (swallowed):', e.message);
    return { action: 'NONE', adjustedConfig: strategyConfig, state: null };
  }
}

// ---------------------------------------------------------------------------
// Update Q for every decision logged on this trade with the realised R.
// Monte-Carlo style — the same terminal reward credits every step in the
// trade (γ=0 single-step is trivially equivalent here since we only reward
// at termination and don't bootstrap intermediate values).
//
//   Q(s,a) ← Q(s,a) + α · (R - Q(s,a))
async function recordOutcome({ symbol, strategy, pnlUSD, riskUSD }) {
  try {
    if (!Number.isFinite(pnlUSD)) return;
    const risk = Math.max(Number(riskUSD) || 0, 1);
    const reward = Math.max(-3, Math.min(3, pnlUSD / risk));   // R-multiple, clipped

    // Pull all RL decisions logged for this symbol/strategy since the most
    // recent BUY. Bounded look-back protects against runaway queries.
    const { rows: lastBuy } = await db.query(`
      SELECT created_at FROM audit_log
      WHERE event_type = 'TRADE_EXECUTED' AND symbol = $1
        AND decision = 'BUY' AND payload->>'strategy' = $2
        AND created_at >= NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC LIMIT 1
    `, [symbol, strategy]);
    if (!lastBuy.length) return;
    const since = lastBuy[0].created_at;

    const { rows: decisions } = await db.query(`
      SELECT payload FROM audit_log
      WHERE event_type = 'RL_EXEC_DECISION' AND symbol = $1
        AND payload->>'strategy' = $2
        AND created_at >= $3
      ORDER BY created_at ASC
      LIMIT 200
    `, [symbol, strategy, since]);

    if (!decisions.length) return;
    await ensureSchema();

    // Dedup (state, action) updates so a 30-step holding doesn't crush a
    // single Q cell with the same reward 30 times — count distinct
    // decisions per (state,action) and update once with that weight.
    const grouped = new Map();
    for (const d of decisions) {
      const k = `${d.payload.rl_state}|${d.payload.rl_action}`;
      grouped.set(k, (grouped.get(k) || 0) + 1);
    }

    for (const [key, weight] of grouped.entries()) {
      // The state contains '|' separators, so split on the LAST '|' for
      // the action.
      const cut = key.lastIndexOf('|');
      const state = key.substring(0, cut);
      const action = key.substring(cut + 1);
      // Weighted SGD-equivalent step. Repeating Q ← Q + α(R-Q) `weight`
      // times is mathematically equivalent to a single update with effective
      // rate beta = 1 - (1-α)^weight. New cells initialise to `reward`
      // (not reward*weight) so a single observation isn't artificially
      // amplified.
      const beta = 1 - Math.pow(1 - ALPHA, weight);
      await db.query(`
        INSERT INTO rl_q_table (state, action, q_value, n_visits, last_updated)
        VALUES ($1::text, $2::text, $3::float8, $4::int, NOW())
        ON CONFLICT (state, action) DO UPDATE SET
          q_value = rl_q_table.q_value + $5::float8 * ($3::float8 - rl_q_table.q_value),
          n_visits = rl_q_table.n_visits + $4::int,
          last_updated = NOW()
      `, [state, action, reward, weight, beta]);
    }
    _loadedAt = 0; // invalidate cache so next read sees the update
    console.log(`[RL] ${symbol}/${strategy} reward R=${reward.toFixed(2)} → updated ${grouped.size} (s,a) cells`);
  } catch (e) {
    console.error('[RL] recordOutcome failed (swallowed):', e.message);
  }
}

// ---------------------------------------------------------------------------
// Dashboard / introspection. Returns the top-by-visits cells per action so an
// operator can sanity-check which (state, action) pairs the layer has learned.
async function getStatus() {
  await ensureSchema();
  const { rows } = await db.query(`
    SELECT state, action, q_value, n_visits, last_updated
    FROM rl_q_table
    ORDER BY n_visits DESC
    LIMIT 50
  `);
  const totals = await db.query(`
    SELECT COUNT(*)::int AS cells, COALESCE(SUM(n_visits),0)::int AS visits
    FROM rl_q_table
  `);
  const byAction = await db.query(`
    SELECT action, COALESCE(AVG(q_value),0)::float AS avg_q, COALESCE(SUM(n_visits),0)::int AS visits
    FROM rl_q_table GROUP BY action ORDER BY action
  `);
  return {
    actions: ACTIONS,
    cells: totals.rows[0].cells,
    total_visits: totals.rows[0].visits,
    alpha: ALPHA,
    epsilon_base: EPSILON_BASE,
    epsilon_floor: EPSILON_FLOOR,
    trail_mult_band: [TRAIL_MULT_MIN, TRAIL_MULT_MAX],
    by_action: byAction.rows,
    top_cells: rows.map(r => ({
      state: r.state, action: r.action,
      q: +Number(r.q_value).toFixed(4),
      n: r.n_visits,
      last_updated: r.last_updated,
    })),
  };
}

module.exports = {
  ensureSchema, loadCache, recommendForHolding, recordOutcome, getStatus,
  clearAuditMemo,
  ACTIONS, TRAIL_MULT_MIN, TRAIL_MULT_MAX,
};
