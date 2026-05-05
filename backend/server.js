require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const {
  startAgent, stopAgent, runCycle, getAgentSnapshot,
  emergencyPause, resetCircuitBreaker, setAutoBreakerReset, flattenAllPositions,
  cancelAllOpenOrders, killSwitch, isKillSwitchLatched,
  setStrategyEnabled, setTradingMode, setRiskScale,
} = require('./agent');
const complianceService = require('./services/complianceService');
const alpacaService = require('./services/alpacaService');
const llmService = require('./services/llmService');
const brokerService = require('./services/brokerService');
const sentimentService = require('./services/sentimentService');
const premarketService = require('./services/premarketService');
const db = require('./services/db');
const bus = require('./services/eventBus');
const { getWatchlist, listStrategies, DEFAULT_RISK_SCALE } = require('./strategies');
// Bound applier functions for the safety-suggestion endpoints. Imported as
// individual functions above (not as a namespace) so the suggestion service
// stays decoupled from the agent module.
const _safetyApplierFns = { setRiskScale, setStrategyEnabled };
const marketRegistry = require('./services/marketRegistry');
const brokerRouter = require('./services/brokerRouter');

// Combined US + ASX watchlist — used as the access whitelist for any
// per-symbol endpoint (bars, sentiment, backtest). Recomputed per request
// so env overrides take effect without a process restart.
function getCombinedWatchlist() {
  return [...new Set([
    ...getWatchlist().map(s => s.toUpperCase()),
    ...marketRegistry.getAsxWatchlist().map(s => s.toUpperCase()),
  ])];
}
function marketOf(sym) { return marketRegistry.getSymbolInfo(sym).market; }

const app = express();
const PORT = parseInt(process.env.PORT) || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION && !OPERATOR_TOKEN) {
  console.error('[Server] FATAL: OPERATOR_TOKEN must be set in production for control-plane auth');
  process.exit(1);
}
if (!OPERATOR_TOKEN) {
  console.warn('[Server] ⚠ OPERATOR_TOKEN not set — control-plane endpoints are UNAUTHENTICATED. Set it before exposing this server publicly.');
}

function requireOperator(req, res, next) {
  if (!OPERATOR_TOKEN) return next();
  const provided = req.get('x-operator-token') || req.query.token;
  if (provided !== OPERATOR_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized — operator token required' });
  }
  next();
}
function requireOperatorStrict(req, res, next) {
  // Mode switch to LIVE always requires the operator token, regardless of env.
  // If OPERATOR_TOKEN is unset, the live switch is refused entirely.
  if (req.body?.mode === 'live') {
    if (!OPERATOR_TOKEN) {
      return res.status(403).json({
        success: false,
        error: 'Switching to LIVE mode requires OPERATOR_TOKEN to be configured on the server.',
      });
    }
    const provided = req.get('x-operator-token') || req.query.token;
    if (provided !== OPERATOR_TOKEN) {
      return res.status(401).json({ success: false, error: 'Operator token required for LIVE mode switch' });
    }
  }
  next();
}
app.use((req, res, next) => {
  // Operator-token gate — protects anything that can change agent state
  // (start/stop, mode switch, flatten, refresh, risk scale, strategy toggle).
  // Broker chat (/api/broker/chat[-stream]) is intentionally NOT gated:
  // it is read-only conversation about the portfolio and never places trades.
  if (req.method === 'POST' && req.path.startsWith('/api/agent/')) {
    return requireOperator(req, res, next);
  }
  next();
});
app.use('/api/agent/trading-mode', requireOperatorStrict);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const wsClients = new Set();

wss.on('connection', async (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
  try {
    const snap = await getAgentSnapshot();
    ws.send(JSON.stringify({ type: 'state', data: snap }));
  } catch {}
});

async function broadcastState() {
  if (wsClients.size === 0) return;
  try {
    const snap = await getAgentSnapshot();
    const msg = JSON.stringify({ type: 'state', data: snap });
    for (const ws of [...wsClients]) {
      if (ws.readyState !== WebSocket.OPEN) { wsClients.delete(ws); continue; }
      try { ws.send(msg); } catch { wsClients.delete(ws); try { ws.terminate(); } catch {} }
    }
  } catch (e) { console.error('[WS] broadcast error:', e.message); }
}
setInterval(broadcastState, 4000);

// Live audit-log push: every recordAudit() emits on the bus; we forward to
// all connected dashboards so the Reasoning tab updates without polling.
function broadcastAudit(row) {
  if (!row || wsClients.size === 0) return;
  const msg = JSON.stringify({ type: 'audit', data: row });
  for (const ws of [...wsClients]) {
    if (ws.readyState !== WebSocket.OPEN) { wsClients.delete(ws); continue; }
    try { ws.send(msg); } catch { wsClients.delete(ws); try { ws.terminate(); } catch {} }
  }
}
bus.on('audit', broadcastAudit);

// Live push of fresh pre-market briefings to all dashboards.
bus.on('premarket', (payload) => {
  if (!payload || wsClients.size === 0) return;
  const msg = JSON.stringify({ type: 'premarket', data: payload });
  for (const ws of [...wsClients]) {
    if (ws.readyState !== WebSocket.OPEN) { wsClients.delete(ws); continue; }
    try { ws.send(msg); } catch { wsClients.delete(ws); try { ws.terminate(); } catch {} }
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(),
    providers: llmService.getProviderStatus(), alpaca: alpacaService.isConfigured(),
  });
});

