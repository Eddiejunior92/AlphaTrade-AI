# AlphaTrade AI v2

Production-ready autonomous multi-LLM high-frequency trading agent.

## Architecture
- **Backend** (`backend/`, port 3001): Node/Express + WebSocket (`/ws`).
  - `server.js` — REST API + WS broadcaster. Operator-token auth on all mutation endpoints; LIVE-mode switch refused entirely if `OPERATOR_TOKEN` is unset.
  - `strategies.js` — registry of strategies (day, swing) with their cadences, stops/targets, risk, and overnight rules.
  - `agent.js` — base 60s cycle; runs each enabled strategy on its own cadence (day=60s/1Min, swing=300s/15Min). Global trading lock prevents cycle/flatten/mode-switch from overlapping. Day strategy auto-flattens 5m before close; swing holds overnight. Daily reset at 13:30 UTC, auto-resume on restart.
  - `services/llmService.js` — 4-model ensemble: Gemini 2.0 Flash, Claude 3.7 Sonnet, GPT-4o (via OpenRouter) + Grok 4 Fast (xAI direct). Requires ≥3/4 valid responses.
  - `services/riskManager.js` — strategy-aware: takes a `strategyConfig` per evaluation. 85% confidence + 3-of-4 quorum hard gates. Refuses averaging-in (no re-buying same symbol in same strategy). Cross-strategy mark-to-market for circuit-breaker math. $100/day USD loss budget.
  - `services/alpacaService.js` — runtime paper/live switching via `setMode()`. Live mode reads separate `ALPACA_LIVE_API_KEY` / `ALPACA_LIVE_SECRET_KEY`; refuses live without them.
  - `services/brokerService.js` — "Alpha" personal-broker chat (Claude 3.7 via OpenRouter), strategy/mode-aware.
  - `services/db.js` — PostgreSQL with `ensureSchema()` migration. `holdings` has composite PK `(symbol, strategy)` so the same symbol can be held in both strategies independently.
  - `services/discordService.js` — webhook alerts.
- **Frontend** (`frontend/`, port 5000): React + Vite + Tailwind v4. iPhone-16 glassmorphism dashboard. Tabs: Home, Strategies, Reasoning, Positions, Trades, Settings. Tooltips on every button. Strategy ON/OFF toggles, paper↔live mode switcher with confirmation modal. Voice broker (`VoiceChat` + `useVoice` hook) via Web Speech API.
- **Database**: PostgreSQL — `portfolio` (with `day_enabled`, `swing_enabled`, `trading_mode`), `holdings` (composite PK), `trades` (strategy-tagged), `audit_log`.

## Strategy Configs (in `backend/strategies.js`)
- **Day**: 1Min bars, 60s cadence, 0.5%/1% stop/target, $50–$100 risk/trade, max 4 holdings, 3% position cap, auto-flatten 5m before close.
- **Swing**: 15Min bars, 300s cadence, 2%/5% stop/target, $75–$200 risk/trade, max 3 holdings, 5% position cap, can hold overnight.

## Risk Defaults (env-overridable)
- `MAX_DAILY_LOSS_USD=100`, `MAX_DAILY_DRAWDOWN_PCT=0.05`
- `WATCHLIST=AAPL,NVDA,TSLA,MSFT,AMZN,META,GOOGL,SPY`
- `AGENT_INTERVAL_SECONDS=60` (base loop tick)
- `FORCE_FLATTEN_MINUTES_BEFORE_CLOSE=5` (day strategy only)
- `OPERATOR_TOKEN` — REQUIRED to enable LIVE mode switch and to deploy in production.

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
