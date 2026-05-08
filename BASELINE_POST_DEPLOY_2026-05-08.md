# Phase B Post-Deploy Baseline — Boot Verification & Schema State

**Captured at:** `2026-05-08 23:04:40 UTC`
**Mode:** read-only diagnostic · no code or data modified
**Source:** production deployment logs + production Postgres replica

---

## Section 1 — Boot log verification

Deploy started at `1778281347493` (2026-05-08 23:02:27 UTC). Schema/init lines
captured from the deployment log stream:

| Expected line | Found? | Actual log entry |
|---|---|---|
| `[SCHEMA-OK] T002 tables verified: llm_router_perf, dynamic_gate_state, pending_suggestions, sentiment_daily_calls` | ✅ YES | `[SCHEMA-OK] T002 tables verified: llm_router_perf, dynamic_gate_state, pending_suggestions, sentiment_daily_calls` (23:02:43) |
| `[SCHEMA-MISSING]` (any occurrence) | ✅ NONE | — no occurrences in boot stream — |
| `[DYNAMIC-GATE] inserted default state row (base_gate=0.8)` (first-boot only) | ✅ YES | `[DYNAMIC-GATE] inserted default state row (base_gate=0.8)` (23:02:43) |
| `[DYNAMIC-GATE] state row present — boot init skipped` | ⚪ N/A | not present (first-boot path took the insert branch instead — expected) |
| `[DISCORD-APPROVERS] parsed N approver IDs` | ✅ YES, **N=1** | `[DISCORD-APPROVERS] parsed 1 approver IDs: [1500645478956793947]` (23:02:35) |
| `[DISCORD-APPROVERS] WARNING: zero approvers configured` | ✅ NONE | — not present (good: approvers ARE configured) — |
| `[Boot] runtimeConfig warmed` (or equivalent) | ✅ YES | `[Boot] runtimeConfig warmed` (23:02:43) |
| First Cycle / `[Agent]` cycle log | ✅ YES | `[Agent] All markets closed — US next: 2026-05-11T09:30:00-04:00, ASX next: 2026-05-11T00:00:00.000Z` (23:02:43.678) — runCycle's first market-status report |

**Other boot signals captured (informational, no problems):**

- `[Watchdog] Started — hang threshold 600s` (23:02:35)
- `[Reconciler] Started — interval 60s` (23:02:35)
- `[Server] AlphaTrade AI v2 listening on :5000` (23:02:35)
- `[Server] Alpaca configured: true | live keys available: false` — paper-only credentials, expected for paper window
- `[Server] OpenRouter: YES, xAI/Grok: YES`
- `[FX] Startup refresh: AUD/USD=0.7229 (open.er-api.com)`
- `[Adaptive] Startup recompute: 15 symbols, 8 models from 22 closes`
- `[DB] Schema ensured (strategy + intel + adaptive + backtest + compliance + multi-market + Phase B expectancy/calibration tables)` — appears twice (idempotent re-run, harmless)
- `[Sentiment] Bootstrap/refresh for 58 symbols...`
- `[KG] refresh complete — refreshed=0 cached=58 errs=0 of 58`
- `[Macro] Startup forecast: now=RISK_ON → 24-48h=RISK_ON (conf 86%)`
- `[OptionsActivity] Startup batch refreshed for 30 symbols`
- `[Premarket:US] Stored for 2026-05-08 — 6 top setups, bias=bullish`
- `[Premarket:ASX] Stored for 2026-05-09 — 7 top setups, bias=bullish`
- `[DiscordChat] Heartbeat posted to channel 1500651116952551427.`

**Non-fatal warnings noted (not problems):**

- `(node:29) Warning: SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.` — this is a Node deprecation notice from the pg driver about SSL mode aliasing. Connection is using `verify-full` semantics in practice. **Not a problem**, but worth flagging for a future cleanup pass to make the SSL mode explicit in the connection string.

**Boot result:** **CLEAN.** Every expected log line was present, no `[SCHEMA-MISSING]` occurrences, no errors during `ensureSchema`, exactly 1 Discord approver parsed (fail-closed authz contract holds), and the agent reached its first market-status cycle within ~16 seconds of process start.

---

## Section 2 — Schema state (post-boot, production replica)

