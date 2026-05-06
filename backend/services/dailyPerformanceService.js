// =============================================================================
// Daily Performance Service
// =============================================================================
// End-of-day rollup that:
//   1. Computes per-market (US / ASX) trading stats for the day
//   2. Pulls intelligence-layer insights (best regime today, top/bottom model
//      cumulative, LLM cost-saver counters)
//   3. Persists one row per (trading_date, market) into `daily_performance`
//      for historical tracking
//   4. Sends a formatted Discord summary via the existing webhook
//
// Triggered automatically by agent.js once per day at 21:30 UTC (~16:30 ET,
// 30 min after US close so SELL ladders settle and trade_memory rows land),
// and on demand via POST /api/performance/daily.
//
// SAFETY: read-only over trades/trade_memory/portfolio. Does not touch any
// trading state, holdings, breaker, or kill switch. Safe to invoke anytime.

const db = require('./db');
const discord = require('./discordService');

// ----------------------------------------------------------------------------
// Schema — daily_performance: one row per (date, market). UPSERT on conflict
// so a manual re-run overwrites that day's row instead of duplicating it.
// ----------------------------------------------------------------------------
async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_performance (
      trading_date    DATE          NOT NULL,
      market          TEXT          NOT NULL,        -- 'US' | 'ASX'
      net_pnl_usd     NUMERIC(14,4) NOT NULL DEFAULT 0,
      n_trades        INTEGER       NOT NULL DEFAULT 0,
      n_wins          INTEGER       NOT NULL DEFAULT 0,
      n_losses        INTEGER       NOT NULL DEFAULT 0,
      win_rate        NUMERIC(6,4)  NOT NULL DEFAULT 0,
      avg_r           NUMERIC(8,4),
      best_symbol     TEXT,
      best_pnl_usd    NUMERIC(14,4),
      worst_symbol    TEXT,
      worst_pnl_usd   NUMERIC(14,4),
      total_risk_usd  NUMERIC(14,4) NOT NULL DEFAULT 0,
      breaker_tripped BOOLEAN       NOT NULL DEFAULT FALSE,
      mode            TEXT,
      day_start_equity NUMERIC(14,4),
      best_regime     TEXT,
      best_regime_pnl NUMERIC(14,4),
      top_model       TEXT,
      bottom_model    TEXT,
      llm_cycles      INTEGER,
      llm_skipped     INTEGER,
      payload         JSONB         NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (trading_date, market)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS daily_performance_date_idx ON daily_performance (trading_date DESC)`);
}

// ----------------------------------------------------------------------------
// Per-market aggregation. Sources:
//   • trade_memory   — closed round-trips (one row per SELL that closed a
//                      position). Carries pnl_usd, won, regime, market.
//                      USD-converted at close — single source of truth for
//                      per-trade P&L regardless of native currency.
//   • trades         — order log; used for "total risk used" via BUY notional
//                      × 1% (proxy, since per-trade risk_at_entry isn't
//                      explicitly stored — caveat is shown in the summary).
// ----------------------------------------------------------------------------
// Per-market trading-day boundary: US sessions live in America/New_York;
// ASX sessions in Australia/Sydney. ASX session in UTC spans midnight
// (~23:00 prev → 06:00 current), so a naive UTC ::date filter would miss
// the morning leg. AT TIME ZONE rotates the timestamp into the local
// trading day before the cast.
const MARKET_TZ = { US: 'America/New_York', ASX: 'Australia/Sydney' };

async function computeMarketStats(tradingDate, market) {
  const tz = MARKET_TZ[market] || 'UTC';
  const closedQ = await db.query(`
    SELECT
      COUNT(*)::int                         AS n_trades,
      COUNT(*) FILTER (WHERE won)::int      AS n_wins,
      COUNT(*) FILTER (WHERE NOT won)::int  AS n_losses,
      COALESCE(SUM(pnl_usd), 0)::float      AS net_pnl_usd,
      COALESCE(AVG(
        CASE WHEN entry_price > 0 AND qty > 0
             THEN pnl_usd / (entry_price * qty * 0.01)
             ELSE NULL END
      ), 0)::float                          AS avg_r
    FROM trade_memory
    WHERE market = $1
      AND (created_at AT TIME ZONE $3)::date = $2::date
  `, [market, tradingDate, tz]);
  const closed = closedQ.rows[0];

  // Best winner + worst loser of the day. Two separate queries so we get the
  // single best and single worst even on a tiny sample.
  const [bestRes, worstRes] = await Promise.all([
    db.query(`
      SELECT symbol, pnl_usd::float AS pnl_usd FROM trade_memory
      WHERE market=$1 AND (created_at AT TIME ZONE $3)::date = $2::date
      ORDER BY pnl_usd DESC LIMIT 1
    `, [market, tradingDate, tz]),
    db.query(`
      SELECT symbol, pnl_usd::float AS pnl_usd FROM trade_memory
      WHERE market=$1 AND (created_at AT TIME ZONE $3)::date = $2::date
      ORDER BY pnl_usd ASC LIMIT 1
    `, [market, tradingDate, tz]),
  ]);
  const best  = bestRes.rows[0]  && bestRes.rows[0].pnl_usd  > 0 ? bestRes.rows[0]  : null;
  const worst = worstRes.rows[0] && worstRes.rows[0].pnl_usd < 0 ? worstRes.rows[0] : null;

  const riskQ = await db.query(`
    SELECT COALESCE(SUM(qty * price * 0.01), 0)::float AS total_risk_usd
    FROM trades
    WHERE side='BUY' AND market=$1
      AND (created_at AT TIME ZONE $3)::date = $2::date
  `, [market, tradingDate, tz]);

  const regimeQ = await db.query(`
    SELECT regime, COALESCE(SUM(pnl_usd), 0)::float AS pnl, COUNT(*)::int AS n
    FROM trade_memory
    WHERE market=$1 AND (created_at AT TIME ZONE $3)::date = $2::date
    GROUP BY regime ORDER BY pnl DESC LIMIT 1
  `, [market, tradingDate, tz]);

  return {
    market,
    n_trades:       closed.n_trades,
    n_wins:         closed.n_wins,
    n_losses:       closed.n_losses,
    win_rate:       closed.n_trades > 0 ? closed.n_wins / closed.n_trades : 0,
    net_pnl_usd:    closed.net_pnl_usd,
    avg_r:          closed.n_trades > 0 ? closed.avg_r : null,
    best, worst,
    total_risk_usd: riskQ.rows[0].total_risk_usd,
    best_regime:    regimeQ.rows[0] || null,
  };
}

// Cumulative best/worst voter from model_performance. Daily attribution would
// require joining each closed trade to its entry-time SIGNAL audit row to find
// which models voted BUY — too expensive for a daily report. Cumulative is
// honest and useful; the label makes the scope clear.
async function computeIntelligenceInsights() {
  const modelQ = await db.query(`
    SELECT model_id, win_rate::float AS wr, n_trades
    FROM model_performance
    WHERE n_trades >= 5
    ORDER BY win_rate DESC, n_trades DESC
  `);
  const top = modelQ.rows[0] || null;
  const bot = modelQ.rows.length > 0 ? modelQ.rows[modelQ.rows.length - 1] : null;
  return { top_model: top, bottom_model: bot };
}

// ----------------------------------------------------------------------------
// Top-level compute — combines per-market stats + portfolio state + insights.
// ----------------------------------------------------------------------------
// Returns YYYY-MM-DD as it reads in the given IANA timezone today.
function _todayInTz(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date()); // 'YYYY-MM-DD'
}

async function computeDailySummary({ tradingDate, perfMetrics, market } = {}) {
  await ensureSchema();
  // Trading date defaults are timezone-aware so an ASX report run at 07:00
  // UTC picks today's Sydney date even when the UTC date already rolled.
  const usDate  = tradingDate || _todayInTz('America/New_York');
  const asxDate = tradingDate || _todayInTz('Australia/Sydney');

  const portRows = await db.query(`SELECT * FROM portfolio LIMIT 1`);
  const portfolio = portRows.rows[0] || {};

  // End-of-day equity proxy = cash + Σ(qty × best-known mark). We prefer
  // `highest_price` (updated every cycle by the trailing-stop logic, so
  // it's a fresh in-session price) and fall back to `avg_cost` for any
  // position that hasn't ticked yet. Avoids needing a live broker price
  // fetch at report time and stays read-only.
  const cash = parseFloat(portfolio.cash_balance) || 0;
  const holdingsQ = await db.query(`
    SELECT COALESCE(SUM(qty * COALESCE(highest_price, avg_cost) * COALESCE(fx_rate_at_entry, 1.0)), 0)::float AS holdings_value_usd
    FROM holdings
  `);
  const dayEndEquity = cash + (holdingsQ.rows[0]?.holdings_value_usd || 0);
  const dayStartEquity = portfolio.day_start_equity != null ? parseFloat(portfolio.day_start_equity) : null;
  const equityChange = dayStartEquity != null
    ? { abs_usd: dayEndEquity - dayStartEquity, pct: dayStartEquity > 0 ? ((dayEndEquity - dayStartEquity) / dayStartEquity) * 100 : null }
    : null;

  // Skip the market(s) the caller didn't ask for so the SQL stays cheap.
  const [us, asx, insights] = await Promise.all([
    (!market || market === 'US')  ? computeMarketStats(usDate,  'US')  : Promise.resolve(null),
    (!market || market === 'ASX') ? computeMarketStats(asxDate, 'ASX') : Promise.resolve(null),
    computeIntelligenceInsights(),
  ]);

  // Per-market LLM accounting. perfMetrics carries per-market counters
  // (tagged at increment time in agent.js) so each report bills only the
  // calls actually made for that market's symbols.
  const llmCallCost  = Number(process.env.LLM_CALL_COST_USD) || 0.002;
  // Data-feed cost can be set per-market (Alpaca → US, IBKR → ASX). Falls
  // back to splitting DATA_FEED_COST_USD_PER_DAY 50/50 if only the legacy
  // single-value var is set.
  const legacyData   = Number(process.env.DATA_FEED_COST_USD_PER_DAY) || 0;
  const dataUS       = process.env.DATA_FEED_COST_USD_PER_DAY_US  != null ? Number(process.env.DATA_FEED_COST_USD_PER_DAY_US)  : legacyData / 2;
  const dataASX      = process.env.DATA_FEED_COST_USD_PER_DAY_ASX != null ? Number(process.env.DATA_FEED_COST_USD_PER_DAY_ASX) : legacyData / 2;
  // NOTE: `ensembleEscalated*` is a SUBSET of `ensembleCalls*` (every
  // escalated tick also increments calls). Only bill `calls` here.
  const callsByMkt  = perfMetrics?.ensembleCallsByMarket   || { US: 0, ASX: 0 };
  const skipByMkt   = perfMetrics?.ensembleSkippedByMarket || { US: 0, ASX: 0 };
  const quietByMkt  = perfMetrics?.ensembleQuietSkippedByMarket || { US: 0, ASX: 0 };
  const escByMkt    = perfMetrics?.ensembleEscalatedByMarket    || { US: 0, ASX: 0 };

  const buildExpenses = (mkt, marketStats) => {
    const calls = callsByMkt[mkt] || 0;
    const llmCost = +(calls * llmCallCost).toFixed(2);
    const data    = +((mkt === 'US' ? dataUS : dataASX) || 0).toFixed(2);
    const gross   = +((marketStats?.net_pnl_usd || 0)).toFixed(2);
    const costs   = +(llmCost + data).toFixed(2);
    return {
      llm_call_cost_usd: llmCallCost,
      llm_calls_billed:  calls,
      llm_skipped:       (skipByMkt[mkt] || 0) + (quietByMkt[mkt] || 0),
      llm_escalated:     escByMkt[mkt] || 0,
      llm_cost_usd:      llmCost,
      data_feed_usd:     data,
      total_costs_usd:   costs,
      total_gross_usd:   gross,
      total_net_usd:     +(gross - costs).toFixed(2),
    };
  };

  return {
    tradingDate: market === 'ASX' ? asxDate : usDate,
    market: market || null,                 // null = both-market combined run
    us, asx,
    expenses_us:  us  ? buildExpenses('US',  us)  : null,
    expenses_asx: asx ? buildExpenses('ASX', asx) : null,
    breaker_tripped: !!portfolio.circuit_breaker,
    mode:            portfolio.trading_mode || 'paper',
    risk_scale:      portfolio.risk_scale   || 'balanced',
    day_start_equity: dayStartEquity,
    day_end_equity:   dayEndEquity,
    equity_change:    equityChange,
    insights,
  };
}

// ----------------------------------------------------------------------------
// Persist — UPSERT one row per (date, market). Idempotent: a manual re-run
// for the same date overwrites instead of duplicating.
// ----------------------------------------------------------------------------
async function storeSummary(summary) {
  for (const key of ['us', 'asx']) {
    const s = summary[key];
    if (!s) continue;  // single-market run skips the other side
    await db.query(`
      INSERT INTO daily_performance (
        trading_date, market, net_pnl_usd, n_trades, n_wins, n_losses, win_rate,
        avg_r, best_symbol, best_pnl_usd, worst_symbol, worst_pnl_usd,
        total_risk_usd, breaker_tripped, mode, day_start_equity,
        best_regime, best_regime_pnl, top_model, bottom_model,
        llm_cycles, llm_skipped, payload
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14, $15, $16,
        $17, $18, $19, $20,
        $21, $22, $23
      )
      ON CONFLICT (trading_date, market) DO UPDATE SET
        net_pnl_usd      = EXCLUDED.net_pnl_usd,
        n_trades         = EXCLUDED.n_trades,
        n_wins           = EXCLUDED.n_wins,
        n_losses         = EXCLUDED.n_losses,
        win_rate         = EXCLUDED.win_rate,
        avg_r            = EXCLUDED.avg_r,
        best_symbol      = EXCLUDED.best_symbol,
        best_pnl_usd     = EXCLUDED.best_pnl_usd,
        worst_symbol     = EXCLUDED.worst_symbol,
        worst_pnl_usd    = EXCLUDED.worst_pnl_usd,
        total_risk_usd   = EXCLUDED.total_risk_usd,
        breaker_tripped  = EXCLUDED.breaker_tripped,
        mode             = EXCLUDED.mode,
        day_start_equity = EXCLUDED.day_start_equity,
        best_regime      = EXCLUDED.best_regime,
        best_regime_pnl  = EXCLUDED.best_regime_pnl,
        top_model        = EXCLUDED.top_model,
        bottom_model     = EXCLUDED.bottom_model,
        llm_cycles       = EXCLUDED.llm_cycles,
        llm_skipped      = EXCLUDED.llm_skipped,
        payload          = EXCLUDED.payload,
        created_at       = NOW()
    `, [
      summary.tradingDate, s.market.toUpperCase(),
      s.net_pnl_usd, s.n_trades, s.n_wins, s.n_losses, s.win_rate,
      s.avg_r, s.best?.symbol || null, s.best?.pnl_usd || null,
      s.worst?.symbol || null, s.worst?.pnl_usd || null,
      s.total_risk_usd, summary.breaker_tripped, summary.mode, summary.day_start_equity,
      s.best_regime?.regime || null, s.best_regime?.pnl || null,
      summary.insights.top_model?.model_id || null, summary.insights.bottom_model?.model_id || null,
      summary.llm?.calls || null, summary.llm?.skipped || null,
      JSON.stringify({ insights: summary.insights, llm: summary.llm }),
    ]);
  }
}

// ----------------------------------------------------------------------------
// Discord formatting
// ----------------------------------------------------------------------------
function formatMarketBlock(label, flag, s) {
  if (!s.n_trades) {
    return `${flag} **${label}**\n• No closed trades today`;
  }
  const sign = s.net_pnl_usd >= 0 ? '+' : '-';
  const absPnl = Math.abs(s.net_pnl_usd);
  const wr   = (s.win_rate * 100).toFixed(1);
  const r    = s.avg_r != null ? `${s.avg_r >= 0 ? '+' : ''}${s.avg_r.toFixed(2)}R` : 'n/a';
  const lines = [
    `${flag} **${label}**`,
    `• Net P&L: **${sign}$${absPnl.toFixed(2)} USD**`,
    `• Trades: ${s.n_trades} (${s.n_wins}W / ${s.n_losses}L)  •  Win rate: ${wr}%`,
    `• Avg R *(1%-notional proxy)*: ${r}`,
  ];
  if (s.best)  lines.push(`• 🏆 Best:  \`${s.best.symbol}\`  +$${s.best.pnl_usd.toFixed(2)}`);
  if (s.worst) lines.push(`• 🩸 Worst: \`${s.worst.symbol}\`  -$${Math.abs(s.worst.pnl_usd).toFixed(2)}`);
  lines.push(`• Total risk used: $${s.total_risk_usd.toFixed(2)}`);
  return lines.join('\n');
}

