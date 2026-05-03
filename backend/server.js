require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { startAgent, stopAgent, getAgentState, runCycle, resetCircuitBreaker, WATCHLIST } = require('./agent');
const alpacaService = require('./services/alpacaService');

const app = express();
const PORT = parseInt(process.env.PORT) || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  sendStateToClient(ws);
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function sendStateToClient(ws) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'state', data: getAgentState() }));
  }
}

setInterval(() => broadcast({ type: 'state', data: getAgentState() }), 3000);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/state', (req, res) => {
  res.json(getAgentState());
});

app.post('/api/agent/start', (req, res) => {
  startAgent();
  broadcast({ type: 'state', data: getAgentState() });
  res.json({ success: true, message: 'Agent started' });
});

app.post('/api/agent/stop', (req, res) => {
  stopAgent();
  broadcast({ type: 'state', data: getAgentState() });
  res.json({ success: true, message: 'Agent stopped' });
});

app.post('/api/agent/run-now', async (req, res) => {
  try {
    await runCycle();
    broadcast({ type: 'state', data: getAgentState() });
    res.json({ success: true, message: 'Cycle complete' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/agent/reset-circuit-breaker', (req, res) => {
  resetCircuitBreaker();
  broadcast({ type: 'state', data: getAgentState() });
  res.json({ success: true, message: 'Circuit breaker reset' });
});

app.get('/api/account', async (req, res) => {
  const account = await alpacaService.getAccount();
  res.json(account);
});

app.get('/api/positions', async (req, res) => {
  const positions = await alpacaService.getPositions();
  res.json(positions);
});

app.get('/api/orders', async (req, res) => {
  const orders = await alpacaService.getOrders('all', 50);
  res.json(orders);
});

app.get('/api/watchlist', (req, res) => {
  res.json(WATCHLIST);
});

app.get('/api/bars/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const { timeframe = '5Min', limit = 30 } = req.query;
  const bars = await alpacaService.getBars(symbol, timeframe, parseInt(limit));
  res.json(bars);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] AlphaTrade AI backend running on port ${PORT}`);
  console.log(`[Server] Trading mode: ${process.env.TRADING_MODE || 'paper'}`);
  console.log(`[Server] Alpaca configured: ${alpacaService.isConfigured()}`);
});