app.get('/api/state', async (req, res) => {
  try { res.json(await getAgentSnapshot()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Auth probe — lets the dashboard know whether it must collect an operator
// token. Reports whether the request's currently-supplied token (if any) is
// valid. Read-only; safe to call unauthenticated.
app.get('/api/auth/status', (req, res) => {
  const provided = req.get('x-operator-token') || req.query.token;
  const tokenRequired = !!OPERATOR_TOKEN;
  const authenticated = !tokenRequired || provided === OPERATOR_TOKEN;
  res.json({ tokenRequired, authenticated });
});

app.post('/api/agent/start', async (req, res) => {
  try {
    if (isKillSwitchLatched()) return res.status(409).json({ success: false, error: 'Kill switch is latched — restart the backend process to resume trading.' });
    const portfolio = await db.getPortfolio();
    if (portfolio.emergency_pause) return res.status(400).json({ success: false, error: 'Emergency pause is active. Resume first.' });
    await startAgent(); broadcastState(); res.json({ success: true });
  } catch (e) {
    const code = e.code === 'KILL_SWITCH_LATCHED' ? 409 : 500;
    res.status(code).json({ success: false, error: e.message });
  }
});

app.post('/api/agent/stop', async (req, res) => {
  await stopAgent(); broadcastState(); res.json({ success: true });
});

app.post('/api/agent/run-now', async (req, res) => {
  try {
    if (isKillSwitchLatched()) return res.status(409).json({ success: false, error: 'Kill switch is latched — restart the backend process to resume trading.' });
    const portfolio = await db.getPortfolio();
    if (portfolio.emergency_pause) return res.status(400).json({ success: false, error: 'Emergency pause active' });
    if (!portfolio.agent_running) await db.updatePortfolio({ agent_running: true });
    await runCycle(); broadcastState(); res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/agent/emergency-pause', async (req, res) => {
  await emergencyPause(true); broadcastState(); res.json({ success: true });
});
app.post('/api/agent/resume', async (req, res) => {
  await emergencyPause(false); broadcastState(); res.json({ success: true });
});
app.post('/api/agent/reset-circuit-breaker', async (req, res) => {
  await resetCircuitBreaker('operator-dashboard'); broadcastState(); res.json({ success: true });
});
// Toggle the auto-reset-at-daily-roll behaviour. Only effective in paper mode;
// live mode NEVER auto-resets a tripped breaker.
app.post('/api/agent/breaker-auto-reset', async (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: 'enabled (boolean) required' });
    await setAutoBreakerReset(enabled);
    broadcastState();
    res.json({ success: true, enabled });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/agent/flatten', async (req, res) => {
  try { await flattenAllPositions(req.body?.reason || 'Manual flatten via dashboard'); broadcastState(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// --- Phase 4: kill switch & operator emergency controls ---------------------
// Cancel every open Alpaca order without touching positions. Useful when an
// operator wants to halt new fills mid-cycle but keep current positions
// (e.g. to take manual control before flattening).
app.post('/api/agent/cancel-orders', async (req, res) => {
  try {
    const out = await cancelAllOpenOrders(req.body?.reason || 'Operator cancel-all-orders');
    broadcastState();
    res.json({ success: true, ...out });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Kill switch — destructive cascade. Requires operator token (already enforced
// for all POST /api/agent/* via the global middleware) AND a body double-
// confirmation: { confirm: "KILL", reason?: string }. The double-confirm
// matches the existing live-mode pattern and prevents an accidental fat-finger
// from nuking the book. Quorum, gates, sizing, and hedging logic are
// untouched — this only halts the agent and clears positions.
app.post('/api/agent/kill-switch', async (req, res) => {
  try {
    const { confirm, reason, actor } = req.body || {};
    if (confirm !== 'KILL') {
      return res.status(400).json({
        success: false,
        error: 'Kill switch requires confirm: "KILL" in the request body',
      });
    }
    const out = await killSwitch({
      reason: reason || 'Operator kill switch via dashboard',
      actor: actor || 'operator',
    });
    broadcastState();
    res.json({ success: true, result: out });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// --- Phase 4: compliance / regulatory audit reporting -----------------------
// GET /api/audit/report?date=YYYY-MM-DD&format=json|csv
//   Returns a structured day report: trades + risk events + blocked decisions
//   + hash-chain verification, joined to the SIGNAL audit row that decided
//   each trade so the model ensemble is recorded per execution. CSV is a
//   regulator-friendly flat trade sheet with summary footer.
// Operator-token gated (read of audit data may include strategy reasoning).
app.get('/api/audit/report', requireOperator, async (req, res) => {
  try {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    const report = await complianceService.buildReport(date);
    if ((req.query.format || 'json').toLowerCase() === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-report-${date}.csv"`);
      return res.send(complianceService.reportToCSV(report));
    }
    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/audit/verify[?since=YYYY-MM-DD]
//   Walks the hash-chain forward and confirms each row_hash matches
//   sha256(prev_hash || canonical body). Returns { ok, total, verified,
//   legacy, brokenAt[] }. Tampering or schema drift surfaces here.
app.get('/api/audit/verify', requireOperator, async (req, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since + 'T00:00:00Z') : null;
    if (since && Number.isNaN(since.getTime())) return res.status(400).json({ error: 'since must be YYYY-MM-DD' });
    res.json(await db.verifyAuditChain({ since }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/strategy/:name/toggle', async (req, res) => {
  try {
    const { name } = req.params;
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: 'enabled boolean required' });
    await setStrategyEnabled(name, enabled);
    broadcastState();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/agent/risk-scale', async (req, res) => {
  try {
    const { scale } = req.body || {};
    await setRiskScale(scale);
    broadcastState();
    res.json({ success: true, scale });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post('/api/agent/trading-mode', async (req, res) => {
  try {
    const { mode, confirm } = req.body || {};
    if (mode === 'live' && confirm !== 'I_UNDERSTAND_LIVE') {
      return res.status(400).json({ success: false, error: 'Switching to LIVE requires confirm: "I_UNDERSTAND_LIVE"' });
    }
    await setTradingMode(mode);
    broadcastState();
    res.json({ success: true, mode });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.get('/api/trades', async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit) || 50);
  const market = String(req.query.market || '').toUpperCase();
  let rows = await db.getRecentTrades(limit);
  if (market === 'US' || market === 'ASX') {
    // Prefer the row's stored `market` (recorded at trade time, even if the
    // registry changes later); fall back to symbol lookup for legacy rows.
    rows = rows.filter(t => (t.market || marketOf(t.symbol)) === market);
  }
  res.json(rows);
});

app.get('/api/audit', async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit) || 50);
  const market = String(req.query.market || '').toUpperCase();
  let rows = await db.getRecentAudit(limit);
  if (market === 'US' || market === 'ASX') {
    // Audit rows aren't market-tagged at the column level; derive from symbol.
    // System-wide events without a symbol (e.g. CIRCUIT_BREAKER_TRIPPED) are
    // kept under both filters so operators never lose sight of platform state.
    rows = rows.filter(r => !r.symbol || marketOf(r.symbol) === market);
  }
  res.json(rows);
});

// --- Backtest engine ---------------------------------------------------------
// POST /api/backtest         — run a backtest with the given params (gated)
// GET  /api/backtest/recent  — list recent runs (no body)
// GET  /api/backtest/:id     — full run incl. equity curve + trades
const backtestService = require('./services/backtestService');
const adaptiveLearning = require('./services/adaptiveLearningService');
const mlAdaptive = require('./services/mlAdaptiveService');
const metaLearning = require('./services/metaLearningService');
const knowledgeGraph = require('./services/knowledgeGraphService');
const rlExecution = require('./services/rlExecutionService');
const optionsFlowService = require('./services/optionsFlowService');
const macroForecastService = require('./services/macroForecastService');
const scenarioSimService = require('./services/scenarioSimService');
const llmWeightingService = require('./services/llmWeightingService');
const causalInferenceService = require('./services/causalInferenceService');
const counterfactualService = require('./services/counterfactualService');
const safetySuggestionService = require('./services/safetySuggestionService');
const memoryService = require('./services/memoryService');
const propagationService = require('./services/propagationService');
const feedbackService = require('./services/feedbackService');
const strategyDiscoveryService = require('./services/strategyDiscoveryService');
const marketPretrainService = require('./services/marketPretrainService');
const portfolioOpt = require('./services/portfolioOptimizationService');
const hedgingService = require('./services/hedgingService');

// Strict gate for expensive endpoints — refuses entirely when OPERATOR_TOKEN
// is unset, so a misconfigured deploy can never expose cost-amplifying jobs.
function requireOperatorStrictGate(req, res, next) {
  if (!OPERATOR_TOKEN) return res.status(403).json({ error: 'This endpoint requires OPERATOR_TOKEN to be configured on the server.' });
  const provided = req.get('x-operator-token') || req.query.token;
  if (provided !== OPERATOR_TOKEN) return res.status(401).json({ error: 'Operator token required' });
  next();
}

let backtestInFlight = false;
app.post('/api/backtest', requireOperatorStrictGate, async (req, res) => {
  if (backtestInFlight) return res.status(429).json({ error: 'A backtest is already running. Try again in a moment.' });
  backtestInFlight = true;
  try {
    // Constrain symbols to the combined US+ASX watchlist (prevents arbitrary-
    // symbol cost-DoS). An optional `market` filter further narrows the
    // allowed set so the dashboard's market chips can scope a backtest.
    // Accept market scope from either body or query string so the dashboard
    // chip and direct API users (curl/scripts) both work.
    const market = String(req.body?.market || req.query?.market || '').toUpperCase();
    let allowedList = getCombinedWatchlist();
    if (market === 'US' || market === 'ASX') {
      allowedList = allowedList.filter(s => marketOf(s) === market);
    }
    const allowed = new Set(allowedList);
    const requested = Array.isArray(req.body?.symbols) ? req.body.symbols.map(s => String(s).toUpperCase()) : null;
    const symbols = requested ? requested.filter(s => allowed.has(s)) : [...allowed].slice(0, 5);
    if (!symbols.length) return res.status(400).json({ error: 'No valid symbols (must be in watchlist)' });

    const params = {
      symbols,
      lookbackDays: Math.max(30, Math.min(1000, parseInt(req.body?.lookbackDays) || 365)),
      startCash:    Math.max(1000, Math.min(10_000_000, parseFloat(req.body?.startCash) || 100000)),
      slippageBps:  Math.max(0, Math.min(200, parseFloat(req.body?.slippageBps ?? 5))),
      commissionUSD:Math.max(0, Math.min(20, parseFloat(req.body?.commissionUSD ?? 1))),
      rsiBuyMax:    Math.max(20, Math.min(80, parseFloat(req.body?.rsiBuyMax ?? 55))),
      rsiSellMin:   Math.max(40, Math.min(95, parseFloat(req.body?.rsiSellMin ?? 70))),
      stopLossPct:  Math.max(0.005, Math.min(0.25, parseFloat(req.body?.stopLossPct ?? 0.04))),
      takeProfitPct:Math.max(0.01, Math.min(1.0, parseFloat(req.body?.takeProfitPct ?? 0.10))),
      trailingStopPct: Math.max(0.005, Math.min(0.5, parseFloat(req.body?.trailingStopPct ?? 0.06))),
      maxPositionPct:  Math.max(0.01, Math.min(1.0, parseFloat(req.body?.maxPositionPct ?? 0.20))),
      requireUptrend: req.body?.requireUptrend !== false,
    };
    const result = await backtestService.runBacktest(params);
    res.json(result);
  } catch (e) {
    console.error('[Backtest] error:', e);
    res.status(500).json({ error: e.message });
  } finally { backtestInFlight = false; }
});
app.get('/api/backtest/recent', async (_req, res) => res.json(await backtestService.getRecentRuns(20)));
app.get('/api/backtest/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const run = await backtestService.getRun(id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json(run);
});

// --- Adaptive learning + portfolio risk read endpoints ----------------------
// ML adaptive layer status — online-learned weights, training count, and
// calibration metrics (Brier score for the pWin head, RMSE for the R-multiple
// head). Read-only; safe for the dashboard to poll.
app.get('/api/adaptive/ml', async (_req, res) => {
  try { res.json(await mlAdaptive.getStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Regime-aware meta-learning track record — per-regime per-strategy closed
// trade counts, win rate, and avg R-multiple. Drives the conf-gate
// tightening + sizing nudge applied inside riskManager.evaluateBuy.
app.get('/api/regime/performance', async (_req, res) => {
  try { res.json(await metaLearning.getDashboardSummary()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Long-term company knowledge graph — slow-moving per-symbol context blob
// (sector + peers, earnings track, valuation, macro, major-event timeline).
//   GET /api/knowledge          → list of all symbols + freshness
//   GET /api/knowledge/:symbol  → full graph + rendered prompt summary
// Read-only; safe for the dashboard to poll.
app.get('/api/knowledge', async (_req, res) => {
  try { res.json({ rows: await knowledgeGraph.listAll(), refresh_ttl_hours: knowledgeGraph.REFRESH_TTL_HOURS }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// RL execution layer status — Q-table cells, per-action averages, top cells
// by visits. Read-only introspection for the dashboard / operator.
app.get('/api/rl/execution', async (_req, res) => {
  try { res.json(await rlExecution.getStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Quantitative options-flow snapshot for one symbol — chain stats (P/C ratio,
// IV avg, IV rank, IV skew) + unusual sweeps/blocks. Read-only; rejects
// symbols outside the combined US+ASX whitelist (ASX has no chain).
app.get('/api/options-flow/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const allow = new Set(getCombinedWatchlist());
    if (!allow.has(symbol)) return res.status(403).json({ error: 'symbol_not_in_watchlist' });
    // Use raw read here so the introspection endpoint can show the last-known
    // snapshot with a `_stale` flag even after TTL expires. The prompt path
    // (agent.js) uses TTL-enforced getCached and will not inject stale data.
    const cached = optionsFlowService.getCachedRaw(symbol);
    if (!cached) return res.status(404).json({ error: 'no_cached_flow', hint: 'cache warms ~60s after boot, then refreshes every 30 min during US market hours' });
    res.json({ ...cached, prompt: optionsFlowService.renderForPrompt(cached) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Macro-forecast introspection — current cross-asset regime + 24-48h forecast
// + the safety-preserving adjustments the agent is applying. Global (no
// symbol param). Returns the raw cached snapshot with a _stale flag so the
// dashboard can surface freshness; the prompt path uses TTL-enforced reads.
app.get('/api/macro-forecast', async (_req, res) => {
  try {
    const cached = macroForecastService.getCachedRaw();
    if (!cached) return res.status(404).json({ error: 'no_macro_forecast', hint: 'warms ~75s after boot, refreshes every 60 min during US market hours' });
    res.json({ ...cached, prompt: macroForecastService.renderForPrompt(cached) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dynamic LLM ensemble-weighting introspection. Returns the current weight
// table for a (strategy, regime, market) context plus a summary of how many
// context buckets we have data for. Read-only.
app.get('/api/llm-weights', async (req, res) => {
  try {
    const strategy = String(req.query.strategy || 'day');
    const regime = String(req.query.regime || 'unknown');
    const market = String(req.query.market || 'US').toUpperCase();
    const [snap, summary] = await Promise.all([
      llmWeightingService.getWeights({ strategy, regime: { primary: regime }, market }),
      llmWeightingService.getDashboardSummary(),
    ]);
    res.json({ ...snap, summary, prompt: llmWeightingService.renderForPrompt(snap) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Continuous online learning dashboard. Live per-bar calibration metrics:
// per-model brier score + ECE, calibration curves (predicted-bin vs observed
// frequency), current weight-delta state, regime-threshold drift, tick
// counters. Strictly read-only. The underlying layer cannot bypass any
// existing safety check — see continuousLearningService.js header.
// [Data Depth] Earnings-transcript introspection — most-recent quarterly
// call summary (tone, guidance, capex/buyback, surprises, forward catalysts).
// Read-only; symbol must be in the combined watchlist. Returns the cached
// JSON payload + the rendered prompt block for parity with other endpoints.
app.get('/api/earnings-transcript/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const allow = new Set(getCombinedWatchlist());
    if (!allow.has(symbol)) return res.status(403).json({ error: 'symbol_not_in_watchlist' });
    // [Data Depth] US-only contract: earnings transcripts are sourced via Grok
    // and we don't have ASX coverage. Reject ASX symbols here so an ad-hoc
    // dashboard hit can't drive unintended XAI quota usage.
    try {
      if (marketRegistry.getSymbolInfo(symbol).market !== 'US') {
        return res.status(400).json({ error: 'us_only', hint: 'earnings transcript service does not cover ASX' });
      }
    } catch (_) { return res.status(400).json({ error: 'unknown_symbol' }); }
    const earningsTranscriptService = require('./services/earningsTranscriptService');
    // Use getOrRefresh so an on-demand call hits Grok if cache is empty/stale.
    const data = await earningsTranscriptService.getOrRefresh(symbol);
    if (!data) return res.status(404).json({ error: 'no_transcript', hint: 'XAI key required + first refresh ~2 min after boot' });
    res.json({ symbol, ...data, prompt: earningsTranscriptService.renderForPrompt(data) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [Data Depth] Composite per-symbol data-depth view — bundles the four new
// signal layers (enhanced order flow, expanded options-chain analytics,
// earnings transcript summary, expanded macro composites) for one ticker.
// Read-only; intended for the dashboard so users can see exactly what new
// context the LLMs are now seeing. Falls back gracefully on any missing
// layer (returns null for that block; never 500s on partial coverage).
app.get('/api/data-depth/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const allow = new Set(getCombinedWatchlist());
    if (!allow.has(symbol)) return res.status(403).json({ error: 'symbol_not_in_watchlist' });
    const orderFlowService = require('./services/orderFlowService');
    const optionsFlowService = require('./services/optionsFlowService');
    const earningsTranscriptService = require('./services/earningsTranscriptService');
    const macroFactorService = require('./services/macroFactorService');
    const alpacaService = require('./services/alpacaService');
    let orderFlow = null;
    try {
      const bars = await alpacaService.getBars(symbol, '1Min', 30);
      if (Array.isArray(bars) && bars.length >= 25) orderFlow = orderFlowService.analyzeOrderFlow(bars);
    } catch (_) {}
    const optsRaw = optionsFlowService.getCachedRaw(symbol);
    const optionsDepth = optsRaw ? {
      contracts: optsRaw.contracts, ivAvg: optsRaw.ivAvg, ivRank: optsRaw.ivRank,
      ivSkew: optsRaw.ivSkew,
      ivFront: optsRaw.ivFront, ivMid: optsRaw.ivMid, ivBack: optsRaw.ivBack,
      ivTermSlope: optsRaw.ivTermSlope, ivTermLabel: optsRaw.ivTermLabel,
      gammaExposureProxy: optsRaw.gammaExposureProxy, gexLabel: optsRaw.gexLabel,
      pcrRank: optsRaw.pcrRank, pcrSamples: optsRaw.pcrSamples,
      unusual: optsRaw.unusual, _stale: optsRaw._stale,
    } : null;
    let transcript = null;
    try {
      const tx = earningsTranscriptService.getCached(symbol);
      if (tx) transcript = { ...tx, _prompt: earningsTranscriptService.renderForPrompt(tx) };
    } catch (_) {}
    let macro = null;
    try {
      const m = macroFactorService.getCached();
      if (m) macro = {
        composites: m.composites,
        depthAdditions: {
          hyIgSpread5d: m.composites?.hyIgSpread5d,
          btcRet5d: m.composites?.btcRet5d,
          curveChg1d: m.composites?.curveChg1d,
        },
        ts: m.ts,
      };
    } catch (_) {}
    res.json({
      symbol,
      ts: Date.now(),
      orderFlow: orderFlow?.ok ? {
        cumDelta: orderFlow.cumDelta, cumDeltaSlope: orderFlow.cumDeltaSlope,
        cumDeltaLabel: orderFlow.cumDeltaLabel,
        confirmedSweeps: orderFlow.confirmedSweeps,
        vpin: orderFlow.vpin, vpinLabel: orderFlow.vpinLabel,
        vwap: orderFlow.vwap, vwapDevPct: orderFlow.vwapDevPct,
        description: orderFlow.description,
      } : null,
      optionsDepth,
      earningsTranscript: transcript,
      macro,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [Capital & Risk Capacity / Upgrade #3] Portfolio-level VaR + stress-test +
// dynamic-hedging snapshot. Strictly read-only; the underlying layers cannot
// bypass any existing safety check. Returns the fresh refresh on demand if
// no cache is present yet. The dynamic-hedging block is computed on-the-fly
// off the same VaR snapshot so the two are always self-consistent.
app.get('/api/risk-capacity', async (_req, res) => {
  try {
    const varStressService = require('./services/varStressService');
    const dynamicHedgingService = require('./services/dynamicHedgingService');
    const macroForecastService = require('./services/macroForecastService');
    const riskManager = require('./services/riskManager');
    const db = require('./services/db');
    let varSnap = varStressService.getCachedRaw();
    let hedgeSnap = dynamicHedgingService.getCachedRaw();
    if (!varSnap || varSnap._stale) {
      // Fall back to an on-demand refresh so the dashboard isn't empty pre-warmup.
      const allH = await db.getHoldings();
      const agent = require('./agent');
      const pmap = await agent.buildPriceLookup(allH);
      const { equity, portfolio } = await riskManager.computeEquity(allH, pmap.usdLookup);
      const dailyLossBudget = riskManager.effectiveDailyLossBudget(portfolio);
      varSnap = await varStressService.refresh(allH, pmap.usdLookup, equity, dailyLossBudget);
      const macroData = macroForecastService.getCachedRaw?.();
      const macroRegime = macroData?.current?.regime || macroData?.regime || null;
      const dayStart = parseFloat(portfolio?.day_start_equity || equity);
      const realisedLossUSD = Math.max(0, dayStart - equity);
      const lossUtil = dailyLossBudget > 0 ? +(realisedLossUSD / dailyLossBudget * 100).toFixed(1) : null;
      hedgeSnap = await dynamicHedgingService.refresh(allH, pmap.usdLookup, varSnap, macroRegime, lossUtil);
    }
    res.json({
      ts: Date.now(),
      varStress: varSnap,
      dynamicHedging: hedgeSnap,
      varPrompt: varStressService.renderForPrompt(varSnap),
      hedgingPrompt: dynamicHedgingService.renderForPrompt(hedgeSnap),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [Capital & Risk Capacity] Per-symbol liquidity profile — ADV (shares + USD),
// spread proxy in bps, prudent max position size at 0.5% of $ADV. Whitelist-
// gated. Read-only and advisory; the existing riskManager sizing math
// (`evaluateBuy()`) is unchanged and retains full control over the actual
// quantity executed.
app.get('/api/liquidity/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const allow = new Set(getCombinedWatchlist());
    if (!allow.has(symbol)) return res.status(403).json({ error: 'symbol_not_in_watchlist' });
    const liquidityService = require('./services/liquidityService');
    const data = await liquidityService.getOrRefresh(symbol);
    if (!data?.ok) return res.status(404).json({ error: data?.reason || 'unavailable', symbol });
    const proposedUSDRaw = req.query.proposedUSD ? Number(req.query.proposedUSD) : null;
    const proposedUSD = Number.isFinite(proposedUSDRaw) && proposedUSDRaw > 0 ? proposedUSDRaw : null;
    res.json({ ...data, prompt: liquidityService.renderForPrompt(data, proposedUSD) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [Upgrade #4 / Scale & Speed] Performance + health observability.
// Read-only. Reports cycle timing percentiles, strategy timings, bar-cache
// hit rates, LLM ensemble call/skip counters, watchdog state, memory usage,
// and process uptime. Pass `?reset=1` to zero the counters for a fresh
// measurement window (does NOT reset cycle history).
app.get('/api/perf', (req, res) => {
  try {
    const agent = require('./agent');
    const brokerRouter = require('./services/brokerRouter');
    const m = agent.perfMetrics || {};
    const pct = (arr, p) => {
      if (!arr || !arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      const i = Math.min(s.length - 1, Math.floor(p / 100 * s.length));
      return s[i];
    };
    const stratStats = {};
    for (const [name, arr] of Object.entries(m.strategyDurationsMs || {})) {
      stratStats[name] = {
        samples: arr.length,
        p50Ms: pct(arr, 50), p95Ms: pct(arr, 95), maxMs: arr.length ? Math.max(...arr) : null,
      };
    }
    const cycleStats = {
      total: m.cycles,
      lastMs: m.lastCycleMs,
      lastStartedAt: m.lastCycleStartedAt ? new Date(m.lastCycleStartedAt).toISOString() : null,
      lastFinishedAt: m.lastCycleFinishedAt ? new Date(m.lastCycleFinishedAt).toISOString() : null,
      samples: (m.cycleDurationsMs || []).length,
      p50Ms: pct(m.cycleDurationsMs, 50),
      p95Ms: pct(m.cycleDurationsMs, 95),
      maxMs: (m.cycleDurationsMs || []).length ? Math.max(...m.cycleDurationsMs) : null,
    };
    const ensembleStats = {
      called: m.ensembleCalls || 0,
      skippedByCache: m.ensembleSkipped || 0,
      skipRatePct: (m.ensembleCalls + m.ensembleSkipped) > 0
        ? +(m.ensembleSkipped / (m.ensembleCalls + m.ensembleSkipped) * 100).toFixed(1) : 0,
    };
    const mem = process.memoryUsage();
    const payload = {
      ts: Date.now(),
      uptime: { processSec: Math.round(process.uptime()), agentSec: m.startedAt ? Math.round((Date.now() - m.startedAt) / 1000) : null },
      cycle: cycleStats,
      strategies: stratStats,
      ensemble: ensembleStats,
      barCache: brokerRouter.getBarCacheMetrics(),
      watchdog: { resets: m.watchdogResets || 0 },
      memory: { rssMB: +(mem.rss / 1024 / 1024).toFixed(1), heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(1) },
      node: { version: process.version, pid: process.pid },
    };
    if (req.query.reset === '1') {
      brokerRouter.resetBarCacheMetrics();
      m.ensembleCalls = 0; m.ensembleSkipped = 0;
      payload.reset = true;
    }
    res.json(payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/continuous-learning/dashboard', async (_req, res) => {
  try {
    const continuousLearning = require('./services/continuousLearningService');
    res.json(await continuousLearning.getDashboard());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Causal-inference graph introspection. Returns the per-(strategy, regime,
// market) graph of feature → outcome edges (lift on win-rate, sample sizes,
// confidence tier, spurious filter). Read-only.
app.get('/api/causal-insights', async (req, res) => {
  try {
    const strategy = String(req.query.strategy || 'day');
    const regime = String(req.query.regime || 'unknown');
    const market = String(req.query.market || 'US').toUpperCase();
    const [graph, summary] = await Promise.all([
      causalInferenceService.getGraph({ strategy, regime: { primary: regime }, market }),
      causalInferenceService.getDashboardSummary(),
    ]);
    res.json({
      strategy, regime, market,
      graph: graph || null,
      prompt: causalInferenceService.renderForPrompt(graph),
      summary,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Counterfactual-replay introspection. Returns the per-(strategy, regime,
// market) results for the canned decision-rule counterfactuals (tighter
// confidence gate, stricter quorum, skip adverse regimes, etc.). Read-only.
app.get('/api/counterfactuals', async (req, res) => {
  try {
    const strategy = String(req.query.strategy || 'day');
    const regime = String(req.query.regime || 'unknown');
    const market = String(req.query.market || 'US').toUpperCase();
    const [bucket, summary] = await Promise.all([
      counterfactualService.getResults({ strategy, regime: { primary: regime }, market }),
      counterfactualService.getDashboardSummary(),
    ]);
    res.json({
      strategy, regime, market,
      bucket: bucket || null,
      prompt: counterfactualService.renderForPrompt(bucket),
      summary,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Intelligent Safety Suggestion Layer — list pending, list recent (history),
// trigger a re-mine, apply, reject. Every apply / reject writes an audit row
// (SUGGEST_APPLY / SUGGEST_REJECT — short to fit varchar(16)). Apply NEVER auto-fires; the
// user must POST explicitly. The applier dispatches via a hard-coded
// whitelist inside the service — unknown kinds are refused before any
// state writer runs.
app.get('/api/safety-suggestions', async (_req, res) => {
  try {
    const summary = await safetySuggestionService.getDashboardSummary();
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/safety-suggestions/recent', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const recent = await safetySuggestionService.listRecent(limit);
    res.json({ count: recent.length, suggestions: recent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/safety-suggestions/refresh', requireOperator, async (_req, res) => {
  try {
    const portfolio = await db.getPortfolio();
    const strategies = listStrategies(portfolio?.risk_scale || DEFAULT_RISK_SCALE)
      .map(s => ({
        name: s.name, label: s.label,
        enabled: s.name === 'day' ? !!portfolio?.day_enabled
               : s.name === 'swing' ? !!portfolio?.swing_enabled
               : s.name === 'asx_swing' ? !!portfolio?.asx_swing_enabled
               : false,
      }));
    const result = await safetySuggestionService.refresh({ force: true, portfolio, strategies });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/safety-suggestions/:id/apply', requireOperator, async (req, res) => {
  try {
    const decided_by = String(req.body?.decided_by || 'user');
    const applied = await safetySuggestionService.applySuggestion(req.params.id, {
      decided_by,
      applierFns: _safetyApplierFns,
    });
    broadcastState();
    res.json({ success: true, applied });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post('/api/safety-suggestions/:id/reject', requireOperator, async (req, res) => {
  try {
    const decided_by = String(req.body?.decided_by || 'user');
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : null;
    const rejected = await safetySuggestionService.rejectSuggestion(req.params.id, { decided_by, reason });
    res.json({ success: true, rejected });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// Long-Term Memory & Experience Replay introspection. Read-only summary of
// the in-memory cache plus an optional filtered slice (by strategy/regime/
// market). Operator-gated POST /refresh forces a backfill scan for any
// closed trades not yet indexed. Strictly informational endpoint — no way
// to mutate trade_memory rows from the API surface.
app.get('/api/memory', async (req, res) => {
  try {
    const summary = await memoryService.getDashboardSummary({
      strategy: req.query.strategy || null,
      regime: req.query.regime || null,
      market: req.query.market || null,
      limit: Math.min(parseInt(req.query.limit) || 50, 200),
    });
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/memory/refresh', requireOperator, async (_req, res) => {
  try {
    const r = await memoryService.backfill({ force: true });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cross-Market & Sector Propagation introspection. Read-only summary of
// current per-bucket pulses + top mined propagation edges. Operator-gated
// POST /refresh forces a full re-mine.
app.get('/api/propagation', async (_req, res) => {
  try { res.json(await propagationService.getDashboardSummary()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/propagation/refresh', requireOperator, async (_req, res) => {
  try {
    const r = await propagationService.refresh({ force: true });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Human-in-the-Loop Feedback endpoints. POST /api/trades/:id/feedback is
// USER-FACING (not operator-gated) — operators rate their own trades from
// the dashboard. Read endpoints are also public; calibration is purely
// informational and fed into the prompt block + bounded confidence
// shrinkage factor (see feedbackService for the safety contract).
//
// Rate-limit: simple per-IP token bucket — caps poisoning of the calibration
// signal by a malicious or runaway client. 30 writes/hour per IP is far above
// any legitimate single-operator dashboard usage.
const _feedbackRate = new Map();   // ip -> { tokens, last }
const FEEDBACK_RATE_MAX = 30, FEEDBACK_RATE_WINDOW_MS = 60 * 60 * 1000;
function _feedbackRateOk(ip) {
  const now = Date.now();
  let b = _feedbackRate.get(ip);
  if (!b) { b = { tokens: FEEDBACK_RATE_MAX, last: now }; _feedbackRate.set(ip, b); }
  // Refill proportionally to elapsed window.
  const refill = (now - b.last) / FEEDBACK_RATE_WINDOW_MS * FEEDBACK_RATE_MAX;
  b.tokens = Math.min(FEEDBACK_RATE_MAX, b.tokens + refill);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
app.post('/api/trades/:id/feedback', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!_feedbackRateOk(ip)) return res.status(429).json({ ok: false, error: 'rate limit exceeded' });
  try {
    const { rating, comment } = req.body || {};
    const out = await feedbackService.recordFeedback({ tradeId: req.params.id, rating, comment });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get('/api/feedback/recent', async (req, res) => {
  try { res.json({ rows: await feedbackService.recentFeedback({ limit: req.query.limit }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/feedback/calibration', async (_req, res) => {
  try { res.json(await feedbackService.getDashboardSummary()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Automated Strategy Discovery endpoints. Read endpoints are public; mutate
// endpoints (apply / dismiss / revert / force-refresh) are operator-gated
// because they CHANGE live trading behaviour (overlay-applied trades will
// be downgraded BUY→HOLD).
app.get('/api/strategy-proposals', async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    res.json({ rows: await strategyDiscoveryService.getProposals({ status, limit: req.query.limit }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/strategy-discovery/summary', async (_req, res) => {
  try { res.json(await strategyDiscoveryService.getDashboardSummary()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/strategy-proposals/:id/apply', requireOperator, async (req, res) => {
  try { res.json(await strategyDiscoveryService.applyProposal({ id: req.params.id })); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/strategy-proposals/:id/dismiss', requireOperator, async (req, res) => {
  try { res.json(await strategyDiscoveryService.dismissProposal({ id: req.params.id })); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete('/api/strategy-overlays/:id', requireOperator, async (req, res) => {
  try { res.json(await strategyDiscoveryService.revokeOverlay({ id: req.params.id })); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/strategy-discovery/refresh', requireOperator, async (_req, res) => {
  try { res.json({ ok: true, ...(await strategyDiscoveryService.refresh({ force: true })) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Self-Supervised Market Pre-Training endpoints. GET is public (read-only
// summary of learned codewords + last-pretrain meta). POST /refresh is
// operator-gated because it triggers many Alpaca API calls (paginated
// multi-year daily bars per symbol) and rewrites the codeword table.
app.get('/api/market-pretrain/summary', async (_req, res) => {
  try { res.json(await marketPretrainService.getSummary()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/market-pretrain/refresh', requireOperator, async (_req, res) => {
  try { res.json({ ok: true, ...(await marketPretrainService.runPretraining({ force: true })) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Self-play scenario simulation introspection — per-symbol probabilistic
// 1-3d outlook (Monte-Carlo paths combining regime + macro + IV + recent
// price action). Read-only; rejects non-watchlist symbols.
app.get('/api/scenario-sim/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const allow = new Set(getCombinedWatchlist());
    if (!allow.has(symbol)) return res.status(403).json({ error: 'symbol_not_in_watchlist' });
    const cached = scenarioSimService.getCachedRaw(symbol);
    if (!cached) return res.status(404).json({ error: 'no_cached_sim', hint: 'cached on the next per-symbol cycle (60s for day strategy, 300s for swing)' });
    res.json({ ...cached, prompt: scenarioSimService.renderForPrompt(cached) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/knowledge/:symbol', async (req, res) => {
  try {
    const g = await knowledgeGraph.getGraph(req.params.symbol);
    if (!g) return res.status(404).json({ error: 'not_found' });
    res.json(g);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/adaptive/performance', async (_req, res) => {
  try { res.json(await adaptiveLearning.getDashboardSummary()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// In-flight mutex + 60s cooldown — adaptive recompute scans up to ~2000 closed
// trades and joins each to a SIGNAL audit row, so it must not be flooded.
let adaptiveRecomputeInFlight = false;
let lastAdaptiveRecomputeAt = 0;
const ADAPTIVE_RECOMPUTE_COOLDOWN_MS = 60_000;
// =============================================================================
// Daily performance report — manual trigger (auto-runs nightly at 21:30 UTC).
// Operator-gated; fully idempotent (UPSERTs the daily_performance row for the
// requested date). `sendDiscord=false` lets an operator preview the summary
// without firing the webhook.
// =============================================================================
const dailyPerformanceService = require('./services/dailyPerformanceService');
const { perfMetrics: agentPerfMetrics } = require('./agent');
app.post('/api/performance/daily', requireOperator, async (req, res) => {
  try {
    const tradingDate = req.body?.tradingDate || req.query?.tradingDate || null;
    const sendDiscord = req.body?.sendDiscord !== false && req.query?.sendDiscord !== 'false';
    const r = await dailyPerformanceService.runDailyPerformanceJob({
      tradingDate, perfMetrics: agentPerfMetrics, sendDiscord,
    });
    // Orchestrator never throws — surface its structured status verbatim.
    res.status(r.success ? 200 : 500).json(r);
  } catch (e) {
    console.error('[DailyPerf] Manual run failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/adaptive/recompute', requireOperatorStrictGate, async (req, res) => {
  if (adaptiveRecomputeInFlight) return res.status(429).json({ error: 'Adaptive recompute already running.' });
  const since = Date.now() - lastAdaptiveRecomputeAt;
  if (since < ADAPTIVE_RECOMPUTE_COOLDOWN_MS) {
    return res.status(429).json({ error: `Cooldown active. Try again in ${Math.ceil((ADAPTIVE_RECOMPUTE_COOLDOWN_MS - since) / 1000)}s.` });
  }
  adaptiveRecomputeInFlight = true;
  try {
    const out = await adaptiveLearning.recomputeFromHistory();
    lastAdaptiveRecomputeAt = Date.now();
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { adaptiveRecomputeInFlight = false; }
});
app.get('/api/portfolio/risk', async (_req, res) => {
  try {
    const holdings = await db.getHoldings();
    const symbols = [...new Set(holdings.map(h => h.symbol))];
    const snap = await portfolioOpt.getPortfolioSnapshot(symbols);
    const hedge = holdings.length >= 2 ? await hedgingService.getPortfolioRisk(holdings) : null;
    res.json({ snap, hedge, holdings: holdings.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/account', async (req, res) => { res.json(await alpacaService.getAccount()); });

// --- Charts: price bars per symbol -----------------------------------------
// GET /api/bars/:symbol?range=1d|5d → { symbol, range, timeframe, bars[], stale }
// 1d  → 5-min bars over the last ~3 trading days, trimmed to the most recent
//        ~78 bars (one full session). When market is closed this still returns
//        the prior session's data so the chart never goes blank.
// 5d  → 30-min bars over the last ~10 calendar days, trimmed to the latest ~70.
const BARS_CACHE = new Map(); // key=`${sym}:${range}` → {ts, data}
const BARS_TTL_MS = 30000;
app.get('/api/bars/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const range = (req.query.range || '1d').toLowerCase();
    if (!['1d', '5d'].includes(range)) return res.status(400).json({ error: 'range must be 1d or 5d' });
    const allowed = new Set(getCombinedWatchlist());
    if (!allowed.has(symbol)) return res.status(404).json({ error: 'Symbol not in watchlist' });

    const cacheKey = `${symbol}:${range}`;
    const cached = BARS_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.ts < BARS_TTL_MS) return res.json(cached.data);

    // Route via the broker router so ASX symbols come from IBKR. Returns the
    // same {t,o,h,l,c,v} bar shape regardless of broker.
    const brokerGetBars = (sym, tf, lim, opts) => brokerRouter.getBars(sym, tf, lim, opts);

    // IEX free feed has a ~15-min delay, so cap end at 'now - 16min' to avoid
    // SIP-only subscription errors.
    const endDate = new Date(Date.now() - 16 * 60 * 1000);
    const lookbackDays = range === '1d' ? 4 : 10;
    const startDate = new Date(endDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const cfg = range === '1d'
      ? { timeframe: '5Min', limit: 1000, take: 78 }
      : { timeframe: '30Min', limit: 1000, take: 70 };

    const allBars = await brokerGetBars(symbol, cfg.timeframe, cfg.limit, {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    });
    const bars = allBars.slice(-cfg.take);
    const stale = bars.length === 0;
    const data = {
      symbol, range, timeframe: cfg.timeframe, bars, stale,
      lastBarAt: bars.length ? bars[bars.length - 1].t : null,
    };
    BARS_CACHE.set(cacheKey, { ts: Date.now(), data });
    res.json(data);
  } catch (e) {
    console.error('[Bars] error:', e.message);
    res.status(500).json({ error: e.message, bars: [] });
  }
});

// --- News sentiment per symbol --------------------------------------------
// Symbol must be in the active watchlist (prevents arbitrary-symbol cost-DoS
// against Grok). `force=1` requires the operator token, since it bypasses the
// TTL cache and triggers a fresh upstream call.
app.get('/api/sentiment/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const allowed = new Set(getCombinedWatchlist());
    if (!allowed.has(symbol)) {
      return res.status(404).json({ error: 'Symbol not in watchlist' });
    }
    const force = req.query.force === '1';
    if (force) {
      if (!OPERATOR_TOKEN) return res.status(403).json({ error: 'force=1 requires OPERATOR_TOKEN configured' });
      const provided = req.get('x-operator-token') || req.query.token;
      if (provided !== OPERATOR_TOKEN) return res.status(401).json({ error: 'Operator token required for force=1' });
    }
    const data = await sentimentService.getSentiment(symbol, { force });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Combined market overview for the dashboard Markets tab ---------------
// Returns one card per watchlist symbol: latest price, % change, AI signal,
// confidence, and news sentiment. No bars (those load lazily per-symbol).
app.get('/api/markets', async (req, res) => {
  try {
    // Combined US + ASX watchlist. Each card is tagged with `market`/`currency`
    // so the dashboard can filter by market chip without re-deriving anything.
    const usWatch = getWatchlist().map(s => s.toUpperCase());
    const asxWatch = marketRegistry.getAsxWatchlist().map(s => s.toUpperCase());
    const watchlist = [...new Set([...usWatch, ...asxWatch])];
    const snap = await getAgentSnapshot();
    const sigs = snap.signals || {};
    const sents = sentimentService.getAllCached();

    // Lazy backfill: any watchlist symbol still uncached gets prefetched in
    // the background. The current request returns whatever's already in the
    // cache; the next 30s poll from MarketsTab will pick up the new entries.
    // Fire-and-forget — the Promise never blocks the response.
    const missing = watchlist.filter(s => !sents[s]);
    if (missing.length) {
      sentimentService.getSentimentBatch(missing, { concurrency: 3 })
        .catch(e => console.error('[Sentiment] Backfill error:', e.message));
    }

    // Latest price per symbol — single 1Min bar via brokerRouter so ASX symbols
    // come from IBKR. Failures (e.g. closed market, mock unavailable) just
    // surface as price=null, never as a 500.
    const prices = await Promise.all(watchlist.map(async sym => {
      try {
        const bars = await brokerRouter.getBars(sym, '1Min', 2);
        if (!bars?.length) return [sym, null];
        const c = bars[bars.length - 1].c;
        const prev = bars.length > 1 ? bars[bars.length - 2].c : c;
        return [sym, { price: c, changePct: prev ? +(((c - prev) / prev) * 100).toFixed(2) : 0 }];
      } catch { return [sym, null]; }
    }));
    const priceMap = Object.fromEntries(prices);

    // Pick the most recent signal per symbol across both strategies.
    const sigBySym = {};
    for (const [k, s] of Object.entries(sigs)) {
      const sym = k.split(':')[1] || s.symbol;
      const prev = sigBySym[sym];
      if (!prev || new Date(s.timestamp) > new Date(prev.timestamp)) sigBySym[sym] = s;
    }

    const cards = watchlist.map(sym => {
      const info = marketRegistry.getSymbolInfo(sym);
      return {
        symbol: sym,
        market: info.market,
        currency: info.currency,
        price: priceMap[sym]?.price ?? null,
        changePct: priceMap[sym]?.changePct ?? null,
        signal: sigBySym[sym] ? {
          consensus: sigBySym[sym].signal,
          confidence: sigBySym[sym].confidence,
          reason: sigBySym[sym].reason,
          strategy: sigBySym[sym].strategy,
          timestamp: sigBySym[sym].timestamp,
        } : null,
        sentiment: sents[sym] || null,
      };
    });

    res.json({
      watchlist, cards,
      usWatchlist: usWatch, asxWatchlist: asxWatch,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /api/companies — combined US + ASX universe with sector taxonomy + cached
// fundamentals (when available). Designed to render the Companies tab without
// any extra round-trips. Fundamentals come straight from the in-memory cache
// the swing strategy already populates — we never *force* a Grok fetch from
// here, so opening the tab is cheap (no upstream API calls).
app.get('/api/companies', async (req, res) => {
  try {
    const { COMPANIES, SECTORS, getCompanyInfo } = require('./services/sectors');
    const fundamentalsService = require('./services/fundamentalsService');

    const usWatch = getWatchlist().map(s => s.toUpperCase());
    const asxWatch = marketRegistry.getAsxWatchlist().map(s => s.toUpperCase());
    const watchlist = [...new Set([...usWatch, ...asxWatch])];

    // Pull whatever's already cached (no force=true). Swing-strategy symbols
    // will have richer data; intraday-only names just get the static catalog.
    const fundCache = typeof fundamentalsService.getCachedAll === 'function'
      ? fundamentalsService.getCachedAll()
      : {};

    const companies = watchlist.map(sym => {
      const info = marketRegistry.getSymbolInfo(sym);
      const meta = getCompanyInfo(sym) || { name: sym, sector: 'Other', industry: '—', description: 'No description available.' };
      const f = fundCache[sym] || null;
      return {
        symbol: sym,
        market: info.market,
        currency: info.currency,
        name: meta.name,
        sector: meta.sector,
        industry: meta.industry,
        description: meta.description,
        fundamentals: f ? {
          peRatio: f.pe_ratio ?? null,
          epsGrowthYoyPct: f.eps_growth_yoy_pct ?? null,
          revenueGrowthYoyPct: f.revenue_growth_yoy_pct ?? null,
          earningsNextDate: f.earnings_next_date ?? null,
          valuationLabel: f.valuation_label ?? null,
          sectorStrength30dPct: f.sector_strength_30d_pct ?? null,
          sectorStrengthLabel: f.sector_strength_label ?? null,
          fetchedAt: f.fetchedAt ?? null,
          stale: f.stale === true,
        } : null,
      };
    });

    res.json({
      sectors: SECTORS,
      companies,
      counts: {
        US: usWatch.length, ASX: asxWatch.length, total: watchlist.length,
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Pre-market briefing ---------------------------------------------------
// Latest stored briefing (today or earlier). Public read, no auth.
// Returns BOTH market briefings in one shot ({ us, asx }) so the dashboard can
// render them side-by-side without two round-trips. A `?market=US|ASX` query
// param narrows to a single briefing for legacy/curl clients.
app.get('/api/premarket/latest', async (req, res) => {
  try {
    const m = String(req.query.market || '').toUpperCase();
    if (m === 'US' || m === 'ASX') {
      const briefing = await premarketService.getLatestBriefing(m);
      return res.json(briefing || { empty: true, market: m });
    }
    const [us, asx] = await Promise.all([
      premarketService.getLatestBriefing('US'),
      premarketService.getLatestBriefing('ASX'),
    ]);
    return res.json({ us: us || null, asx: asx || null });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Legacy single-briefing route (US-only) kept under a versioned path so any
// outside scripts that hard-coded the v1 shape don't break silently.
app.get('/api/premarket/latest/v1', async (_req, res) => {
  try {
    const briefing = await premarketService.getLatestBriefing('US');
    res.json(briefing || { empty: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Force a fresh briefing run (operator-token gated by the global POST guard).
// Manual regenerate. `?market=US|ASX` (default US) so the dashboard's two
// briefing cards each get their own refresh button without colliding.
app.post('/api/agent/premarket-refresh', async (req, res) => {
  try {
    const market = String(req.query.market || req.body?.market || 'US').toUpperCase();
    if (market !== 'US' && market !== 'ASX') {
      return res.status(400).json({ ok: false, error: 'market must be US or ASX' });
    }
    const watchlist = market === 'ASX'
      ? marketRegistry.getAsxWatchlist()
      : getWatchlist();
    const result = await premarketService.runDailyBriefing(market, watchlist);
    res.json({ ...result, market });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/broker/voices', async (_req, res) => {
  try {
    const voices = await brokerService.listVoices();
    res.json({ voices, default: brokerService.DEFAULT_VOICE });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/broker/tts', async (req, res) => {
  try {
    const { text, voice, language } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    const out = await brokerService.synthesize({ text, voice, language });
    res.set('Content-Type', out.contentType);
    res.set('Cache-Control', 'no-store');
    res.set('X-Voice', out.voice);
    res.send(out.audio);
  } catch (e) {
    const msg = e.response?.data ? Buffer.from(e.response.data).toString('utf8') : e.message;
    console.error('[Server] TTS error:', msg);
    res.status(502).json({ error: msg });
  }
});

// Streaming voice pipeline:
//   1. Stream Grok tokens
//   2. As each sentence completes server-side, fire TTS in parallel
//   3. Push text deltas + audio chunks (base64 mp3, ordered by seq) over SSE
//   This lets the client start playing audio ~1s after user stops speaking,
//   while Grok is still generating the rest of the reply.
app.post('/api/broker/chat-stream', async (req, res) => {
  const t0 = Date.now();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx-style buffering
  res.flushHeaders?.();

  let closed = false;
  const send = (event, data) => {
    if (closed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { closed = true; }
  };
  const close = () => { try { res.end(); } catch {} };
  // NOTE: req.on('close') fires when the request body is consumed by express.json(),
  // not when the client disconnects. Use res.on('close') instead — fires on real
  // socket close.
  res.on('close', () => { closed = true; });

  try {
    const { messages, voice = true } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      send('error', { error: 'messages array required' }); return close();
    }

    const [snapshot, recentTrades, recentAudit] = await Promise.all([
      getAgentSnapshot(), db.getRecentTrades(10), db.getRecentAudit(20),
    ]);
    const recentSignals = Object.values(snapshot.signals || {});
    send('start', { voice, model: brokerService.GROK_MODEL });

    let textBuf = '';      // tokens since last sentence flush
    let seq = 0;
    let firstAudioMs = null;
    const ttsTasks = [];   // promises that resolve when audio is sent

    // Define kickOffTts FIRST so flushSentenceFromBuffer captures a valid binding.
    const kickOffTts = (text, final) => {
      const mySeq = seq++;
      const task = (async () => {
        try {
          const out = await brokerService.synthesize({ text });
          if (closed) return;
          const b64 = out.audio.toString('base64');
          if (firstAudioMs === null) {
            firstAudioMs = Date.now() - t0;
            send('timing', { firstAudioMs });
          }
          send('audio', { seq: mySeq, b64, contentType: out.contentType, text, final });
        } catch (e) {
          send('audio_error', { seq: mySeq, error: e.message });
        }
      })();
      ttsTasks.push(task);
    };

    // Sentence-flush strategy:
    //   - Hard boundaries: . ! ? … (always flush, with or without trailing space)
    //   - Soft boundaries: — ; (em-dash + semicolon) — flush if chunk is long enough
    //   - First-chunk only: , (comma) — flush early so the opening verdict
    //     ("No, hold off on NVDA") gets its own tiny TTS request and plays fast
    const flushSentenceFromBuffer = () => {
      // try hard sentence boundary first (with optional trailing whitespace)
      let m = textBuf.match(/[.!?…]/);
      let boundary = m ? m.index : -1;
      let consume = boundary + 1;
      if (boundary !== -1 && textBuf[boundary + 1] === ' ') consume = boundary + 2;

      // soft boundaries (em-dash, semicolon) — only if no period yet AND chunk ≥ 12 chars
      if (boundary === -1) {
        const soft = textBuf.match(/[—;]/);
        if (soft && soft.index >= 12) {
          boundary = soft.index;
          consume = boundary + 1;
        }
      }

      // first-chunk only: also accept comma if it gives us a tight verdict (2-25 chars).
      // Lower bound of 2 catches "No," / "Yes," — the most common decisive openings.
      if (boundary === -1 && seq === 0) {
        const c = textBuf.indexOf(',');
        if (c >= 2 && c <= 25 && textBuf.length > c + 1) {
          boundary = c;
          consume = c + 1;
        }
      }

      if (boundary === -1) return;
      const sentence = textBuf.slice(0, boundary + 1).trim();
      textBuf = textBuf.slice(consume).trimStart();
      if (sentence.length < 2) return;
      kickOffTts(sentence, /*final*/ false);
    };

    const result = await brokerService.chatStream(
      { messages, snapshot, recentSignals, recentTrades, voice },
      (delta) => {
        if (closed) return;
        send('delta', { text: delta });
        textBuf += delta;
        // Flush as soon as a boundary appears; loop in case multiple boundaries
        // arrived in a burst (rare with token-level streaming, but safe).
        let prevSeq;
        do {
          prevSeq = seq;
          if (textBuf.length > 6) flushSentenceFromBuffer();
        } while (seq !== prevSeq);
      }
    );

    // Flush any tail
    if (textBuf.trim()) kickOffTts(textBuf.trim(), true);

    const firstTokenMs = Date.now() - t0; // approximate; full text done time
    await Promise.allSettled(ttsTasks);
    send('done', {
      reply: result.reply,
      totalMs: Date.now() - t0,
      sentences: seq,
      firstAudioMs,
    });
    close();
  } catch (e) {
    console.error('[Server] chat-stream error:', e.message);
    send('error', { error: e.message });
    close();
  }
});

app.post('/api/broker/chat', async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages array required' });
    const [snapshot, recentTrades, recentAudit] = await Promise.all([
      getAgentSnapshot(), db.getRecentTrades(10), db.getRecentAudit(20),
    ]);
    const recentSignals = recentAudit
      .filter(a => a.event_type === 'SIGNAL')
      .map(a => ({ symbol: a.symbol, signal: a.decision, confidence: parseFloat(a.confidence) || 0 }))
      .slice(0, 8);
    const result = await brokerService.chat({ messages: messages.slice(-12), snapshot, recentSignals, recentTrades });
    res.json(result);
  } catch (e) { res.status(500).json({ reply: `Server error: ${e.message}`, error: true }); }
});

// --- Serve the built React frontend in production ------------------------
// In dev, Vite (port 5000) serves the UI and proxies /api + /ws to us.
// In prod, there is no Vite — we serve frontend/dist directly and add a
// SPA fallback so client-side routes (anything that isn't /api or /ws)
// return index.html.
const FRONTEND_DIST = path.resolve(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))) {
  app.use(express.static(FRONTEND_DIST, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/|ws($|\/)).*/, (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
  console.log(`[Server] Serving static frontend from ${FRONTEND_DIST}`);
} else {
  console.log(`[Server] No built frontend at ${FRONTEND_DIST} — dev mode (Vite handles UI)`);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] AlphaTrade AI v2 listening on :${PORT}`);
  console.log(`[Server] Alpaca configured: ${alpacaService.isConfigured()} | live keys available: ${alpacaService.hasLiveCredentials()}`);
  const status = llmService.getProviderStatus();
  console.log(`[Server] OpenRouter: ${status.openrouter ? 'YES' : 'NO'}, xAI/Grok: ${status.xai ? 'YES' : 'NO'}`);
  // Pre-market briefing: ensure schema, schedule daily 08:00 ET run, and
  // generate today's briefing now if we don't already have one.
  // Pre-market briefings: schedule both markets independently so an outage on
  // one (or an empty watchlist) never blocks the other. US runs at 08:00 ET,
  // ASX at 09:00 Sydney.
  premarketService.ensureSchema()
    .then(() => {
      const usWl  = () => getWatchlist();
      const asxWl = () => marketRegistry.getAsxWatchlist();
      premarketService.scheduleAll({ us: usWl, asx: asxWl });
      premarketService.bootstrapAll({ us: usWl, asx: asxWl });
    })
    .catch(e => console.error('[Premarket] init error:', e.message));

  // Bootstrap news sentiment for the full combined watchlist on boot so the
  // Markets tab stops showing "Pending…" the moment the user opens it.
  // Refreshes every 10 min to keep cards in sync with the cache TTL. Whether
  // or not the trading agent is running, the dashboard now always has data.
  const refreshAllSentiment = async () => {
    try {
      const wl = getCombinedWatchlist();
      if (!wl.length) return;
      console.log(`[Sentiment] Bootstrap/refresh for ${wl.length} symbols...`);
      await sentimentService.getSentimentBatch(wl, { concurrency: 3 });
      console.log(`[Sentiment] Cache populated (${Object.keys(sentimentService.getAllCached()).length} entries).`);
    } catch (e) {
      console.error('[Sentiment] Bootstrap error:', e.message);
    }
  };
  // Stagger the boot fetch so it doesn't compete with premarket bootstrap on
  // the same Grok endpoint.
  setTimeout(refreshAllSentiment, 3000);
  setInterval(refreshAllSentiment, 10 * 60 * 1000);
});

process.on('uncaughtException', (e) => console.error('[Process] uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('[Process] unhandledRejection:', e));
