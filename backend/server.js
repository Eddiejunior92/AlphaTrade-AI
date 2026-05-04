require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const {
  startAgent, stopAgent, runCycle, getAgentSnapshot,
  emergencyPause, resetCircuitBreaker, flattenAllPositions,
  setStrategyEnabled, setTradingMode,
} = require('./agent');
const alpacaService = require('./services/alpacaService');
const llmService = require('./services/llmService');
const brokerService = require('./services/brokerService');
const db = require('./services/db');

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
  if (req.method === 'POST' && (req.path.startsWith('/api/agent/') || req.path === '/api/broker/chat')) {
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

app.post('/api/agent/start', async (req, res) => {
  try {
    const portfolio = await db.getPortfolio();
    if (portfolio.emergency_pause) return res.status(400).json({ success: false, error: 'Emergency pause is active. Resume first.' });
    await startAgent(); broadcastState(); res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/agent/stop', async (req, res) => {
  await stopAgent(); broadcastState(); res.json({ success: true });
});

app.post('/api/agent/run-now', async (req, res) => {
  try {
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
  await resetCircuitBreaker(); broadcastState(); res.json({ success: true });
});
app.post('/api/agent/flatten', async (req, res) => {
  try { await flattenAllPositions(req.body?.reason || 'Manual flatten via dashboard'); broadcastState(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
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
  res.json(await db.getRecentTrades(limit));
});

app.get('/api/audit', async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit) || 50);
  res.json(await db.getRecentAudit(limit));
});

app.get('/api/account', async (req, res) => { res.json(await alpacaService.getAccount()); });

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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] AlphaTrade AI v2 listening on :${PORT}`);
  console.log(`[Server] Alpaca configured: ${alpacaService.isConfigured()} | live keys available: ${alpacaService.hasLiveCredentials()}`);
  const status = llmService.getProviderStatus();
  console.log(`[Server] OpenRouter: ${status.openrouter ? 'YES' : 'NO'}, xAI/Grok: ${status.xai ? 'YES' : 'NO'}`);
});

process.on('uncaughtException', (e) => console.error('[Process] uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('[Process] unhandledRejection:', e));
