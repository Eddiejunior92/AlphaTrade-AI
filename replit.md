# AlphaTrade AI v2

Production-ready autonomous multi-LLM high-frequency trading agent.

## Architecture
- **Backend** (`backend/`, port 3001): Node/Express + WebSocket (`/ws`).
  - `server.js` — REST API + WS broadcaster.
  - `agent.js` — trading loop (5-min cycles), DB-backed state, daily reset at 13:30 UTC, auto-resume on restart.
  - `services/llmService.js` — 4-model ensemble: Gemini 2.0 Flash, Claude 3.5 Sonnet, GPT-4o (via OpenRouter) + Grok 2 (xAI direct). Weighted consensus = avg confidence × agreement ratio. Requires ≥3/4 valid responses (configurable via `MIN_VALID_MODELS`).
  - `services/riskManager.js` — 85% confidence gate, 3% max position size, 5% daily-drawdown circuit breaker, stop-loss/take-profit, max 8 holdings.
  - `services/db.js` — PostgreSQL pool with allowlisted column updates, atomic cash adjustments via `adjustCash()`.
  - `services/alpacaService.js` — Alpaca paper trading.
  - `services/discordService.js` — webhook alerts.
- **Frontend** (`frontend/`, port 5000): React + Vite + Tailwind v4. Tabs: Dashboard, AI Reasoning, Holdings, Trade History, Signals. Emergency-pause + circuit-breaker reset buttons. WS-driven live state with HTTP polling fallback.
- **Database**: PostgreSQL — tables: `portfolio`, `holdings`, `trades`, `audit_log`.

## Risk Defaults (env-overridable)
- `CONFIDENCE_THRESHOLD=0.85`, `MAX_POSITION_PCT=0.03`, `MAX_DAILY_DRAWDOWN_PCT=0.05`
- `STOP_LOSS_PCT=0.03`, `TAKE_PROFIT_PCT=0.06`, `MAX_HOLDINGS=8`
- `AGENT_INTERVAL_SECONDS=300` (min 60), `WATCHLIST=AAPL,NVDA,TSLA,MSFT,AMZN,META,GOOGL,SPY`
- `TRADING_MODE=paper` (set to `live` only with caution)

## Required Secrets
- `OPENROUTER_API_KEY` — Gemini, Claude, GPT-4o
- `XAI_API_KEY` — Grok
- `ALPACA_API_KEY`, `ALPACA_SECRET_KEY` — paper or live
- `DISCORD_WEBHOOK_URL` (optional) — mobile alerts
- `DATABASE_URL` — auto-provided by Replit

## Workflows
- `Backend API` → `node backend/server.js`
- `Start application` → Vite dev on :5000 (proxies `/api` and `/ws` → :3001)

## Deployment
VM deployment configured via `.replit` — runs both backend and Vite preview together for 24/7 operation.

## Safety Features
- Server-side 85% confidence gate (cannot be bypassed by frontend).
- Circuit breaker auto-trips at 5% daily drawdown; requires manual reset.
- Emergency pause button halts all trading immediately.
- ≥3/4 LLMs must respond or system forces HOLD.
- Stop-loss skipped on stale price data (no fallback to avg cost).
- All decisions, trades, rejections, errors logged to `audit_log`.
- Allowlisted SQL column writes prevent injection via `updatePortfolio`.
- Atomic cash updates via `UPDATE ... SET cash = cash + delta` (no read-modify-write race).
