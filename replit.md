# AlphaTrade AI

Autonomous multi-LLM high-frequency trading agent for US and ASX markets.

## Run & Operate

*   **Run (development):** `node backend/server.js` (backend) & `vite` (frontend)
*   **Run (production):** `npm start`
*   **Env Vars:** `OPERATOR_TOKEN`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `IBKR_BASE_URL`, `IBKR_ACCOUNT_ID`, `DATABASE_URL`, `DISCORD_WEBHOOK_URL`, `MAX_DAILY_LOSS_USD`, `MAX_DAILY_DRAWDOWN_PCT`, `WATCHLIST`, `AUDUSD_RATE`, `EXCHANGERATE_API_KEY`, `FX_HOST_API_KEY`, `FX_TTL_SECONDS`, `AUTO_HEDGE`, `ASX_ENABLED`, `DAY_TRADING_DIP_REQUIREMENT_STRICTNESS`, `DISCORD_BOT_TOKEN`, `DISCORD_CHAT_CHANNEL_ID`, `LLM_CALL_COST_USD`, `DATA_FEED_COST_USD_PER_DAY`, `AGENT_INTERVAL_SECONDS` (default 60), `LLM_SKIP_PRICE_BPS` (default 70), `LLM_SKIP_TTL_SECONDS` (default 120).

## Stack

*   **Backend:** Node.js (Express, WebSocket)
*   **Frontend:** React, Vite, Tailwind CSS v4
*   **Database:** PostgreSQL
*   **LLMs:** Gemini 2.0 Flash, Claude 3.7 Sonnet, GPT-4o, Grok 4 Fast
*   **Brokers:** Alpaca, Interactive Brokers (IBKR)
*   **Build Tool:** Vite

## Where things live

*   `/backend`: Backend Node.js application (main logic, strategies, broker services).
    *   `server.js`: Entry point, API, WebSocket.
    *   `strategies.js`: Trading strategy definitions.
    *   `agent.js`: Core trading logic.
    *   `services/db.js`: Database schema and migration.
    *   `services/marketRegistry.js`: Market metadata.
    *   `services/alpacaService.js`, `services/ibkrService.js`: Broker interactions.
    *   `services/discordChatService.js`: Discord chat integration.
    *   `services/proactiveAlertsService.js`: Predictive early-warning detectors (informational only — never modify safety rails).
*   `/frontend`: React dashboard application.
    *   `/frontend/src/App.jsx`: Main frontend component.
*   `package.json`: Project dependencies and scripts.
*   `.replit`: Replit deployment configuration.

## Architecture decisions

*   **Multi-LLM Ensemble with Quorum:** Requires 3 out of 4 LLMs to agree for a trade signal, enhancing robustness.
*   **Unified USD-Equivalent Portfolio:** All P&L, risk, and circuit breakers operate on a USD-equivalent basis for consistent cross-market risk management.
*   **Layered Safety Rails:** Core safety features are strictly enforced and cannot be overridden by advisory intelligence layers; newer layers can only tighten controls.
*   **Atomic Cash Management:** Uses database-level locks for critical cash and holdings updates to prevent race conditions.
*   **Tamper-Evident Audit Log:** Implements a SHA-256 hash-chain for `audit_log` entries to ensure data integrity.
*   **Per-Market Configuration:** Supports independent market enablement, trading modes (paper/live), and cadence settings for US (Alpaca) and ASX (IBKR).

## Product

*   Autonomous trading with day and swing strategies for both US and ASX markets (US `day`/`swing` via Alpaca; ASX `asx_day`/`asx_swing` via IBKR).
*   Real-time dashboard displaying market data, signals, positions, and trade history.
*   Multi-LLM ensemble for trade signal generation with configurable risk parameters.
*   Advanced safety features including circuit breakers, kill switch, and confidence gates.
*   Human-in-the-loop feedback and fine-tuning mechanisms.
*   Continuous learning and strategy discovery for adaptive performance.
*   Comprehensive audit logging and compliance reporting.
*   Voice-enabled broker interaction and Discord chat integration (info only).
*   Daily Discord P&L reports with cost breakdown.

## User preferences

