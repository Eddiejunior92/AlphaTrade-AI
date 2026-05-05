# AlphaTrade AI

Autonomous multi-LLM high-frequency trading agent for US and ASX markets.

## Run & Operate

*   **Run (development):** `node backend/server.js` (backend) & `vite` (frontend)
*   **Run (production):** `npm start` (utilizes `.replit` config for both)
*   **Env Vars:**
    *   `OPERATOR_TOKEN`: Required for LIVE mode and production deployment.
    *   `OPENROUTER_API_KEY`, `XAI_API_KEY`: LLM access.
    *   `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`: US equities trading (paper/live).
    *   `IBKR_BASE_URL`, `IBKR_ACCOUNT_ID`: ASX trading via IBKR (optional, enables live ASX).
    *   `DATABASE_URL`: PostgreSQL connection (auto-provided by Replit).
    *   `DISCORD_WEBHOOK_URL`: Optional, for mobile alerts.
    *   `MAX_DAILY_LOSS_USD=100`, `MAX_DAILY_DRAWDOWN_PCT=0.05`: Risk limits.
    *   `WATCHLIST`: Comma-separated US symbols (overrides default).
    *   `AUDUSD_RATE`: Manual FX override.
    *   `AUTO_HEDGE=true`: Enables automatic SH inverse-ETF hedge (default: `false`).
    *   `ASX_ENABLED=true`: Enables ASX trading support (default: `false`).
    *   `DAY_TRADING_DIP_REQUIREMENT_STRICTNESS`: Day strategy dip-buy strictness (0=disabled, 1=loose, 2=medium, 3=strict).

## Stack

*   **Backend:** Node.js (Express, WebSocket)
*   **Frontend:** React, Vite, Tailwind CSS v4
*   **Database:** PostgreSQL
*   **LLMs:** Gemini 2.0 Flash, Claude 3.7 Sonnet, GPT-4o, Grok 4 Fast
*   **Brokers:** Alpaca, Interactive Brokers (IBKR)
*   **Build Tool:** Vite

## Where things live

*   `/backend`: Backend Node.js application.
    *   `server.js`: Main entry point, REST API, WebSocket broadcaster.
    *   `strategies.js`: Trading strategy definitions.
    *   `agent.js`: Core trading logic, cycle execution.
    *   `services/db.js`: Database schema and migration logic.
    *   `services/marketRegistry.js`: ASX watchlist, market hours, symbol metadata.
    *   `services/alpacaService.js`, `services/ibkrService.js`: Broker interactions.
*   `/frontend`: React dashboard application.
*   `/frontend/src/App.jsx`: Main frontend component.
*   `package.json`: Project dependencies and scripts.
*   `.replit`: Replit deployment configuration.

## Architecture decisions

*   **Multi-LLM Ensemble with Quorum:** Requires 3 out of 4 LLMs to agree for a trade signal to pass, enhancing signal robustness and reducing reliance on a single model.
*   **Unified USD-Equivalent Portfolio:** All P&L, risk calculations, and circuit breakers operate on a USD-equivalent basis, enabling consistent risk management across different markets (US/ASX) and currencies.
*   **Layered Safety Rails:** Core safety features (circuit breaker, kill switch, confidence gates) are strictly enforced and cannot be overridden by newer, more advisory intelligence layers (e.g., causal inference, meta-reasoner, continuous learning). Newer layers can only tighten controls, never relax them.
*   **Atomic Cash Management:** Utilizes database-level locks and re-reads for critical sections involving cash and holdings updates to prevent race conditions during concurrent strategy execution (US and ASX).
*   **Tamper-Evident Audit Log:** Implements a SHA-256 hash-chain for `audit_log` entries, ensuring the integrity and immutability of all trading decisions and events.

## Product

*   Autonomous trading with day and swing strategies for US and ASX markets.
*   Real-time dashboard with market data, live signals, positions, and trade history.
*   Multi-LLM ensemble for trade signal generation with configurable risk parameters.
*   Advanced safety features including circuit breakers, kill switch, and confidence gates.
*   Human-in-the-loop feedback and fine-tuning mechanisms.
*   Continuous learning and strategy discovery for adaptive performance.
*   Comprehensive audit logging and compliance reporting.
*   Voice-enabled broker interaction.