// Per-market formatter. `market` is 'US' or 'ASX'. Only renders that
// market's stats, that market's expense breakdown, and the portfolio-wide
// capital position (cash+holdings is unified USD-equivalent so it's the
// same number on either report — we label it accordingly).
function formatMarketReport(summary, market) {
  const mkt        = market.toUpperCase();
  const data       = mkt === 'ASX' ? summary.asx : summary.us;
  const expenses   = mkt === 'ASX' ? summary.expenses_asx : summary.expenses_us;
  const flag       = mkt === 'ASX' ? '🇦🇺' : '🇺🇸';
  const label      = mkt === 'ASX' ? 'ASX Markets' : 'US Markets';
  const dateLabel  = new Date(summary.tradingDate + 'T00:00:00Z').toUTCString().slice(0, 16);
  const breaker    = summary.breaker_tripped ? '🚨 **TRIPPED**' : '✅ Clear';
  const insights   = summary.insights;
  const fmtSigned  = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;

  const e = expenses || {};
  const totalLLMActivity = (e.llm_calls_billed || 0) + (e.llm_skipped || 0);
  const skipRate = totalLLMActivity > 0 ? ((e.llm_skipped / totalLLMActivity) * 100).toFixed(0) : '0';
  const pnlBlock = e.total_gross_usd != null ? [
    `💰 **Net P&L (after costs)**`,
    `• Gross: **${fmtSigned(e.total_gross_usd)}**  •  Costs: $${e.total_costs_usd.toFixed(2)}  •  **Net: ${fmtSigned(e.total_net_usd)}**`,
    `• Expenses: LLM $${e.llm_cost_usd.toFixed(2)} (${(e.llm_calls_billed || 0).toLocaleString()} calls @ $${e.llm_call_cost_usd}) + Data $${e.data_feed_usd.toFixed(2)}`,
    `• LLM activity: ${(e.llm_calls_billed || 0).toLocaleString()} called · ${(e.llm_skipped || 0).toLocaleString()} skipped (${skipRate}% skip-rate) · ${(e.llm_escalated || 0).toLocaleString()} escalated to premium`,
    '',
  ] : [];

  const fmtRegime = (r) => {
    if (!r) return '*no closed trades*';
    const s = r.pnl >= 0 ? '+' : '-';
    const n = r.n === 1 ? '1 trade' : `${r.n} trades`;
    return `${r.regime} (${s}$${Math.abs(r.pnl).toFixed(2)}, ${n})`;
  };

  return [
    `📊 **${mkt} Daily Performance — ${dateLabel}**`,
    '─────────────────────────────',
    ...pnlBlock,
    formatMarketBlock(label, flag, data),
    '',
    `💼 **Capital Position** *(portfolio-wide, USD)*`,
    summary.day_start_equity != null
      ? `• Start: $${summary.day_start_equity.toFixed(2)}  →  End: $${summary.day_end_equity.toFixed(2)}`
      : `• End equity: $${summary.day_end_equity.toFixed(2)}`,
    summary.equity_change
      ? `• Change: ${summary.equity_change.abs_usd >= 0 ? '+' : '-'}$${Math.abs(summary.equity_change.abs_usd).toFixed(2)}` +
        (summary.equity_change.pct != null
          ? `  (${summary.equity_change.pct >= 0 ? '+' : ''}${summary.equity_change.pct.toFixed(2)}%)`
          : '')
      : null,
    '',
    `🛡️ **Risk & Safety**`,
    `• Circuit breaker: ${breaker}`,
    `• Mode: **${summary.mode.toUpperCase()}**  •  Risk scale: **${summary.risk_scale.toUpperCase()}**`,
    '',
    `🧠 **Intelligence Layer**`,
    `• Best regime today: ${fmtRegime(data?.best_regime)}`,
    insights.top_model    ? `• Top voter (cum.):    \`${insights.top_model.model_id}\` — ${(insights.top_model.wr * 100).toFixed(1)}% WR (n=${insights.top_model.n_trades})` : null,
    insights.bottom_model ? `• Bottom voter (cum.): \`${insights.bottom_model.model_id}\` — ${(insights.bottom_model.wr * 100).toFixed(1)}% WR (n=${insights.bottom_model.n_trades})` : null,
  ].filter(Boolean).join('\n');
}

