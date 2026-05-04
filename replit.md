# AlphaTrade AI v2

Production-ready autonomous multi-LLM high-frequency trading agent.

## Architecture
- **Backend** (`backend/`, port 3001): Node/Express + WebSocket (`/ws`).
  - `server.js` — REST API + WS broadcaster. Operator-token auth on all mutation endpoints; LIVE-mode switch refused entirely if `OPERATOR_TOKEN` is unset.
  - `strategies.js` — registry of strategies (day, swing) with their cadences, stops/targets, risk, and overnight rules.
  - `agent.js` — base 60s cycle; runs each enabled strategy on its own cadence (day=60s/1Min, swing=300s/15Min). Global trading lock prevents cycle/flatten/mode-switch from overlapping. Day strategy auto-flattens 5m before close; swing holds overnight. Daily reset at 13:30 UTC, auto-resume on restart.
  - `services/llmService.js` — 4-model ensemble: Gemini 2.0 Flash, Claude 3.7 Sonnet, GPT-4o (via OpenRouter) + Grok 4 Fast (xAI direct). Requires ≥3/4 valid responses.
  - `services/riskManager.js` — strategy-aware: takes a `strategyConfig` per evaluation. 85% confidence + 3-of-4 quorum hard gates. Refuses averaging-in (no re-buying same symbol in same strategy). Cross-strategy mark-to-market for circuit-breaker math. $100/day USD loss budget. **Compounding Confidence-Weighted sizing** (`computeDynamicScaling` + `computeTargetRisk`): per-trade $ risk = `lerp(min, max, confFraction) × growthMult × perfMult`, hard-capped at 2× scale.maxRiskUSD AND `maxPositionPct × equity` AND cash. `growthMult` steps +5% per +10% equity (range 0.5–2.0×). `perfMult` from last-20 closed-trade net PnL as % of starting balance (range 0.8–1.2×). `confFraction` lerps signal confidence within `[threshold, 1.0]`.
  - `services/alpacaService.js` — runtime paper/live switching via `setMode()`. Live mode reads separate `ALPACA_LIVE_API_KEY` / `ALPACA_LIVE_SECRET_KEY`; refuses live without them.
  - `services/brokerService.js` — "Alpha" personal-broker chat (Claude 3.7 via OpenRouter), strategy/mode-aware.
  - `services/db.js` — PostgreSQL with `ensureSchema()` migration. `holdings` has composite PK `(symbol, strategy)` so the same symbol can be held in both strategies independently.
  - `services/discordService.js` — webhook alerts.
  - `services/sentimentService.js` — Grok-powered news sentiment per symbol. Returns `{score: -1..+1, label, summary, insights, sources}`. Cached 30 min per symbol; refreshed in background each cycle. Injected into the LLM ensemble prompt and exposed to the dashboard.
  - `services/adaptiveLearningService.js` — nightly recompute (22:00 UTC) of per-(symbol,strategy) and per-(model,strategy) win-rate from closed trades. Exposes `getCalibrationHints()` (prompt block, advisory only) and `getSizingMultiplier()` ∈ [0.7, 1.2]. Never relaxes quorum/gate.
  - `services/portfolioOptimizationService.js` — correlation-aware portfolio risk. `evaluateAddition()` returns `sizeMult` ∈ [0.5, 1.0] based on existing-holding correlation + concentration. Pure SIZING modifier, applied AFTER quorum/gate.
  - `services/hedgingService.js` — portfolio-level risk monitor. Posts Discord alert on risk spike; if `AUTO_HEDGE=true`, places SH (inverse SPY) buy at 15% of long exposure. Cooldown-protected, never bypasses circuit breaker. Default OFF (advisory).
  - `services/orderFlowService.js` — bar-derived buy/sell pressure proxy (volume-weighted up vs down candles). Lightweight prompt block.
  - `services/optionsActivityService.js` — Grok-fetched unusual options activity flag per symbol. Cached, refreshed every 30 min during market hours. Prompt block only — never sizes trades.
  - `services/backtestService.js` — daily-bars rules-based backtest engine (RSI + trend + MACD entry, configurable stop/target/trailing). Models slippage (bps) and per-trade commission. Returns equity curve, trade log, Sharpe, max drawdown, win rate. Persists to `backtest_runs` table. Watchlist-only, in-flight lock, operator-gated.
- **Frontend** (`frontend/`, port 5000): React + Vite + Tailwind v4. iPhone-16 glassmorphism dashboard. Tabs: Home, Markets, Strategies, Reasoning, Positions, Trades, **Backtest**, Settings. Tooltips on every button. Strategy ON/OFF toggles, paper↔live mode switcher with confirmation modal. Voice broker (`VoiceChat` + `useVoice` hook) via Web Speech API. Markets tab shows a clean recharts price chart per watchlist symbol (1d / 5d toggle) with live AI confidence, news sentiment score, and key insights.
- **Database**: PostgreSQL — `portfolio`, `holdings` (composite PK), `trades`, `audit_log`, `historical_intelligence`, `symbol_strategy_performance`, `model_performance`, `backtest_runs`.

## Strategy Configs (in `backend/strategies.js`)
- **Day**: 1Min bars, 60s cadence, 0.5%/1% stop/target, $50–$100 risk/trade, max 4 holdings, 3% position cap, auto-flatten 5m before close. No trailing stop (intraday only).
- **Swing**: 15Min bars, 300s cadence, 2%/5% stop/target, $75–$200 risk/trade, max 3 holdings, 5% position cap, can hold overnight. **Trailing stop**: arms once +2% above entry, then ratchets stop to `peak × (1 − 2.5%)` — never moves down.

## Watchlist (15 symbols, override via `WATCHLIST` env)
`AAPL, NVDA, MSFT, AMZN, META, GOOGL, TSLA, AMD, AVGO, NFLX, JPM, BAC, COST, SPY, QQQ`

## Risk Defaults (env-overridable)
- `MAX_DAILY_LOSS_USD=100`, `MAX_DAILY_DRAWDOWN_PCT=0.05`
- `WATCHLIST` (comma-separated; defaults to the 15-symbol list above)
- `SENTIMENT_TTL_SECONDS=1800` (30 min cache for Grok news sentiment)
- `AGENT_INTERVAL_SECONDS=60` (base loop tick)
- `FORCE_FLATTEN_MINUTES_BEFORE_CLOSE=5` (day strategy only)
- `OPERATOR_TOKEN` — REQUIRED to enable LIVE mode switch and to deploy in production.
- `AUTO_HEDGE=true` (default false) — arms automatic SH inverse-ETF hedge on portfolio risk spikes (otherwise advisory Discord alert only).

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
