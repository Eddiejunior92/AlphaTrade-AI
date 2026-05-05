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
  - `services/ibkrService.js` — IBKR Client Portal Web API broker for ASX symbols. Mock mode when `IBKR_BASE_URL`/`IBKR_ACCOUNT_ID` unset (matches Alpaca's mock pattern). Same kill-switch hook (`setKillSwitchActive`) as Alpaca so the operator kill cascade halts ASX too.
  - `services/brokerRouter.js` — per-symbol broker routing (US→Alpaca, ASX→IBKR via `marketRegistry`). Cross-broker `closeAllPositionsAllBrokers`, `cancelAllOpenOrdersAllBrokers`, `setKillSwitchActiveAll` so operator emergency controls fan out to both. `getBars` is broker-agnostic — bars are normalized to `{t,o,h,l,c,v}` by each service.
  - `services/marketRegistry.js` — market metadata for every symbol. ASX watchlist (10 liquid blue-chips: CBA, BHP, CSL, MQG, WES, RIO, FMG, TLS, WOW, ANZ). `isAsxOpen()` and `nextAsxOpen()` use Sydney timezone math (Mon–Fri, 10:00–16:00 AEST/AEDT — no holiday calendar; ASX-holiday orders fail at the broker and are audit-tagged).
  - `services/fxService.js` — cached AUD→USD rate. Source order: `AUDUSD_RATE` env override → `exchangerate.host` (1h TTL) → hardcoded fallback `0.66`. Returns `{audusd, source, stale, fetchedAt}` for the dashboard so operators can see when FX is stale or has fallen back.
  - `services/brokerService.js` — "Alpha" personal-broker chat (Claude 3.7 via OpenRouter), strategy/mode-aware.
  - `services/db.js` — PostgreSQL with `ensureSchema()` migration. `holdings` has composite PK `(symbol, strategy)` so the same symbol can be held in both strategies independently.
  - `services/discordService.js` — webhook alerts.
  - `services/sentimentService.js` — Grok-powered news sentiment per symbol. Returns `{score: -1..+1, label, summary, insights, sources}`. Cached 30 min per symbol; refreshed in background each cycle. Injected into the LLM ensemble prompt and exposed to the dashboard.
  - `services/adaptiveLearningService.js` — nightly recompute (22:00 UTC) of per-(symbol,strategy) and per-(model,strategy) win-rate from closed trades. Exposes `getCalibrationHints()` (prompt block, advisory only) and `getSizingMultiplier()` ∈ [0.7, 1.2]. Never relaxes quorum/gate.
  - `services/portfolioOptimizationService.js` — correlation-aware portfolio risk. `evaluateAddition()` returns `sizeMult` ∈ [0.5, 1.0] based on existing-holding correlation + concentration. Pure SIZING modifier, applied AFTER quorum/gate.
  - `services/hedgingService.js` — portfolio-level risk monitor. Posts Discord alert on risk spike; if `AUTO_HEDGE=true`, places SH (inverse SPY) buy at 15% of long exposure. Cooldown-protected, never bypasses circuit breaker. Default OFF (advisory).
  - `services/orderFlowService.js` — bar-derived buy/sell pressure proxy (volume-weighted up vs down candles). Lightweight prompt block.
  - `services/optionsActivityService.js` — Grok-fetched unusual options activity flag per symbol. Cached, refreshed every 30 min during market hours. Prompt block only — never sizes trades.
  - `services/optionsFlowService.js` — quantitative options-chain analytics. Pulls Alpaca's `/v1beta1/options/snapshots/{underlying}` (paginated, capped at 200 contracts within ±15% of spot and ≤60 DTE). Computes: P/C volume ratio, P/C OI ratio, ATM IV (mean of contracts within 2.5% of spot), IV skew (5%-OTM put IV − 5%-OTM call IV at nearest expiry), IV rank 0–100 over rolling 252-day window from `iv_history` table, and unusual-activity contracts (sweep proxy: vol/OI ≥ 2 AND vol ≥ 100; block proxy: vol ≥ 1000). 30-min in-memory TTL + per-symbol in-flight dedup. Refresh batch runs 60s after boot and every 30 min during US market hours; spot prices for the strike filter come from the latest 1-min bar (`buildSpotLookup`). Injected into every LLM prompt as the `optionsFlow` block (1–4 lines: P/C ratio, IV/IVR/skew, sentiment hint, top-3 unusual contracts) — strictly informational, never affects quorum/gate/sizing/breaker. US-only (Alpaca options coverage). Endpoint: `GET /api/options-flow/:symbol`.
  - `services/rlExecutionService.js` — reinforcement learning execution layer. Tabular Q-learning over (state, action) cells in `rl_q_table`. State = `regime|strategy|mfe-bucket|pnl-bucket` (~375 cells max). Actions: NONE, TIGHTEN (trail × 0.7), LOOSEN (trail × 1.4), ARM_EARLY (activate × 0.5), LOCK_IN (trail = 0.7%, arm immediately at +0.01% profit). ε-greedy (decays from 0.10 to 0.02 over first 200 visits per state), α=0.20. Per cycle, `recommendForHolding` picks an action and returns an `adjustedConfig` with `trailingStopPct` / `trailingActivatePct` clamped to [0.5×, 1.5×] of the strategy default — fed straight into the existing `riskManager.computeTrailingUpdate`, which still only ratchets stops UP. On every closed trade, `recordOutcome` pulls the symbol/strategy's RL_EXEC_DECISION audit rows since the most-recent BUY, computes R-multiple = `pnl/risk` (clipped ±3, risk pulled from BUY's `ml_risk_usd`), groups by (state, action) and applies a weighted SGD-equivalent update `Q ← Q + (1−(1−α)^w)·(R−Q)`. Audit logging is debounced — same-action skips coalesce up to 10 cycles. All errors swallowed; quorum, confidence gate, daily loss budget, % drawdown breaker, kill switch are completely untouched. Endpoint: `GET /api/rl/execution`.
  - `services/knowledgeGraphService.js` — long-term per-symbol company knowledge graph (Postgres `company_knowledge`). Stores company metadata, sector + peers, rolling earnings track (≤6), valuation, macro context, and a curated major-event timeline (≤6) extracted best-effort by Grok-mini. Daily refresh at 08:00 UTC + 30s post-boot warm-up; event-triggered staleness when sentiment |score|≥0.5. Two-phase refresh persists deterministic core/summary BEFORE optional LLM enrichment, so the prompt block is never gated on LLM latency. Hard 1400-char summary cap. Injected as `knowledgeContext` in the LLM ensemble — informational only, never affects quorum/gate/sizing. Endpoints: `GET /api/knowledge`, `GET /api/knowledge/:symbol`.
  - `services/backtestService.js` — daily-bars rules-based backtest engine (RSI + trend + MACD entry, configurable stop/target/trailing). Models slippage (bps) and per-trade commission. Returns equity curve, trade log, Sharpe, max drawdown, win rate. Persists to `backtest_runs` table. Watchlist-only, in-flight lock, operator-gated.
