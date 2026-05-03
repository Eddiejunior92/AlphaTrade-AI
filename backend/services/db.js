const { Pool } = require('pg');

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

async function getPortfolio() {
  const { rows } = await query('SELECT * FROM portfolio WHERE id = 1');
  return rows[0] || null;
}

const ALLOWED_PORTFOLIO_FIELDS = new Set([
  'cash_balance', 'starting_balance', 'day_start_equity',
  'circuit_breaker', 'emergency_pause', 'agent_running',
]);

async function updatePortfolio(updates) {
  const fields = Object.keys(updates).filter(f => ALLOWED_PORTFOLIO_FIELDS.has(f));
  if (!fields.length) return;
  const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = fields.map(f => updates[f]);
  await query(
    `UPDATE portfolio SET ${sets}, updated_at = NOW() WHERE id = 1`,
    values
  );
}

async function adjustCash(delta) {
  const { rows } = await query(
    `UPDATE portfolio SET cash_balance = cash_balance + $1, updated_at = NOW()
     WHERE id = 1 RETURNING cash_balance`,
    [delta]
  );
  return rows[0] ? parseFloat(rows[0].cash_balance) : null;
}

async function getHoldings() {
  const { rows } = await query('SELECT * FROM holdings ORDER BY symbol');
  return rows;
}

async function getHolding(symbol) {
  const { rows } = await query('SELECT * FROM holdings WHERE symbol = $1', [symbol]);
  return rows[0] || null;
}

async function upsertHolding({ symbol, qty, avg_cost, stop_loss, take_profit }) {
  await query(
    `INSERT INTO holdings (symbol, qty, avg_cost, stop_loss, take_profit)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (symbol) DO UPDATE SET
       qty = EXCLUDED.qty,
       avg_cost = EXCLUDED.avg_cost,
       stop_loss = COALESCE(EXCLUDED.stop_loss, holdings.stop_loss),
       take_profit = COALESCE(EXCLUDED.take_profit, holdings.take_profit)`,
    [symbol, qty, avg_cost, stop_loss, take_profit]
  );
}

async function deleteHolding(symbol) {
  await query('DELETE FROM holdings WHERE symbol = $1', [symbol]);
}

async function recordTrade(trade) {
  const { rows } = await query(
    `INSERT INTO trades (symbol, side, qty, price, confidence, consensus, order_id, status, pnl, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [trade.symbol, trade.side, trade.qty, trade.price, trade.confidence,
     trade.consensus, trade.order_id, trade.status, trade.pnl || null, trade.reason]
  );
  return rows[0];
}

async function getRecentTrades(limit = 50) {
  const { rows } = await query('SELECT * FROM trades ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows;
}

async function recordAudit({ event_type, symbol, decision, confidence, models, payload }) {
  await query(
    `INSERT INTO audit_log (event_type, symbol, decision, confidence, models, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [event_type, symbol || null, decision || null, confidence || null,
     models ? JSON.stringify(models) : null, payload ? JSON.stringify(payload) : null]
  );
}

async function getRecentAudit(limit = 50) {
  const { rows } = await query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows;
}

module.exports = {
  query, getPortfolio, updatePortfolio, adjustCash,
  getHoldings, getHolding, upsertHolding, deleteHolding,
  recordTrade, getRecentTrades,
  recordAudit, getRecentAudit,
};
