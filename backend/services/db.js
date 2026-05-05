const { Pool } = require('pg');
const crypto = require('crypto');
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
  // ASX swing strategy toggle — defaults TRUE so adding the strategy is
  // opt-out rather than opt-in, but operators who don't want ASX exposure
  // can turn it off via the existing /api/agent/strategy endpoint.
  await query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS asx_swing_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS trading_mode TEXT NOT NULL DEFAULT 'paper'`);
  await query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS risk_scale TEXT NOT NULL DEFAULT 'balanced'`);
  // Optional auto-reset of the circuit breaker at the daily roll (paper mode
  // only — never auto-resets in live). Defaults TRUE so paper testing resumes
  // every day without operator intervention; live operators must explicitly
  // reset via the dashboard.
  await query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS auto_breaker_reset BOOLEAN NOT NULL DEFAULT TRUE`);
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

  // Per-model performance bucketed by regime + market — drives the dynamic
  // ensemble-weighting layer (llmWeightingService). The base model_performance
  // table above captures (model, strategy); this finer table adds regime and
  // market so weights can adapt to *context* (e.g. Claude is strong in
  // RISK_OFF + ASX swing but mid-pack in RISK_ON + US day). Bayesian-smoothed
  // when sample counts are low so cold-start weights stay near 1.0.
  await query(`
    CREATE TABLE IF NOT EXISTS model_regime_performance (
      model_id   TEXT NOT NULL,
      strategy   TEXT NOT NULL,
      regime     TEXT NOT NULL,
      market     TEXT NOT NULL,
      n_trades   INTEGER NOT NULL DEFAULT 0,
      n_wins     INTEGER NOT NULL DEFAULT 0,
      gross_pnl  NUMERIC(14,4) NOT NULL DEFAULT 0,
      win_rate   NUMERIC(5,4) NOT NULL DEFAULT 0,
      avg_pnl    NUMERIC(14,4) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (model_id, strategy, regime, market)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS model_regime_perf_lookup_idx ON model_regime_performance (strategy, regime, market)`);

  // ML adaptive layer (mlAdaptiveService) — persistent online-learned weights
  // for the logistic + linear heads that calibrate confidence and nudge
  // sizing within the [0.85, 1.15] band. Single row, JSONB blob.
  await query(`
    CREATE TABLE IF NOT EXISTS ml_adaptive_weights (
      name        TEXT PRIMARY KEY,
      weights     JSONB NOT NULL,
      n_updates   INTEGER NOT NULL DEFAULT 0,
      metrics     JSONB,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Implied-volatility history — one row per symbol per trading day. Used by
  // optionsFlowService to compute IV rank (where today's IV sits in the
  // rolling 252-day high/low range). Cheap, append-only.
  await query(`
    CREATE TABLE IF NOT EXISTS iv_history (
      symbol      TEXT NOT NULL,
      as_of_date  DATE NOT NULL,
      iv_avg      DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (symbol, as_of_date)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS iv_history_symbol_date_idx ON iv_history (symbol, as_of_date DESC)`);

  // RL execution layer — tabular Q-table over (state, action). State =
  // regime|strategy|mfe-bucket|pnl-bucket; action ∈ {NONE, TIGHTEN, LOOSEN,
  // ARM_EARLY, LOCK_IN}. Trained online from realised R-multiple per closed
  // trade. Pure execution-layer hint — quorum/gate/breaker untouched.
  await query(`
    CREATE TABLE IF NOT EXISTS rl_q_table (
      state         TEXT NOT NULL,
      action        TEXT NOT NULL,
      q_value       DOUBLE PRECISION NOT NULL DEFAULT 0,
      n_visits      INTEGER NOT NULL DEFAULT 0,
      last_updated  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (state, action)
    )
  `);

  // Long-term company knowledge graph (knowledgeGraphService) — slow-moving
  // per-symbol context (sector, peers, earnings track, valuation, macro,
  // major-event timeline). Refreshed daily and on strong-news events.
  await query(`
    CREATE TABLE IF NOT EXISTS company_knowledge (
      symbol           TEXT PRIMARY KEY,
      market           TEXT,
      sector           TEXT,
      data             JSONB NOT NULL DEFAULT '{}'::jsonb,
      summary          TEXT,
      stale_flag       BOOLEAN NOT NULL DEFAULT FALSE,
      stale_reason     TEXT,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      next_refresh_at  TIMESTAMPTZ
    )
  `);

  // Regime-aware meta-learning layer (metaLearningService) — per-regime,
  // per-strategy closed-trade rollup. Drives the regime-conditional
  // confidence-threshold tightening and sizing nudge.
  await query(`
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

  // Causal inference + counterfactual reasoning layer (causalInferenceService
  // + counterfactualService). Per (strategy × regime × market) we mine the
  // closed-trade history to identify which decision-time features have a
  // *real* lift on win-rate (vs spurious correlations under a sample-size
  // floor) and what the aggregate P&L would have been under a few canned
  // decision-rule counterfactuals (tighter conf gate, stricter quorum, skip
  // adverse regimes, etc.). Single JSONB blob per context bucket; refreshed
  // on a slow cadence. Strictly informational — quorum/gate/breaker untouched.
  await query(`
    CREATE TABLE IF NOT EXISTS causal_insights (
      strategy   TEXT NOT NULL,
      regime     TEXT NOT NULL,
      market     TEXT NOT NULL,
      payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
      n_closes   INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (strategy, regime, market)
    )
  `);

  // Intelligent Safety Suggestion Layer (safetySuggestionService). Each row
  // is ONE bounded recommendation (risk-scale tier change OR strategy
  // disable) generated from realised P&L + counterfactual evidence. status
  // moves pending → applied | rejected | expired. NOTHING is ever applied
  // automatically — every transition requires an explicit user POST. Hard
  // safety rules (quorum, 85% gate floor in conservative tier, $100/day
  // budget in conservative tier, 5% drawdown breaker, kill switch,
  // trailing-stop ratchet) remain immutable — the suggestion surface only
  // exposes parameters the user could already change themselves through
  // existing audited writers (setRiskScale, setStrategyEnabled).
  await query(`
    CREATE TABLE IF NOT EXISTS safety_suggestions (
      id              SERIAL PRIMARY KEY,
      kind            TEXT NOT NULL,
      target          TEXT NOT NULL,
      current_value   TEXT,
      suggested_value TEXT,
      severity        TEXT NOT NULL DEFAULT 'medium',
      rationale       TEXT NOT NULL,
      evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
      decided_at      TIMESTAMPTZ,
      decided_by      TEXT,
      applier_result  JSONB
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS safety_suggestions_status_idx ON safety_suggestions (status, created_at DESC)`);
  // Dedupe key: at most one PENDING suggestion per (kind, target, suggested_value)
  // at any time — refresh just updates rationale/evidence rather than piling up.
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS safety_suggestions_pending_uniq
               ON safety_suggestions (kind, target, suggested_value) WHERE status = 'pending'`);

  // Long-Term Memory & Experience Replay (memoryService). One row per closed
  // trade — the structured "what happened, in what context, with what
  // outcome" so the agent can retrieve similar past situations on every
  // cycle and inject the lessons into LLM prompts. feature_vec is a fixed-
  // length normalized JSONB float array (~28 dims) used for cosine-sim
  // retrieval — pgvector is intentionally NOT required (cleaner deployment
  // story, and the dims/cardinality are tiny enough that in-memory cosine
  // is faster than a vector index round-trip).
  //
  // Strictly read-only feedback into prompts — this layer never gates
  // trades, never alters risk parameters, and never bypasses quorum or any
  // hard safety rail. Failures degrade silently to a null prompt block.
  await query(`
    CREATE TABLE IF NOT EXISTS trade_memory (
      id              SERIAL PRIMARY KEY,
      trade_id        INTEGER UNIQUE,            -- the SELL trades.id this memory closed; UNIQUE so we never double-index
      symbol          VARCHAR(16) NOT NULL,
      strategy        VARCHAR(32) NOT NULL,
      regime          VARCHAR(32) NOT NULL DEFAULT 'unknown',
      market          VARCHAR(8)  NOT NULL DEFAULT 'US',
      direction       VARCHAR(8)  NOT NULL,      -- 'BUY' (we open longs only)
      entry_price     NUMERIC(18,6),
      exit_price      NUMERIC(18,6),
      qty             NUMERIC(18,6),
      pnl_usd         NUMERIC(14,4) NOT NULL,
      won             BOOLEAN NOT NULL,
      hold_seconds    INTEGER,
      entry_confidence NUMERIC(6,4),
      entry_quorum    INTEGER,                   -- 0-4, count of agreeing voters at entry
      lesson          TEXT NOT NULL,
      feature_vec     JSONB NOT NULL,            -- fixed-length normalized float array
      feature_schema_version INTEGER NOT NULL DEFAULT 1,  -- bump when featurize() layout changes; retrieval filters on this
      context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,  -- raw snapshot for forensic inspection
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Forward-compat ALTER for environments that already created the table
  // before the version column was introduced.
  await query(`ALTER TABLE trade_memory ADD COLUMN IF NOT EXISTS feature_schema_version INTEGER NOT NULL DEFAULT 1`);
  await query(`CREATE INDEX IF NOT EXISTS trade_memory_strategy_regime_idx ON trade_memory (strategy, regime, market)`);
  await query(`CREATE INDEX IF NOT EXISTS trade_memory_symbol_idx ON trade_memory (symbol)`);
  await query(`CREATE INDEX IF NOT EXISTS trade_memory_created_idx ON trade_memory (created_at DESC)`);

  // Cross-Market & Sector Propagation Layer (propagationService). Stores
  // mined conditional-outcome edges of the form: "when SOURCE (market×sector)
  // was in STATE during the 24h before entry, TARGET (market×sector) trades
  // had win-rate W and avg P&L P over N samples, lift L vs target baseline."
  // One row per (target × source × source_state) combination. Re-computed
  // every refresh — the partial UNIQUE index lets us upsert in place.
  // Strictly informational: this layer only writes its own table and only
  // contributes to LLM prompts; never gates trades or alters risk knobs.
  await query(`
    CREATE TABLE IF NOT EXISTS propagation_insights (
      id              SERIAL PRIMARY KEY,
      target_market   VARCHAR(8)  NOT NULL,
      target_sector   VARCHAR(32) NOT NULL,
      source_market   VARCHAR(8)  NOT NULL,
      source_sector   VARCHAR(32) NOT NULL,
      source_state    VARCHAR(16) NOT NULL,           -- 'bullish' | 'bearish' | 'neutral'
      target_winrate  NUMERIC(6,4) NOT NULL,          -- 0..1
      target_avg_pnl  NUMERIC(14,4) NOT NULL,         -- USD
      target_baseline_winrate NUMERIC(6,4) NOT NULL,  -- baseline for the target bucket
      lift_pp         NUMERIC(6,2) NOT NULL,          -- (winrate - baseline) * 100
      n_samples       INTEGER NOT NULL,
      computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS propagation_insights_uniq
               ON propagation_insights (target_market, target_sector, source_market, source_sector, source_state)`);
  await query(`CREATE INDEX IF NOT EXISTS propagation_insights_target_idx
               ON propagation_insights (target_market, target_sector, computed_at DESC)`);

  // Human-in-the-Loop Feedback Layer (feedbackService). One row per piece
  // of user feedback on a closed trade. `rating` is the explicit 1-5 stars
  // (nullable when only a NL comment was given), `sentiment` is the derived
  // bucket ('good'|'bad'|'neutral') used by mining queries, `tags` is a
  // small array of derived keywords ('too_aggressive', 'too_late', etc.)
  // for surfacing common patterns in the prompt block. Strictly
  // informational — only contributes to LLM prompts + dynamic weight nudges
  // bounded so they can ONLY tighten the existing gate.
  await query(`
    CREATE TABLE IF NOT EXISTS trade_feedback (
      id          SERIAL PRIMARY KEY,
      trade_id    INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
      rating      INTEGER,                          -- 1..5 stars (nullable)
      sentiment   VARCHAR(16) NOT NULL,             -- 'good' | 'bad' | 'neutral'
      comment     TEXT,
      tags        TEXT[] DEFAULT ARRAY[]::TEXT[],
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS trade_feedback_trade_idx ON trade_feedback (trade_id)`);
  await query(`CREATE INDEX IF NOT EXISTS trade_feedback_created_idx ON trade_feedback (created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS trade_feedback_sentiment_idx ON trade_feedback (sentiment)`);

  // Automated Strategy Discovery — proposals + active overlays.
  // `strategy_proposals` holds every backtested rule variation that beat the
  // delta threshold; status starts at 'pending' and moves to 'applied' or
  // 'dismissed' when the operator decides. Discovery NEVER auto-applies.
  // `active_overlays` is the live filter set: each row is a strictly
  // additive decision-rule predicate that downgrades a candidate BUY to
  // HOLD if the predicate fails. Predicates are pure functions of decision-
  // time signal/audit metadata; rule_def is rehydrated into a runnable
  // predicate by strategyDiscoveryService at gate-check time.
  await query(`
    CREATE TABLE IF NOT EXISTS strategy_proposals (
      id            SERIAL PRIMARY KEY,
      rule_key      VARCHAR(128) NOT NULL,
      rule_label    TEXT NOT NULL,
      rule_def      JSONB NOT NULL,
      strategy      VARCHAR(64) NOT NULL,
      regime        VARCHAR(64) NOT NULL,
      market        VARCHAR(16) NOT NULL,
      baseline_n    INTEGER NOT NULL,
      baseline_pnl  NUMERIC(14,2) NOT NULL,
      baseline_wr   NUMERIC(6,3) NOT NULL,
      kept_n        INTEGER NOT NULL,
      dropped_n     INTEGER NOT NULL,
      kept_pnl      NUMERIC(14,2) NOT NULL,
      kept_wr       NUMERIC(6,3) NOT NULL,
      delta_pnl     NUMERIC(14,2) NOT NULL,
      status        VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at    TIMESTAMPTZ,
      dismissed_by  VARCHAR(64)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS strategy_proposals_status_idx
               ON strategy_proposals (status, delta_pnl DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS strategy_proposals_ctx_idx
               ON strategy_proposals (rule_key, strategy, regime, market, status)`);

  await query(`
    CREATE TABLE IF NOT EXISTS active_overlays (
      id                 SERIAL PRIMARY KEY,
      rule_key           VARCHAR(128) NOT NULL,
      rule_label         TEXT NOT NULL,
      rule_def           JSONB NOT NULL,
      strategy           VARCHAR(64) NOT NULL,
      regime             VARCHAR(64) NOT NULL,
      market             VARCHAR(16) NOT NULL,
      source_proposal_id INTEGER REFERENCES strategy_proposals(id) ON DELETE SET NULL,
      applied_by         VARCHAR(64) NOT NULL DEFAULT 'operator',
      applied_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS active_overlays_ctx_uniq
               ON active_overlays (rule_key, strategy, regime, market)`);

  // Self-Supervised Market Pre-Training Layer.
  // `market_pretrain_codewords` — one row per discrete 5-bar context codeword
  // (e.g. 'U_L_F' = up-trend × low-vol × flat-momentum). Each row stores
  // the SSL-mined next-bar regime distribution as raw COUNTS (not pre-
  // normalised, so fine-tune updates compose correctly with re-training).
  // `pt_*` columns hold the pre-trained counts mined from years of historical
  // bars; `ft_*` columns hold the cumulative fine-tune updates from Alpha's
  // own closed trades (effective-sample-size 1 per trade so a single trade
  // never drowns the prior). Re-training preserves the `ft_*` columns.
  await query(`
    CREATE TABLE IF NOT EXISTS market_pretrain_codewords (
      codeword       VARCHAR(16) PRIMARY KEY,
      n_pretrain     INTEGER NOT NULL DEFAULT 0,
      pt_up_strong   INTEGER NOT NULL DEFAULT 0,
      pt_up_weak     INTEGER NOT NULL DEFAULT 0,
      pt_flat        INTEGER NOT NULL DEFAULT 0,
      pt_down_weak   INTEGER NOT NULL DEFAULT 0,
      pt_down_strong INTEGER NOT NULL DEFAULT 0,
      n_finetune     NUMERIC(10,2) NOT NULL DEFAULT 0,
      ft_up_strong   NUMERIC(10,2) NOT NULL DEFAULT 0,
      ft_up_weak     NUMERIC(10,2) NOT NULL DEFAULT 0,
      ft_flat        NUMERIC(10,2) NOT NULL DEFAULT 0,
      ft_down_weak   NUMERIC(10,2) NOT NULL DEFAULT 0,
      ft_down_strong NUMERIC(10,2) NOT NULL DEFAULT 0,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS market_pretrain_meta (
      id                 INTEGER PRIMARY KEY,
      last_pretrain_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      corpus_size        INTEGER NOT NULL DEFAULT 0,
      year_span          INTEGER NOT NULL DEFAULT 0,
      codewords_learned  INTEGER NOT NULL DEFAULT 0,
      symbols_scanned    INTEGER NOT NULL DEFAULT 0
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

  // --- Phase 4 compliance / multi-asset scaffolding ----------------------
  // Hash-chain on audit_log for tamper-evidence. row_hash = sha256(prev_hash
  // || serialized event body). prev_hash is the row_hash of the immediately
  // preceding audit row (by id). The verifier walks the chain forward.
  await query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT`);
  await query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS row_hash TEXT`);
  await query(`CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at)`);
  // Asset-class scaffolding — every trade/holding/audit row knows what it
  // represents. Default 'equity' preserves all existing behavior; future
  // option / futures support can target rows where asset_class differs.
  await query(`ALTER TABLE trades   ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'equity'`);
  await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'equity'`);
  await query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'equity'`);

  // Multi-market scaffolding (Phase 5: ASX via IBKR). `market` is the
  // listing exchange ('US' or 'ASX'), `currency` is the trade ccy, and
  // `fx_rate` is the FX→USD rate captured at trade time / entry time. All
  // existing rows default to US/USD/1.0 so older code paths are
  // identity-preserving. Equity computation reads holdings.currency +
  // current FX to convert AUD positions to USD on the fly.
  await query(`ALTER TABLE trades   ADD COLUMN IF NOT EXISTS market   TEXT NOT NULL DEFAULT 'US'`);
  await query(`ALTER TABLE trades   ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD'`);
  await query(`ALTER TABLE trades   ADD COLUMN IF NOT EXISTS fx_rate  NUMERIC(12,6) NOT NULL DEFAULT 1.0`);
  await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS market   TEXT NOT NULL DEFAULT 'US'`);
  await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD'`);
  await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS fx_rate_at_entry NUMERIC(12,6) NOT NULL DEFAULT 1.0`);

  console.log('[DB] Schema ensured (strategy + intel + adaptive + backtest + compliance + multi-market tables)');
}

async function getPortfolio() {
  const { rows } = await query('SELECT * FROM portfolio WHERE id = 1');
  return rows[0] || null;
}

const ALLOWED_PORTFOLIO_FIELDS = new Set([
  'cash_balance', 'starting_balance', 'day_start_equity',
  'circuit_breaker', 'emergency_pause', 'agent_running',
  'day_enabled', 'swing_enabled', 'asx_swing_enabled', 'trading_mode', 'risk_scale',
  'auto_breaker_reset',
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

async function upsertHolding({ symbol, strategy = 'day', qty, avg_cost, stop_loss, take_profit,
                               market, currency, fx_rate_at_entry }) {
  // market / currency / fx_rate_at_entry default to US/USD/1.0 at the SQL
  // layer when omitted, preserving the pre-multi-market call sites.
  await query(
    `INSERT INTO holdings (symbol, strategy, qty, avg_cost, stop_loss, take_profit,
                           market, currency, fx_rate_at_entry)
     VALUES ($1, $2, $3, $4, $5, $6,
             COALESCE($7,'US'), COALESCE($8,'USD'), COALESCE($9, 1.0))
     ON CONFLICT (symbol, strategy) DO UPDATE SET
       qty = EXCLUDED.qty,
       avg_cost = EXCLUDED.avg_cost,
       stop_loss = COALESCE(EXCLUDED.stop_loss, holdings.stop_loss),
       take_profit = COALESCE(EXCLUDED.take_profit, holdings.take_profit),
       market = EXCLUDED.market,
       currency = EXCLUDED.currency,
       fx_rate_at_entry = EXCLUDED.fx_rate_at_entry`,
    [symbol, strategy, qty, avg_cost, stop_loss, take_profit,
     market || null, currency || null, fx_rate_at_entry || null]
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
    `INSERT INTO trades (symbol, side, qty, price, confidence, consensus, order_id, status, pnl, reason, strategy, asset_class,
                         market, currency, fx_rate)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             COALESCE($13,'US'), COALESCE($14,'USD'), COALESCE($15,1.0)) RETURNING *`,
    [trade.symbol, trade.side, trade.qty, trade.price, trade.confidence,
     trade.consensus, trade.order_id, trade.status, trade.pnl || null, trade.reason,
     trade.strategy || null, trade.asset_class || 'equity',
     trade.market || null, trade.currency || null, trade.fx_rate || null]
  );
  return rows[0];
}

async function getRecentTrades(limit = 50) {
  const { rows } = await query('SELECT * FROM trades ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows;
}

// Hash-chain helpers — tamper-evident audit log. Each row hashes (prev_hash ||
// canonical body). A consumer can replay every row and confirm row_hash[i] ==
// sha256(row_hash[i-1] || body[i]); any silent edit breaks the chain.
// Serialized in a single transaction so concurrent writers can't race the
// "previous row" lookup. Fail-closed: if hash insert fails we still write the
// audit row (compliance value of having the record beats perfect chaining),
// but we log loudly so an operator notices.
function canonicalAuditBody({ event_type, symbol, decision, confidence, models, payload, asset_class, created_at }) {
  return JSON.stringify({
    event_type: event_type || null,
    symbol: symbol || null,
    decision: decision || null,
    confidence: confidence != null ? +confidence : null,
    models: models || null,
    payload: payload || null,
    asset_class: asset_class || 'equity',
    created_at: created_at ? new Date(created_at).toISOString() : null,
  });
}

async function recordAudit({ event_type, symbol, decision, confidence, models, payload, asset_class }) {
  const ac = asset_class || 'equity';
  const client = await pool.connect();
  let row;
  try {
    await client.query('BEGIN');
    // Serialize chain reads so concurrent inserts can't both read the same prev.
    await client.query('LOCK TABLE audit_log IN SHARE ROW EXCLUSIVE MODE');
    const prev = await client.query('SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prevHash = prev.rows[0]?.row_hash || 'GENESIS';
    const insert = await client.query(
      `INSERT INTO audit_log (event_type, symbol, decision, confidence, models, payload, asset_class, prev_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [event_type, symbol || null, decision || null, confidence || null,
       models ? JSON.stringify(models) : null, payload ? JSON.stringify(payload) : null,
       ac, prevHash]
    );
    row = insert.rows[0];
    const body = canonicalAuditBody({
      event_type, symbol, decision, confidence, models, payload, asset_class: ac, created_at: row.created_at,
    });
    const rowHash = crypto.createHash('sha256').update(prevHash + '|' + body).digest('hex');
    const upd = await client.query(
      'UPDATE audit_log SET row_hash = $1 WHERE id = $2 RETURNING *',
      [rowHash, row.id]
    );
    row = upd.rows[0];
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[DB] recordAudit chained-insert failed, falling back to plain insert:', e.message);
    // Fallback: at least preserve the audit record even if chain breaks.
    const f = await query(
      `INSERT INTO audit_log (event_type, symbol, decision, confidence, models, payload, asset_class)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [event_type, symbol || null, decision || null, confidence || null,
       models ? JSON.stringify(models) : null, payload ? JSON.stringify(payload) : null, ac]
    );
    row = f.rows[0];
  } finally {
    client.release();
  }
  if (row) { try { bus.emit('audit', row); } catch (_) { /* never block writes */ } }
  return row;
}

async function getRecentAudit(limit = 50) {
  const { rows } = await query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows;
}

// Walk the audit chain forward and verify every row_hash matches
// sha256(prev_hash || canonical body). Returns { ok, total, verified, brokenAt[] }.
// Skips rows missing row_hash (older legacy rows pre-Phase-4) with a count.
async function verifyAuditChain({ since } = {}) {
  const args = [];
  let where = '';
  if (since) { args.push(since); where = `WHERE created_at >= $${args.length}`; }
  const { rows } = await query(
    `SELECT id, event_type, symbol, decision, confidence, models, payload, asset_class, prev_hash, row_hash, created_at
     FROM audit_log ${where} ORDER BY id ASC`, args
  );
  let verified = 0, legacy = 0;
  const brokenAt = [];
  let expectedPrev = null;
  for (const r of rows) {
    if (!r.row_hash) { legacy += 1; expectedPrev = null; continue; }
    if (expectedPrev != null && r.prev_hash !== expectedPrev) {
      brokenAt.push({ id: r.id, reason: 'prev_hash mismatch', expected: expectedPrev, found: r.prev_hash });
      expectedPrev = r.row_hash;
      continue;
    }
    const body = canonicalAuditBody(r);
    const h = crypto.createHash('sha256').update((r.prev_hash || 'GENESIS') + '|' + body).digest('hex');
    if (h !== r.row_hash) {
      brokenAt.push({ id: r.id, reason: 'row_hash mismatch (tampered or schema drift)' });
    } else {
      verified += 1;
    }
    expectedPrev = r.row_hash;
  }
  return { ok: brokenAt.length === 0, total: rows.length, verified, legacy, brokenAt };
}

module.exports = {
  query, pool, ensureSchema, getPortfolio, updatePortfolio, adjustCash,
  getHoldings, getHolding, upsertHolding, deleteHolding,
  recordTrade, getRecentTrades,
  recordAudit, getRecentAudit, verifyAuditChain,
  updateTrailing,
};