- **Frontend** (`frontend/`, port 5000): React + Vite + Tailwind v4. iPhone-16 glassmorphism dashboard. Tabs: Home, Markets, Strategies, Reasoning, Positions, Trades, **Backtest**, Settings. Tooltips on every button. Strategy ON/OFF toggles, paper↔live mode switcher with confirmation modal. Voice broker (`VoiceChat` + `useVoice` hook) via Web Speech API. Markets tab shows a clean recharts price chart per watchlist symbol (1d / 5d toggle) with live AI confidence, news sentiment score, and key insights.
- **Database**: PostgreSQL — `portfolio`, `holdings` (composite PK), `trades`, `audit_log`, `historical_intelligence`, `symbol_strategy_performance`, `model_performance`, `backtest_runs`, `company_knowledge`, `rl_q_table`, `iv_history`.

## Strategy Configs (in `backend/strategies.js`)
- **Day** (US/USD via Alpaca): 1Min bars, 60s cadence, 0.5%/1% stop/target, $50–$100 risk/trade, max 4 holdings, 3% position cap, auto-flatten 5m before close. No trailing stop (intraday only).
- **Swing** (US/USD via Alpaca): 15Min bars, 300s cadence, 2%/5% stop/target, $75–$200 risk/trade, max 3 holdings, 5% position cap, can hold overnight. **Trailing stop**: arms once +2% above entry, then ratchets stop to `peak × (1 − 2.5%)` — never moves down.
- **ASX Swing** (ASX/AUD via IBKR): 15Min bars, 600s cadence, 2.5%/6% stop/target, $75–$200 risk/trade, max 3 holdings, 5% position cap, holds overnight, gated by Sydney market hours. Same trailing-stop rules as US swing.