// Back-compat shim: formatSummaryText(summary) returns the report for
// the market the summary was scoped to. If both markets are present
// (legacy/manual run with no market filter), returns US then ASX
// concatenated — the scheduler now sends them as two posts but this keeps
// the manual API/test paths working.
function formatSummaryText(summary) {
  if (summary.market === 'US')  return formatMarketReport(summary, 'US');
  if (summary.market === 'ASX') return formatMarketReport(summary, 'ASX');
  const parts = [];
  if (summary.us)  parts.push(formatMarketReport(summary, 'US'));
  if (summary.asx) parts.push(formatMarketReport(summary, 'ASX'));
  return parts.join('\n\n══════════════════════════════\n\n');
}

async function _sendOneMarket(summary, market) {
  const data = market === 'ASX' ? summary.asx : summary.us;
  const text = formatMarketReport(summary, market);
  const pnl  = data?.net_pnl_usd || 0;
  // Color coding: red on tripped breaker, green on net profit, amber on loss.
  const color = summary.breaker_tripped ? 0xff0000 : (pnl >= 0 ? 0x00c851 : 0xff8c00);
  const flag  = market === 'ASX' ? '🇦🇺' : '🇺🇸';
  await discord.sendAlert({
    title: `${flag} ${market} Daily Performance — ${summary.tradingDate}`,
    description: text,
    color,
    fields: [],
  });
}