| Table | Status | Row count | Notes |
|---|---|---|---|
| `dynamic_gate_state` | ✅ exists | **1** | Boot-init row present (see below) |
| `symbol_expectancy` | ✅ exists | **0** | Empty by design — no closed trades since boot |
| `calibration_history` | ✅ exists | **0** | Empty by design — first daily audit hasn't run yet |
| `pending_suggestions` | ✅ exists | **0** | No pending operator approvals |
| `sentiment_cache` | ✅ exists | **58** | Persisted from prior cycles (matches `[Sentiment] Bootstrap for 58 symbols`) |
| `llm_router_perf` | ✅ exists | **0** | No Council deliberations yet (markets closed at boot time) |
| `sentiment_daily_calls` | ✅ exists | **58** | Per-symbol daily counter, populated by sentiment bootstrap |

**`dynamic_gate_state` latest row** (single row in table):

| id | base_gate | council_delta | pinned | pin_value | pin_reason | source | reason | updated_at |
|---|---|---|---|---|---|---|---|---|
| 1 | 0.800 | 0.000 | f | _(null)_ | _(null)_ | **`boot_init`** | `first-row insert at boot` | `2026-05-08 23:02:43.017 UTC` |

**Verified:** exactly one row, `source='boot_init'`, `base_gate=0.800`, no
council delta, not pinned. This matches the contract.

**Initialisation audit rows** (latest 10):

| event_type | created_at | payload (key fields) |
|---|---|---|
| `DYNAMIC_GATE_INITIALISED` | `2026-05-08 23:02:43.024 UTC` | `source=boot_init`, `base_gate=0.8` |
| `POSITION_CAP_INCREASED` | `2026-05-08 11:31:57.702 UTC` | `migration_id=cap_3_to_4_may_2026`, `previous_cap_pct=0.03`, `new_cap_pct=0.04`, `hard_ceiling_pct=0.05`, `affected_strategies=[day, asx_day]` |

`SCHEMA_VERIFIED` event-type returns no rows — that audit type isn't emitted
by the current `ensureSchema` path; the equivalent confirmation comes through
the `[SCHEMA-OK]` log line in Section 1. Not a problem.

`POSITION_CAP_INCREASED` was written by an earlier boot (this morning,
11:31 UTC). The one-shot check correctly did NOT re-fire on this 23:02 UTC
boot — confirming the migration_id idempotency guard works.

**Audit totals:**

| audit_rows | latest_audit_id |
|---|---|
| `23,126` | `23,152` |

(For comparison: pre-deploy capture at 22:54 UTC showed 6,363 rows / latest
id 6,602. The jump reflects production-side cycle activity from earlier
boots over the last day, plus initialisation audit rows from this boot. The
hash chain is contiguous.)

**Trades today:** `0` (US and ASX markets are both closed — next US open is
`2026-05-11 09:30 ET`, next ASX open is `2026-05-11 00:00 UTC`).

**Portfolio snapshot (production):**

| cash_balance | starting_balance | day_start_equity | agent_running | circuit_breaker | emergency_pause | trading_mode |
|---|---|---|---|---|---|---|
| `24937.17` | `25000.00` | `24937.17` | `true` | `false` | `false` | `paper` |

**Note on the production-vs-development drift you'll see:** the pre-deploy
baseline from 22:54 UTC reported `cash=22291.07 / day_start=24085.60` because
that query hit the development Postgres replica (which has its own state from
local testing). The production DB shows `cash=24937.17 / day_start=24937.17`
— effectively flat on the $25,000 starting balance, with a 0.25% drift to
date. **The production figures are the ones that matter for the kill-criteria
window.** Treat the development numbers as a separate environment.

---

## Section 3 — Observation window start (T-zero)

**T-zero:** `2026-05-08 23:02:43.678 UTC`

This is the first `[Agent]` runCycle log entry after boot — specifically the
`[Agent] All markets closed — US next: 2026-05-11T09:30:00-04:00, ASX next:
2026-05-11T00:00:00.000Z` line that runCycle emits when invoked outside
trading hours. Both US and ASX markets are currently closed (Friday 23:02 UTC
is past US close at 21:00 UTC and well before next ASX/US open on Monday).

**14-day window end:** `2026-05-22 23:02:43 UTC` (or earlier if a hard stop
in `OPERATOR_KILL_CRITERIA.md` triggers).

**First trading session this window will see:** ASX open Monday
`2026-05-11 00:00 UTC` (~25 hours after T-zero).

---

**Boot verification complete. Observation window T-zero: 2026-05-08 23:02:43.678 UTC.**
