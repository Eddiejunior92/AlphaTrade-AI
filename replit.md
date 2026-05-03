# AlphaTrade AI — Project Documentation

## Overview

Autonomous multi-LLM trading agent with a real-time React dashboard. Uses a 4-model AI ensemble (Gemini 2.5 Flash, Claude, GPT-4o, Grok) with consensus voting to generate trading signals. Integrates with Alpaca brokerage for paper/live trading and Discord for mobile alerts.

## Architecture

- **Backend**: Node.js + Express on port 3001 (`backend/server.js`)
- **Frontend**: React + Vite on port 5000 (`frontend/`)
- **Real-time**: WebSocket server at `/ws` proxied through Vite
- **Agent loop**: `backend/agent.js` — runs on a configurable cron schedule
- **LLM service**: `backend/services/llmService.js` — multi-LLM ensemble
- **Alpaca**: `backend/services/alpacaService.js` — brokerage integration
- **Discord**: `backend/services/discordService.js` — webhook alerts

## Key Files

```
backend/
  server.js          ← Express + WebSocket server
  agent.js           ← Trading agent loop, circuit breakers
  services/
    llmService.js    ← Gemini, Claude, GPT-4o, Grok ensemble
    alpacaService.js ← Alpaca brokerage (paper/live)
    discordService.js← Discord webhook alerts
frontend/
  src/
    App.jsx          ← Main dashboard UI
    hooks/useAgent.js← API + WebSocket state management
    components/      ← SignalCard, TradeLog, PositionsTable, StatCard
  vite.config.js     ← Proxies /api and /ws to backend:3001
```

## Workflows

- **Start application**: `node_modules/.bin/vite --config frontend/vite.config.js frontend --host 0.0.0.0 --port 5000` (webview, port 5000)
- **Backend API**: `node backend/server.js` (console, port 3001)

## Package Management

All npm packages installed at root `node_modules/`. No separate `node_modules` in subdirectories.

## Environment Variables Required

Add these as Replit Secrets before running the agent:

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API key |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key |
| `OPENAI_API_KEY` | OpenAI GPT-4o API key |
| `GROK_API_KEY` | xAI Grok API key |
| `ALPACA_API_KEY` | Alpaca brokerage API key |
| `ALPACA_SECRET_KEY` | Alpaca brokerage secret key |
| `ALPACA_BASE_URL` | `https://paper-api.alpaca.markets` (paper) or live URL |
| `DISCORD_WEBHOOK_URL` | Optional: Discord webhook for alerts |
| `TRADING_MODE` | `paper` (default) or `live` |
| `MAX_POSITION_SIZE` | Max USD per trade (default: 1000) |
| `MAX_DAILY_LOSS` | Circuit breaker threshold (default: 500) |
| `TRADE_INTERVAL_MINUTES` | How often the agent runs (default: 15) |

## Safety Features

- **Circuit Breaker**: Halts trading when daily loss limit is reached
- **Daily Reset**: P&L and trade counts reset at midnight
- **Paper Mode**: Default mode — no real money at risk
- **Confidence Threshold**: Only trades when LLM ensemble confidence ≥ 65%
- **Graceful Fallback**: Falls back to mock data when APIs are unconfigured

## Deployment

Uses VM deployment type (always-running) since the app requires WebSockets and persistent agent state. Runs both backend and frontend in a single process via bash.
