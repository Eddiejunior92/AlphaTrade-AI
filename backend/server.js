require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const {
  startAgent, stopAgent, runCycle, getAgentSnapshot,
  emergencyPause, resetCircuitBreaker,
} = require('./agent');
const alpacaService = require('./services/alpacaService');
const llmService = require('./services/llmService');
const db = require('./services/db');

const app = express();
const PORT = parseInt(process.env.PORT) || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

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
      if (ws.readyState !== WebSocket.OPEN) {
        wsClients.delete(ws);
        continue;
      }
      try { ws.send(msg); }
      catch { wsClients.delete(ws); try { ws.terminate(); } catch {} }
    }
  } catch (e) {
    console.error('[WS] broadcast error:', e.message);
  }
}
setInterval(broadcastState, 4000);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    providers: llmService.getProviderStatus(),
    alpaca: alpacaService.isConfigured(),
  });
});

app.get('/api/state', async (req, res) => {
  try {
    res.json(await getAgentSnapshot());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agent/start', async (req, res) => {
  try {
    const portfolio = await db.getPortfolio();
    if (portfolio.emergency_pause) {
      return res.status(400).json({ success: false, error: 'Emergency pause is active. Resume first.' });
    }
    await startAgent();
    broadcastState();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/agent/stop', async (req, res) => {
  await stopAgent();
  broadcastState();
  res.json({ success: true });
});

app.post('/api/agent/run-now', async (req, res) => {
  try {
    const portfolio = await db.getPortfolio();
    if (portfolio.emergency_pause) {
      return res.status(400).json({ success: false, error: 'Emergency pause active' });
    }
    if (!portfolio.agent_running) {
      await db.updatePortfolio({ agent_running: true });
    }
    await runCycle();
    broadcastState();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/agent/emergency-pause', async (req, res) => {
  await emergencyPause(true);
  broadcastState();
  res.json({ success: true });
});

app.post('/api/agent/resume', async (req, res) => {
  await emergencyPause(false);
  broadcastState();
  res.json({ success: true });
});

app.post('/api/agent/reset-circuit-breaker', async (req, res) => {
  await resetCircuitBreaker();
  broadcastState();
  res.json({ success: true });
});

app.get('/api/trades', async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit) || 50);
  res.json(await db.getRecentTrades(limit));
});

app.get('/api/audit', async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit) || 50);
  res.json(await db.getRecentAudit(limit));
});

app.get('/api/account', async (req, res) => {
  res.json(await alpacaService.getAccount());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] AlphaTrade AI v2 listening on :${PORT}`);
  console.log(`[Server] Mode: ${process.env.TRADING_MODE || 'paper'}`);
  console.log(`[Server] Alpaca configured: ${alpacaService.isConfigured()}`);
  const status = llmService.getProviderStatus();
  console.log(`[Server] OpenRouter: ${status.openrouter ? 'YES' : 'NO'}, xAI/Grok: ${status.xai ? 'YES' : 'NO'}`);
});

process.on('uncaughtException', (e) => {
  console.error('[Process] uncaughtException:', e);
});
process.on('unhandledRejection', (e) => {
  console.error('[Process] unhandledRejection:', e);
});