## Multi-Market & FX
- One unified USD-equivalent virtual portfolio: ASX cash debits/credits = `native_price × qty × fx_at_trade`. Holdings store NATIVE qty + avg_cost + currency + fx_rate_at_entry; equity is summed in USD using a USD-equivalent price lookup so the **single $100/day USD loss budget and 5% drawdown circuit breaker apply across BOTH markets**.
- Risk sizing in USD-equivalent: `latest_native × fxToUsd` is fed to `evaluateBuy`; returned stop/take are USD-equivalent and converted back to native for both the broker order and `holdings` storage.
- Per-strategy market gating in `runCycle`: cycle proceeds when ANY market is open (so equity stays mark-to-market for the breaker), but each strategy only places new orders when its own market is open.
- Operator emergency controls fan out across brokers: kill-switch, cancel-all-orders, and flatten-all all hit BOTH Alpaca and IBKR via `brokerRouter.*AllBrokers` helpers (allSettled — one broker failing doesn't skip the other).
- US-only enrichment services (premarket briefing, intraday tactical, 20-yr historical intelligence, options activity) are skipped for ASX symbols — analyzer falls back to bar-derived signals (the safe degradation for a new market).

## Watchlists
- **US (15 symbols, override via `WATCHLIST` env)**: `AAPL, NVDA, MSFT, AMZN, META, GOOGL, TSLA, AMD, AVGO, NFLX, JPM, BAC, COST, SPY, QQQ`
- **ASX (10 symbols, fixed in `marketRegistry.js`)**: `CBA, BHP, CSL, MQG, WES, RIO, FMG, TLS, WOW, ANZ`

## Risk Defaults (env-overridable)
- `MAX_DAILY_LOSS_USD=100`, `MAX_DAILY_DRAWDOWN_PCT=0.05`
- `WATCHLIST` (comma-separated; defaults to the 15-symbol list above)
- `SENTIMENT_TTL_SECONDS=1800` (30 min cache for Grok news sentiment)
- `AGENT_INTERVAL_SECONDS=60` (base loop tick)
- `FORCE_FLATTEN_MINUTES_BEFORE_CLOSE=5` (day strategy only)
- `OPERATOR_TOKEN` — REQUIRED to enable LIVE mode switch and to deploy in production.
- `IBKR_BASE_URL`, `IBKR_ACCOUNT_ID` — when set, IBKR service hits the real Client Portal Gateway for ASX trading. Unset = mock mode (no real ASX orders, mock bars, prevents accidental live trading on a market without configured creds).
- `AUDUSD_RATE` — manual FX override; otherwise `exchangerate.host` (1h cached) → `0.66` fallback.
- `AUTO_HEDGE=true` (default false) — arms automatic SH inverse-ETF hedge on portfolio risk spikes (otherwise advisory Discord alert only).

## Required Secrets
- `OPENROUTER_API_KEY` — Gemini, Claude, GPT-4o
- `XAI_API_KEY` — Grok
- `ALPACA_API_KEY`, `ALPACA_SECRET_KEY` — paper or live (US equities)
- `IBKR_BASE_URL`, `IBKR_ACCOUNT_ID` (optional) — enable real ASX trading via IBKR Client Portal Gateway; absent → mock mode
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
- **Kill switch (Phase 4)**: `POST /api/agent/kill-switch` (operator-token + body `{confirm:"KILL"}`) trips a sticky in-memory flag set BEFORE any await, then cancels open orders, drains in-flight cycle (30s timeout), flattens all positions. Once tripped, `executeOrder()`, `runCycle()`, auto-hedge, AND `alpacaService.placeOrder()` itself all refuse new orders; `/api/agent/start` and `/run-now` return 409 "kill switch latched — restart required". Only a process restart clears it.
- **Cancel all open orders (Phase 4)**: `POST /api/agent/cancel-orders` audit-logged broker order cancellation, separate from flatten.
- **Audit hash-chain (Phase 4)**: `audit_log` has `prev_hash` + `row_hash` (SHA-256 of `prev_hash || event_type || symbol || decision || JSON(payload) || created_at`), written inside a transaction with `LOCK TABLE audit_log IN EXCLUSIVE MODE`. `GET /api/audit/verify` walks the chain and reports the first break (or "ok"). Tamper-evident — any row mutation invalidates every subsequent `row_hash`.
- **Compliance reports (Phase 4)**: `GET /api/audit/report?date=YYYY-MM-DD&format=json|csv` (operator-token gated). JSON includes daily P&L, win rate, model attribution, risk events (kill switch / circuit breaker / hedge / mode changes / drawdown pause), blocked-trade reasons (quorum/gate/risk), per-trade SIGNAL attachment via two-pass strategy-aware match (strict strategy === trade.strategy preferred, falls back to any-strategy within 5-min window), hash-chain verification result. CSV is a flat regulator-relevant trade sheet.
- **Asset-class scaffolding (Phase 4)**: `trades`, `holdings`, `audit_log` have `asset_class` column (default `'equity'`). Equities-only execution today; options/futures execution intentionally deferred (would require LLM prompt restructure, contracts×multiplier sizing, different stop-loss math, and Alpaca's separate options contract symbol schema — futures not supported by Alpaca at all).

## US/ASX Market Split (May 2026)

The dashboard now treats US and ASX as first-class peers everywhere:

- **Header:** two market badges (🇺🇸 / 🇦🇺 OPEN/CLOSED) plus a compact AUD/USD FX pill (green=live, yellow=stale, red=missing). Stale rates make ASX risk-sizing refuse — operators see this at a glance.
- **Home / MarketsTab:** `MarketClocks` renders the NYSE and ASX (Sydney) sessions side-by-side with DST-correct countdowns via `Intl`. Full `FxBadge` panel sits below.
- **Per-tab market filters** (`MarketFilter` chips, `ALL/US/ASX` with live counts) on Live Signals, Reasoning, Positions, Trades, and Backtest. Each filter has its own state so scoping one section never narrows another.
- **Holdings** are shown in NATIVE currency per row ($/A$ + market badge). Positions tab adds per-market subtotals (native + USD-equivalent via `state.fx`) so AUD never gets summed into USD.
- **Trades + Audit** carry `market`/`currency`/`fx_rate`. The TradeLog displays the FX rate used at execution for ASX rows. `/api/trades` and `/api/audit` accept `?market=US|ASX`; platform-wide audit events without a symbol stay visible under any filter.
- **Backtest** scope chip narrows the allowed watchlist to one market and auto-swaps default symbols (US: SPY,QQQ,AAPL; ASX: BHP,CBA,CSL). Recent runs are tagged US/ASX/MIX and filterable by chip.
- **Backend tagging:** `/api/markets` returns combined `usWatchlist`+`asxWatchlist` and tags each card with `market`/`currency`. `/api/bars/:symbol` and `/api/sentiment/:symbol` whitelist both watchlists and route ASX through `brokerRouter` (IBKR). `agent.js` writes `market`+`currency` onto every `lastSignals` entry.

All existing safety rules (single USD-equivalent daily loss budget, circuit breaker, kill switch, dual-broker order routing) are unchanged — only the presentation and filtering layers were extended.
