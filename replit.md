# AlphaTrade AI

Autonomous multi-LLM high-frequency trading agent for US and ASX markets.

## Run & Operate

*   **Run (development):** `node backend/server.js` (backend) & `vite` (frontend)
*   **Run (production):** `npm start`
*   **Env Vars:** `OPERATOR_TOKEN`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `IBKR_BASE_URL`, `IBKR_ACCOUNT_ID`, `DATABASE_URL`, `DISCORD_WEBHOOK_URL`, `MAX_DAILY_LOSS_USD`, `MAX_DAILY_DRAWDOWN_PCT`, `WATCHLIST`, `AUDUSD_RATE`, `EXCHANGERATE_API_KEY`, `FX_HOST_API_KEY`, `FX_TTL_SECONDS`, `AUTO_HEDGE`, `ASX_ENABLED`, `DAY_TRADING_DIP_REQUIREMENT_STRICTNESS`, `DISCORD_BOT_TOKEN`, `DISCORD_CHAT_CHANNEL_ID`, `DISCORD_APPROVER_IDS` (comma-separated Discord user IDs/tags allowed to Approve/Reject suggestions; **fail-closed when unset**), `LLM_CALL_COST_USD`, `DATA_FEED_COST_USD_PER_DAY`, `AGENT_INTERVAL_SECONDS` (default 60), `LLM_SKIP_PRICE_BPS` (default 70), `LLM_SKIP_TTL_SECONDS` (default 120), `HYBRID_STAT_HIGH_CONF` (default 0.78), `HYBRID_STAT_LOW_CONF` (default 0.55), `SENTIMENT_MAX_DAILY_CALLS_PER_SYMBOL` (default 1).

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
    *   `services/llmCostTracker.js`: Real per-token LLM cost tracking — every LLM call site reports its `usage` block, persisted to `llm_usage_logs`, queried by daily report.
    *   `services/hybridSignalService.js`: 60/30/10 statistical-first router (60% stats / 30% council / 10% sentiment). Skips LLM in strong tape, escalates to council when borderline.
    *   `services/councilService.js`: 7-role Intelligence Council (6 analysts: Fundamental/Technical/Risk/DeepResearch/Historical/Future + Judge synthesizer). Returns standard signal shape; quorum + gate still enforced downstream.
    *   `services/llmRouterService.js`: Per-(task_type, model_id) Bayesian-smoothed performance tracker. Picks the historically-best model per Council role, falls back to Grok when preferred model is failing or unseen.
    *   `services/dynamicGateService.js`: Smart Safety Layer — manages effective confidence gate clamped HARD to [0.65, 0.90]. Council can suggest ±10pp delta; auto-adaptive 3-day win-rate guard PINS gate at 0.85 if WR <42%, releases when WR >55%.
    *   `services/discordApprovalService.js`: Config-only Discord approval — `Approve #N` / `Reject #N` / `Status` / `Gate`. Hard-coded SAFE_KEYS allowlist; safety-critical params (kill switch, breaker, position cap, daily loss, drawdown, recovery buffer, quorum, audit chain) explicitly DENIED.
    *   `services/metaReviewService.js`: Daily after-close council deliberation → 3-5 scored numbered suggestions written to `pending_suggestions` and posted to Discord with IDs.
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
*   Day-trade tuning (May 2026): operating on `AGENT_INTERVAL_SECONDS=30`, `DAY_TRADING_DIP_REQUIREMENT_STRICTNESS=1` (Loose — any 1-of-5 dip conditions), `LLM_SKIP_PRICE_BPS=40`, `LLM_QUIET_SHORTCUT=false`, day strategy `maxHoldings=6`. Goal: ~10 day entries/day. Dip amplifier: when day-strategy BUY clears the dip gate AND `pctBelowVwap >= 0.5%` AND `cumDeltaSlope > 0` (mean-reversion setup with positive flow), `dipSizingMult=1.25` is passed via `dynamicWithUpgrades` to `riskManager.evaluateBuy` which clamps to `[1.00, 1.25]` defence-in-depth. Multiplier never exceeds 1.25, never fires for swing strategies, never bypasses the 3% `maxPositionPct` cap (qty is `min(qtyByRisk, qtyByPosition)`). All other safety rails (3-of-4 quorum, 80% confidence gate, daily loss budget, 5% drawdown circuit breaker, kill switch, no-averaging-in, recovery buffer, ASX min notional) untouched.
*   Cost knobs: `AGENT_INTERVAL_SECONDS` (default 60s — was 20s) controls the master cycle cadence; lowering it multiplies LLM spend linearly. `LLM_SKIP_PRICE_BPS` (default 70 = 0.70%) is the price-drift threshold below which a cached HOLD verdict is reused instead of re-calling the ensemble; widening it cuts spend during chop. Raise/lower via env vars without code changes.
*   **Master Intelligence Upgrade (May 2026)**: The signal pipeline is now hybrid 60/30/10. `agent.js` calls `hybridSignalService.computeStatisticalSignal()` BEFORE any LLM. If statistical confidence ≥ `HYBRID_STAT_HIGH_CONF` (0.78) AND not escalated AND no open position → emit statistical-only signal, skip LLM entirely. If < `HYBRID_STAT_LOW_CONF` (0.55) AND not escalated → emit synthetic HOLD, skip LLM. Otherwise (borderline OR escalated OR holding) → `councilService.deliberate()` runs 6 analysts in parallel + a Judge. Statistical-only signals carry `_statisticalOnly:true` and `agreementCount=1` — they will FAIL the existing 3-of-N quorum gate by design unless future operator opts in to a stat-execution mode. All hard rails (quorum, kill switch, breaker, atomic cash, audit chain, max_position_pct, recovery buffer, daily loss budget) remain BYTE-FOR-BYTE enforced downstream.
*   **Smart Safety Layer**: `dynamicGateService` exposes the effective confidence gate, hard-clamped to **[0.65, 0.90]**. Council can suggest a ±10pp delta after each deliberation; daily auto-adaptive evaluation pins the gate to 0.85 if 3-day rolling win-rate < 42% (n≥3 trades) and releases the pin when WR > 55%. Pin is UPWARD-ONLY — it can only RAISE the gate, never lower it. `riskManager.checkQuorum` accepts an optional `gateOverride` clamped at the same [0.65, 0.90] band as defence-in-depth. The `SAFETY_FLOOR=0.65` constant is exported and **must never be lowered**. State persisted to `dynamic_gate_state` table.
*   **Dynamic LLM router**: `llmRouterService` tracks per-(task_type, model_id) win/quality/recency in `llm_router_perf` table with Bayesian prior so unseen models aren't locked out. Each Council role picks its best model from a per-role pool; outcomes recorded best-effort (failures swallowed). Grok is the universal fallback when XAI_API_KEY is set — useful when OpenRouter is rate-limited.
*   **Discord config approval**: `discordApprovalService.tryHandle(text, msg)` runs in `discordChatService` BEFORE chat routing. Recognises `Approve #N`, `Reject #N`, `Status`, `Gate`. **Approver authz is FAIL-CLOSED**: `Approve`/`Reject` only succeed when the Discord user's ID or tag is in `DISCORD_APPROVER_IDS` (comma-separated env var). When unset, ALL approvals are denied and unauthorized attempts produce a `CONFIG_CHANGE_UNAUTHORIZED` audit row. Each authorized `Approve` looks up `pending_suggestions.target_key` against a HARD-CODED `SAFE_KEYS` allowlist; anything NOT in the list (or in the explicit `DENIED_KEYS` set: kill_switch, circuit_breaker, max_position_pct, max_daily_loss_usd, max_daily_drawdown_pct, recovery_buffer, min_directional_agreement, safety_floor, atomic_cash, audit_chain, asx_execution_wired) is auto-rejected with a `CONFIG_CHANGE_DENIED` audit row. Approvals produce `CONFIG_CHANGE_APPROVED` audit rows including the Discord user tag. Validation failures and apply exceptions ALSO write `CONFIG_CHANGE_DENIED` / `CONFIG_CHANGE_FAILED` audit rows. Currently allowlisted keys: `confidence_gate_base`, `day_trading_dip_strictness`, `llm_skip_price_bps`, `sentiment_ttl_seconds`, `agent_interval_seconds`, `max_holdings_day`. Some of these write to `portfolio` columns added lazily on first apply — services currently read most from env, so applied changes only take effect after services are migrated to read from the portfolio table (flagged as follow-up).
*   **Daily meta-review**: After the US daily P&L Discord report sends, `dailyPerformanceService.runDailyPerformanceJob()` triggers `dynamicGate.evaluateAutoAdaptive()` (auto-pin/release) and `metaReview.runReview('US')` (council deliberation → 3-5 scored numbered suggestions posted to Discord with their `pending_suggestions.id`). Both are best-effort and never break the daily report. ASX path also runs but only when `market='ASX'` is explicitly invoked (current default is US-only meta-review).
*   **Sentiment per-day cap**: `sentimentService` enforces `SENTIMENT_MAX_DAILY_CALLS_PER_SYMBOL=1` (env-overridable) using the `sentiment_daily_calls` table. Once the cap is hit, `getSentiment()` returns the cached payload (with `dailyCapHit:true` tag) instead of issuing another ensemble call. The TTL+price-stable cache is the in-day cadence; this counter is the absolute safety net against runaway loops.
*   Daily performance reports are PER-MARKET: US fires at 21:30 UTC (~16:30 ET, 30min after US close), ASX fires at 07:00 UTC (after the latest possible Sydney close — covers both AEST and AEDT). Each market gets its own Discord post with its own LLM cost (perfMetrics tags increments by `sc.market`), its own data-feed cost (`DATA_FEED_COST_USD_PER_DAY_US`/`_ASX`, fallback to legacy `DATA_FEED_COST_USD_PER_DAY` split 50/50), and its own trade list. Trade-day SQL filter uses `(created_at AT TIME ZONE $tz)::date` so ASX sessions that span midnight UTC are correctly attributed.
*   LLM cost tracking is REAL token-level (not flat-rate): every call site (`llmService`, `sentimentService`, `premarketService`, `knowledgeGraphService`, `fundamentalsService`, `optionsActivityService`, `earningsTranscriptService`, `metaReasonerService`, `brokerService`) calls `costTracker.recordUsage({ service, market, modelId, response })` after the HTTP response lands. Pricing table lives in `llmCostTracker.js` (PRICING array) — update there when models are repriced. Daily report queries `llm_usage_logs` aggregated by service+market+trading-day. Shared services (premarket, meta, chat) tagged `market='SHARED'` and split 50/50 across US/ASX reports. Recording is best-effort and swallows errors — tracker failure NEVER breaks a trading cycle. `LLM_CALL_COST_USD` env var is now obsolete (still read for backward compat but no longer used by the report).

## Pointers

*   [Replit Docs](https://docs.replit.com/)
*   [Alpaca API Documentation](https://alpaca.markets/docs/api-references/)
*   [Interactive Brokers Client Portal Web API](https://interactivebrokers.github.io/cpwebapi/index.htm)
*   [OpenRouter AI](https://openrouter.ai/docs)
*   [PostgreSQL Documentation](https://www.postgresql.org/docs/)
*   [React Documentation](https://react.dev/docs)
*   [Tailwind CSS Documentation](https://tailwindcss.com/docs)