*   I prefer simple language and clear, concise explanations.
*   I want iterative development with frequent, small updates.
*   Ask before making major architectural changes.
*   I prefer detailed explanations for complex features.

## Gotchas

*   `OPERATOR_TOKEN` is mandatory for live trading and certain API operations.
*   ASX trading requires `IBKR_BASE_URL` and `IBKR_ACCOUNT_ID` env vars; otherwise, it operates in mock mode.
*   `ASX_ENABLED=true` must be set to activate ASX functionality.
*   The system enforces a strict 3-of-4 LLM quorum for trade execution.
*   Risk sizing is always in USD-equivalent, even for ASX trades.
*   Per-market master switches gate NEW ENTRIES ONLY; open positions are always managed.
*   ASX execution is hard-blocked by default and requires `ASX_EXECUTION_WIRED=true` to enable real IBKR routing.
*   `asx_day` strategy is restricted to the top-10 most-liquid ASX names (BHP/CBA/CSL/NAB/WBC/ANZ/RIO/WES/MQG/TLS) and enforces a A$5,000 minimum notional per trade to keep IBKR commissions under ~0.12%. Override universe via `WATCHLIST_ASX_DAY`.
*   Proactive alerts read `memoryState.lastSnapshot` (cached by `runCycle`) — they NEVER call `getAgentSnapshot()` to avoid extra broker fetches. All proactive detectors are informational only and write `event_type='PROACTIVE_ALERT'` audit rows.
*   Discord chat bot (`discordChatService.start()`) is gated on `REPLIT_DEPLOYMENT=1` so only the published instance connects — running two processes with the same `DISCORD_BOT_TOKEN` causes Discord to deliver every message twice. Override with `DISCORD_CHAT_FORCE_START=true` for local testing (and stop the deployed bot first).
*   Discord/voice chat is **info-only** by design — no code path from `brokerService.chat()` to `placeOrder`. The system prompt explicitly forbids Alpha from claiming to execute trades; manual execution must go through the dashboard's `/api/manual-order` endpoint.
*   Manual buy/sell endpoint (`POST /api/manual-order`) is operator-token-gated (strict) and re-uses `agent.executeOrder` so manual trades enforce kill-switch, circuit breaker, atomic cash/holdings, and tamper-evident audit log just like autonomous trades. Writes a `MANUAL_ORDER` audit row in addition to `TRADE_EXECUTED`.
*   Voice chat persists last 50 messages in `localStorage` under `alphatrade.chat.history` so reopening the panel restores context. Trash icon in chat header clears it.
*   Cost knobs: `AGENT_INTERVAL_SECONDS` (default 60s — was 20s) controls the master cycle cadence; lowering it multiplies LLM spend linearly. `LLM_SKIP_PRICE_BPS` (default 70 = 0.70%) is the price-drift threshold below which a cached HOLD verdict is reused instead of re-calling the ensemble; widening it cuts spend during chop. Raise/lower via env vars without code changes.
*   Daily performance reports are PER-MARKET: US fires at 21:30 UTC (~16:30 ET, 30min after US close), ASX fires at 07:00 UTC (after the latest possible Sydney close — covers both AEST and AEDT). Each market gets its own Discord post with its own LLM cost (perfMetrics tags increments by `sc.market`), its own data-feed cost (`DATA_FEED_COST_USD_PER_DAY_US`/`_ASX`, fallback to legacy `DATA_FEED_COST_USD_PER_DAY` split 50/50), and its own trade list. Trade-day SQL filter uses `(created_at AT TIME ZONE $tz)::date` so ASX sessions that span midnight UTC are correctly attributed.

## Pointers

*   [Replit Docs](https://docs.replit.com/)
*   [Alpaca API Documentation](https://alpaca.markets/docs/api-references/)
*   [Interactive Brokers Client Portal Web API](https://interactivebrokers.github.io/cpwebapi/index.htm)
*   [OpenRouter AI](https://openrouter.ai/docs)
*   [PostgreSQL Documentation](https://www.postgresql.org/docs/)
*   [React Documentation](https://react.dev/docs)
*   [Tailwind CSS Documentation](https://tailwindcss.com/docs)