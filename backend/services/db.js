const { Pool } = require('pg');
const bus = require('./eventBus');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

pool.on('error', (err) => console.error('[DB] Pool error:', err.message));

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result;
}

async function ensureSchema() {
  await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS strategy TEXT NOT NULL DEFAULT 'day'`);
  await query(`ALTER TABLE trades   ADD COLUMN IF NOT EXISTS strategy TEXT`);
  await query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS day_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS swing_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS trading_mode TEXT NOT NULL DEFAULT 'paper'`);
  await query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS risk_scale TEXT NOT NULL DEFAULT 'balanced'`);
  // Trailing-stop tracking: highest price seen since entry, used to ratchet stop_loss UP.
  await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS highest_price NUMERIC(12,4)`);
  await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS trailing_armed BOOLEAN NOT NULL DEFAULT FALSE`);
  // Holdings PK was symbol-only; allow same symbol in multiple strategies.
  try {
    await query(`ALTER TABLE holdings DROP CONSTRAINT IF EXISTS holdings_pkey`);
    await query(`ALTER TABLE holdings ADD PRIMARY KEY (symbol, strategy)`);
  } catch (e) { /* already converted */ }

  // 20-year historical intelligence cache. One row per symbol, refreshed once
  // per day. payload is the full HistoricalIntelligenceService output (regime,
  // seasonality, drawdowns, hourly/weekday/monthly tendencies, etc).
  await query(`
    CREATE TABLE IF NOT EXISTS historical_intelligence (
      symbol      TEXT PRIMARY KEY,
      as_of_date  DATE NOT NULL,
      payload     JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS historical_intelligence_date_idx ON historical_intelligence (as_of_date)`);

  // Adaptive learning — closed-trade attribution by (symbol, strategy) and
  // (model, strategy). Tiny tables, full upsert each pass.
  await query(`
    CREATE TABLE IF NOT EXISTS symbol_strategy_performance (
      symbol     TEXT NOT NULL,
      strategy   TEXT NOT NULL,
      n_trades   INTEGER NOT NULL DEFAULT 0,
      n_wins     INTEGER NOT NULL DEFAULT 0,
      win_rate   NUMERIC(5,4) NOT NULL DEFAULT 0,
      avg_pnl    NUMERIC(14,4) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (symbol, strategy)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS model_performance (
      model_id   TEXT NOT NULL,
      strategy   TEXT NOT NULL,
      n_trades   INTEGER NOT NULL DEFAULT 0,
      n_wins     INTEGER NOT NULL DEFAULT 0,
      gross_pnl  NUMERIC(14,4) NOT NULL DEFAULT 0,
      win_rate   NUMERIC(5,4) NOT NULL DEFAULT 0,
      avg_pnl    NUMERIC(14,4) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (model_id, strategy)
    )
  `);

  // Backtest runs — full history of dashboard-launched backtests with their
  // params, equity curve, and trade log. Used for the Backtest tab.
  await query(`
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id           SERIAL PRIMARY KEY,
      symbols      TEXT[] NOT NULL,
      start_date   DATE,
      end_date     DATE,
      params       JSONB NOT NULL,
      results      JSONB NOT NULL,
      equity_curve JSONB,
      trades       JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS backtest_runs_created_idx ON backtest_runs (created_at DESC)`);

  console.log('[DB] Schema ensured (strategy + intel + adaptive + backtest tables)');
}

async function getPortfolio() {
  const { rows } = await query('SELECT * FROM portfolio WHERE id = 1');
  return rows[0] || null;
}

const ALLOWED_PORTFOLIO_FIELDS = new Set([
  'cash_balance', 'starting_balance', 'day_start_equity',
  'circuit_breaker', 'emergency_pause', 'agent_running',
  'day_enabled', 'swing_enabled', 'trading_mode', 'risk_scale',
]);

async function updatePortfolio(updates) {
  const fields = Object.keys(updates).filter(f => ALLOWED_PORTFOLIO_FIELDS.has(f));
  if (!fields.length) return;
  const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = fields.map(f => updates[f]);
  await query(`UPDATE portfolio SET ${sets}, updated_at = NOW() WHERE id = 1`, values);
}

async function adjustCash(delta) {
  const { rows } = await query(
    `UPDATE portfolio SET cash_balance = cash_balance + $1, updated_at = NOW()
     WHERE id = 1 RETURNING cash_balance`, [delta]
  );
  return rows[0] ? parseFloat(rows[0].cash_balance) : null;
}

async function getHoldings(strategy = null) {
  if (strategy) {
    const { rows } = await query('SELECT * FROM holdings WHERE strategy = $1 ORDER BY symbol', [strategy]);
    return rows;
  }
  const { rows } = await query('SELECT * FROM holdings ORDER BY strategy, symbol');
  return rows;
}

async function getHolding(symbol, strategy = 'day') {
  const { rows } = await query('SELECT * FROM holdings WHERE symbol = $1 AND strategy = $2', [symbol, strategy]);
  return rows[0] || null;
}

async function upsertHolding({ symbol, strategy = 'day', qty, avg_cost, stop_loss, take_profit }) {
  await query(
    `INSERT INTO holdings (symbol, strategy, qty, avg_cost, stop_loss, take_profit)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (symbol, strategy) DO UPDATE SET
       qty = EXCLUDED.qty,
       avg_cost = EXCLUDED.avg_cost,
       stop_loss = COALESCE(EXCLUDED.stop_loss, holdings.stop_loss),
       take_profit = COALESCE(EXCLUDED.take_profit, holdings.take_profit)`,
    [symbol, strategy, qty, avg_cost, stop_loss, take_profit]
  );
}

async function deleteHolding(symbol, strategy = 'day') {
  await query('DELETE FROM holdings WHERE symbol = $1 AND strategy = $2', [symbol, strategy]);
}

// Used by the trailing-stop ratchet. Only writes the trailing fields — no risk
// of clobbering qty / avg_cost mid-cycle.
async function updateTrailing(symbol, strategy, { highest_price, trailing_armed, stop_loss }) {
  await query(
    `UPDATE holdings SET
       highest_price = COALESCE($3, highest_price),
       trailing_armed = COALESCE($4, trailing_armed),
       stop_loss = COALESCE($5, stop_loss)
     WHERE symbol = $1 AND strategy = $2`,
    [symbol, strategy, highest_price, trailing_armed, stop_loss]
  );
}

async function recordTrade(trade) {
  const { rows } = await query(
    `INSERT INTO trades (symbol, side, qty, price, confidence, consensus, order_id, status, pnl, reason, strategy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [trade.symbol, trade.side, trade.qty, trade.price, trade.confidence,
     trade.consensus, trade.order_id, trade.status, trade.pnl || null, trade.reason, trade.strategy || null]
  );
  return rows[0];
}

async function getRecentTrades(limit = 50) {
  const { rows } = await query('SELECT * FROM trades ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows;
}

async function recordAudit({ event_type, symbol, decision, confidence, models, payload }) {
  const { rows } = await query(
    `INSERT INTO audit_log (event_type, symbol, decision, confidence, models, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [event_type, symbol || null, decision || null, confidence || null,
     models ? JSON.stringify(models) : null, payload ? JSON.stringify(payload) : null]
  );
  const row = rows[0];
  // Fire-and-forget: any subscriber (e.g. WS broadcaster) gets the row live.
  if (row) { try { bus.emit('audit', row); } catch (_) { /* never block writes */ } }
  return row;
}

async function getRecentAudit(limit = 50) {
  const { rows } = await query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows;
}

module.exports = {
  query, ensureSchema, getPortfolio, updatePortfolio, adjustCash,
  getHoldings, getHolding, upsertHolding, deleteHolding,
  recordTrade, getRecentTrades,
  recordAudit, getRecentAudit,
  updateTrailing,
};