async function sendToDiscord(summary) {
  // Each market gets its OWN Discord post — separate trade list, separate
  // expense breakdown, separate color coding. Skip a market that wasn't
  // computed in this run.
  if (summary.us)  await _sendOneMarket(summary, 'US');
  if (summary.asx) await _sendOneMarket(summary, 'ASX');
}

// ----------------------------------------------------------------------------
// Orchestrator — used by both the nightly auto-run and the manual endpoint.
// Best-effort Discord send: a webhook failure must not fail the whole job
// (the row is already persisted by then).
// ----------------------------------------------------------------------------
// Best-effort orchestrator — never throws. Each stage (compute / store /
// discord) is wrapped independently so a failure in one is surfaced via the
// returned status without aborting the others or crashing the nightly
// scheduler. Callers (the cron tick, the manual endpoint) get a structured
// `{success, stage?, error?, summary?, formatted?, discordSent}` object.
async function runDailyPerformanceJob({ tradingDate, perfMetrics, sendDiscord = true, market } = {}) {
  let summary = null;
  try {
    summary = await computeDailySummary({ tradingDate, perfMetrics, market });
  } catch (e) {
    console.error('[DailyPerf] compute failed:', e.message);
    return { success: false, stage: 'compute_failed', error: e.message, discordSent: false };
  }

  let storeError = null;
  try {
    await storeSummary(summary);
  } catch (e) {
    storeError = e.message;
    console.error('[DailyPerf] store failed:', e.message);
  }

  let formatted = null;
  try { formatted = formatSummaryText(summary); }
  catch (e) { console.error('[DailyPerf] format failed:', e.message); }

  let discordSent = false;
  let discordError = null;
  if (sendDiscord) {
    try { await sendToDiscord(summary); discordSent = true; }
    catch (e) { discordError = e.message; console.error('[DailyPerf] Discord send failed:', e.message); }
  }

  return {
    success: !storeError && !discordError,
    stage: storeError ? 'store_failed' : (discordError ? 'discord_failed' : 'ok'),
    error: storeError || discordError || null,
    summary, formatted, discordSent,
  };
}

module.exports = {
  ensureSchema,
  computeDailySummary,
  storeSummary,
  sendToDiscord,
  runDailyPerformanceJob,
  formatSummaryText,
};