## User preferences

*   I prefer simple language and clear, concise explanations.
*   I want iterative development with frequent, small updates.
*   Ask before making major architectural changes.
*   I prefer detailed explanations for complex features.

## Gotchas

*   `OPERATOR_TOKEN` is mandatory for live trading and certain API operations.
*   ASX trading requires `IBKR_BASE_URL` and `IBKR_ACCOUNT_ID` environment variables; otherwise, it operates in mock mode.
*   `ASX_ENABLED=true` must be set in environment variables to activate ASX functionality.
*   The system enforces a strict 3-of-4 LLM quorum for trade execution.
*   Risk sizing is always in USD-equivalent, even for ASX trades.

## Pointers

*   [Replit Docs](https://docs.replit.com/)
*   [Alpaca API Documentation](https://alpaca.markets/docs/api-references/)
*   [Interactive Brokers Client Portal Web API](https://interactivebrokers.github.io/cpwebapi/index.htm)
*   [OpenRouter AI](https://openrouter.ai/docs)
*   [PostgreSQL Documentation](https://www.postgresql.org/docs/)
*   [React Documentation](https://react.dev/docs)
*   [Tailwind CSS Documentation](https://tailwindcss.com/docs)
## Day-Trading Cycle Cadence — Operator-Tunable Pacing (May 2026)

Mirrors the recovery-buffer pattern: a single integer setting on the portfolio row, live-read each cycle, operator-gated dashboard control, audit-logged on change. Controls **only** how often the day strategy ticks — every safety rule, quorum, confidence gate, dip-buy filter, recovery buffer, daily loss budget, drawdown breaker, kill switch, and sizing math is **completely unchanged**.

- **Storage:** `portfolio.day_trading_cadence_seconds INTEGER NOT NULL DEFAULT 60`. Added to `ALLOWED_PORTFOLIO_FIELDS` so `updatePortfolio` accepts it.
- **Bounds:** `[5, 600]` seconds. Lower bound 5s to keep Alpaca's bar API comfortable (~10 req/s across 30 US symbols). Upper bound 600s to keep "day" trading meaningfully intraday (swing covers longer horizons at 300s).
- **Setter (`backend/agent.js: setDayCadence`):** integer-validates, range-clamps, reads previous value via `getPortfolio()`, writes via `updatePortfolio({day_trading_cadence_seconds})`, audit-logs `DAY_CADENCE_CHANGED { from, to, min, max }`. Identical shape to `RECOVERY_BUFFER_CHANGED` for downstream tooling.
- **Live read in cycle:** `runCycle` reads `portfolio.day_trading_cadence_seconds` each tick and overrides `strategies.day.intervalSeconds` via shallow spread (`{ ...dayScaled, intervalSeconds: dayCadenceLive }`) before the eligibility check `elapsed >= s.sc.intervalSeconds - 5`. Result: a dashboard change takes effect on the **very next tick** with no restart and no race.
- **Master loop floor:** lowered from 20s → 5s (`BASE_INTERVAL_SECONDS = Math.max(5, env)`) so the fastest preset (15s, or even 5s manual) can actually fire on schedule. Other strategies (swing, asx_swing) are self-gated inside `runCycle` by their own `intervalSeconds` — faster ticks just mean a cheap "not yet" check returns more often. No extra LLM calls, no extra trades.
- **Endpoint:** `POST /api/agent/day-cadence` — operator-gated via `requireOperator`, body `{seconds}`, broadcasts new state on success.
- **State exposure:** `/api/state.dayCadence = { seconds, min, max, default, presets: [15,20,30,60,90,120], appliesTo: 'day' }`.
- **Frontend (`frontend/src/App.jsx: DayCadenceControl`):** placed directly under `RecoveryBufferControl` in the Strategy/Risk panel. Six preset chips (15/20/30/60/90/120s) for one-click changes plus a numeric input for arbitrary in-range values. Apply enables only when draft differs from live AND is in-range. `useAgent.setDayCadence(seconds)` posts to the operator-gated endpoint and refreshes audit log.
- **Verified:** column exists with default 60; `/api/state.dayCadence` returns the full block; cadence change writes audit row, takes effect on the next cycle without restart; quorum/confidence/dip-buy/recovery-buffer paths untouched.
