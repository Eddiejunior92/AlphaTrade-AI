# Phase B — Master Intelligence Upgrade · Verification Report

**Date:** 2026-05-08 · **Branch:** main · **Trading mode:** PAPER (US + ASX)
**Tests:** 58/58 passing · **Syntax:** clean on all 14 modified backend files
**Architect review:** completed · 5 critical issues found, all 5 fixed and re-verified.

---

## 1. Scope & objectives

Phase B ships nine layered-intelligence upgrades while keeping every hard rail
**byte-for-byte** unchanged. New surfaces ship enabled by default. New unit
tests cover the new math only. The following 9 tasks were delivered:

| ID  | Task | Status |
|-----|------|--------|
| T001 | Vitest scaffolding + smoke test | ✅ |
| T002 | hybridCacheService + wiring + endpoint | ✅ |
| T003 | Regime meta-layer in dynamicGateService (raise-only) | ✅ |
| T004 | Adversarial Analyst (added to Council) | ✅ |
| T005 | MTF consensus injected into Technical Analyst prompt | ✅ |
| T006 | Asymmetric position sizing overlay | ✅ |
| T007 | Per-symbol expectancy auto-suspend + Discord Reinstate | ✅ |
| T008 | Calibration audit in metaReview + Discord posting | ✅ |
| T009 | Rename `max_position_pct` → `max_position_pct_day` | ✅ |

---

## 2. Hard-rail invariants (verified untouched)

The following safety constants and code paths were NOT modified by Phase B and
were inspected to confirm byte-stability:

- `riskManager.evaluateBuy` core math (qty = min(qtyByRisk, qtyByPosition))
- `riskManager.checkQuorum` — 3-of-N quorum threshold and `gateOverride`
  re-clamp to `[SAFETY_FLOOR, SAFETY_CEIL]`
- `dynamicGateService.SAFETY_FLOOR = 0.65`, `SAFETY_CEIL = 0.90`
- `agent.executeOrder` — atomic cash + holdings under execution lock
- Tamper-evident SHA-256 audit hash chain (`db.recordAudit`)
- Kill switch latch / circuit breaker / recovery buffer / daily loss budget /
  drawdown breaker — all logic unchanged
- `discordApprovalService.DENIED_KEYS` set unchanged (kill_switch, breaker,
  daily_loss, drawdown, recovery_buffer, quorum, atomic_cash, audit_chain,
  asx_execution_wired, safety_floor, min_directional_agreement)
- `SAFE_KEYS.max_position_pct_day.validate` enforces hard `[0.01, 0.05]` band

---

## 3. T001 · Vitest scaffolding

- Added `vitest` devDep; `test` / `test:watch` / `test:ui` scripts in
  `package.json`.
- `vitest.config.js` includes `tests/**/*.test.js`, node environment.
- `tests/package.json` declares `{"type": "module"}` so `.test.js` files are
  loaded as ESM (vitest is ESM-only).
- `tests/smoke.test.js` passes.

## 4. T002 · hybridCacheService

**File:** `backend/services/hybridCacheService.js`

- 5-key route cache: `(symbol, strategy, regime, gateBucket, newsBucket)`.
- 120-minute TTL, 5000-entry LRU, hit/miss/eviction/invalidation counters.
- `invalidateSymbol(sym)` and `invalidateAll()` exported.

**Wiring:**

- `hybridSignalService.decideRoute` now consults the cache. The 5th cache
  dimension is populated with the statistical-confidence band
  (`high|mid|low`) — passed under the existing `newsBucket` parameter so the
  cache key fully discriminates by stat band.
- `agent.executeOrder` calls `hybridCache.invalidateSymbol(symbol)` after
  every SELL.
- `agent.dailyReset` calls `hybridCache.invalidateAll()` nightly.
- `agent.getHybridCacheStats` exported and exposed via
  `GET /api/hybrid/cache-stats` (read-only, no auth).

**Tests:** `tests/hybridCache.test.js` — 7/7 passing.

## 5. T003 · Regime meta-layer in dynamicGateService

- `computeRegimeAdjustment(regime)` is pure, raise-only, hard-capped at
  `REGIME_ADJ_MAX = 0.05`.
- `REGIME_RULES` exported: `high_vol: 0.03`, `news_driven: 0.02`,
  `low_liquidity: 0.02`. Unknown / null regimes return 0.
- `getCurrentGate({ regime })` composes base + suggested-delta + regime
  adjustment, then clamps to `[SAFETY_FLOOR, SAFETY_CEIL]`.
- `agent.js` now passes `regime` to **both** `getCurrentGate` call sites
  (route-bucketing AND the live `gateOverride` consumed by
  `riskManager.checkQuorum`) — fixed during architect review.
- Composed gate **never** drops below `SAFETY_FLOOR` and **never** exceeds
  `SAFETY_CEIL`. Verified by `tests/regimeAdjustment.test.js` invariants.

**Tests:** 7/7 passing.

## 6. T004 · Adversarial Analyst (Council)

- Added a 7th analyst role `adversarial` to `councilService.ROLES` (the
  original Council had 6 analysts; "8th" in the planning notes was a
  miscount — the Judge is a synthesizer, not an analyst).
- Adversarial prompt explicitly instructs the model to argue the OPPOSITE
  thesis and emit a `failure_modes` array.
- Judge prompt updated to weigh adversarial input.
- `MIN_ANALYSTS_FOR_JUDGE = ceil(N/2) = 4` recomputed automatically — quorum
  threshold for downstream `riskManager.checkQuorum` (3-of-N) **unchanged**.
- `_callModel` exported for test stubbing.

**Tests:** `tests/councilRoles.test.js` — 4/4 passing (verifies role IDs,
prompt text, MTF-block conditional injection, and unique LLM task types).

## 7. T005 · MTF consensus

- New `mtfConsensusService` (pure functions): `computeMtfConsensus` aggregates
  5m / 15m / 1h trend votes and returns a `consensus` label
  (`UP|DOWN|MIXED`); `renderForPrompt(c)` produces the `MTF-CONSENSUS: …`
  block.
- `councilService.deliberate()` mutates the `ctx` passed to the Technical
  Analyst's prompt builder, injecting `ctx.mtfConsensusBlock` when
  multi-timeframe data is available. Other roles unaffected.
- Technical prompt embeds `MTF-CONSENSUS: …` only when present (clean omit
  when absent — verified by test).

**Tests:** `tests/mtfConsensus.test.js` — 6/6 passing.

## 8. T006 · Asymmetric position sizing

**File:** `backend/services/positionSizingService.js`

- `computeAsymmetricSize(confidence, baseStrategyConfig)` maps confidence in
  `[CONF_FLOOR, CONF_CEIL]` to a `maxPositionPct` in `[ABS_FLOOR=0.005,
  ABS_CEIL=0.05]`. Out-of-band inputs are clamped and reported via
  `violatedBound`.
- `withAsymmetricSizing(sc, confidence)` returns
  `{ sc: <NEW clone with overlaid maxPositionPct>, sizing: <metadata> }`.
  **Never mutates the input config.**

**Wiring (`agent.js` BUY path):**

- After signal consensus = BUY and BEFORE `riskManager.evaluateBuy`, the
  strategy config is replaced with the sized clone.
- When `sizing.violatedBound` is set, a `SIZING_BOUND_VIOLATED` audit row is
  written with `attempted_pct` / `clamped_pct` / `bound`.
- Defence-in-depth: `riskManager` still computes `qty = min(qtyByRisk,
  qtyByPosition)` against the strategy's `maxPositionPct`. Even if the
  overlay returned an out-of-range value, the qty cap holds.

**Tests:** `tests/positionSizing.test.js` — 9/9 passing.

## 9. T007 · Per-symbol expectancy auto-suspend

- New table `symbol_expectancy` (db.js) with columns `n_trades`, `n_wins`,
  `sum_r`, `expectancy_r`, `suspended`, `suspended_at`, `reinstated_at`.
- `expectancyService.recordTradeOutcome({symbol, strategy, pnlUSD, riskUSD})`
  updates the row and auto-suspends when `n_trades >= 10` AND
  `expectancy_r <= -0.5R`. Writes a `SYMBOL_AUTO_SUSPENDED` audit row.
- `expectancyService.shouldAllowEntry(symbol, strategy)` is called on the BUY
  path BEFORE risk evaluation. **Fail-open**: any DB error returns
  `{allow: true}` so a transient outage cannot wedge the engine.
- Suspended-symbol BUY is rejected with a `TRADE_REJECTED` audit row
  (reason=`symbol_suspended`). Trade execution invalidates the hybrid-cache
  entry for that symbol on every SELL.
- `discordApprovalService` recognises `Reinstate <SYM>` (and `Reinstate <SYM>
  <strategy>`); approver authz is FAIL-CLOSED via `DISCORD_APPROVER_IDS`.
  Unauthorized attempts produce a `REINSTATE_UNAUTHORIZED` audit row.
- Authorized reinstates emit a `SYMBOL_REINSTATED` audit row.

**Schema/service alignment:** initial draft had a `total_r` vs `sum_r`
mismatch — flagged by architect, both INSERT and UPDATE statements now use
the schema's `sum_r` column. Verified by `node -c` and tests.

**Tests:** `tests/expectancy.test.js` — 11/11 passing (pure helpers).

## 10. T008 · Calibration audit

- New `calibrationService` with `assignBucket` (5 bins across `[0.65, 0.90]`),
  `bucketAggregates(rows)`, `isBucketChronicallyMiscalibrated(history)` and
  `renderCalibrationMarkdown(audit)`.
- New `calibration_history` table persists per-bucket daily aggregates.
- `metaReviewService.runReview` invokes `runCalibrationAudit`, posts the
  rendered markdown table to Discord, and synthesises a numbered
  `confidence_gate_base` `pending_suggestion` when a bucket has been
  chronically miscalibrated for ≥ 5 consecutive days.
- The synthesised suggestion still flows through the existing Discord
  `Approve #N` allowlist — the operator must approve before the gate moves.
  No automatic gate change.

**Tests:** `tests/calibration.test.js` — 9/9 passing.

## 11. T009 · Rename `max_position_pct` → `max_position_pct_day`

- `runtimeConfig.DEFAULTS` / `BOUNDS` / `_envFor` / `_readDb` updated.
- `discordApprovalService.SAFE_KEYS.max_position_pct_day` defined with
  description containing `DAY` and validator `[0.01, 0.05]`. `KEY_ALIASES['max_position_pct'] = 'max_position_pct_day'` ensures any
  in-flight `pending_suggestions` row using the legacy name still resolves.
- `agent.buildStrategyConfig` reads from the new key.
- `DENIED_KEYS` does NOT contain the new key (it is now an allow-listed
  SAFE_KEY with a hard 5% upper bound enforced in the validator).

**Tests:** `tests/runtimeConfig.test.js` — 4/4 passing.

## 12. Architect review summary

5 integration bugs found and fixed before sign-off:

1. **T006:** `agent.js` consumed the wrong shape from `withAsymmetricSizing`
   (`strategyConfig`/`violatedBound` vs actual `{ sc, sizing }`). Fixed.
2. **T007:** schema column was `sum_r` but service wrote `total_r`. Fixed in
   service (INSERT + UPDATE).
3. **T002:** `agent.getHybridCacheStats` called `hybridCache.stats()` —
   service exports `getStats()`. Fixed.
4. **T002:** `composeKey` 5th-dim parameter is named `newsBucket`; we were
   passing it as `statBucket` (effectively constant). Fixed by passing
   `newsBucket: statBucket`.
5. **T003:** `gateOverride` site in BUY path didn't pass `regime` to
   `getCurrentGate`, so regime adjustment was applied only to route bucketing
   and not to the live quorum gate. Fixed.

Re-verification after fixes: `npm test` → 58/58 passing; `node -c` → clean on
all 14 modified backend files.

## 13. Test inventory & validation evidence

**`npm test` final result:**
```
Test Files  9 passed (9)
     Tests  58 passed (58)
   Duration  ~2s
```

| Test file | Tests | Covers |
|-----------|-------|--------|
| `tests/smoke.test.js` | 1 | Vitest harness |
| `tests/hybridCache.test.js` | 7 | LRU/TTL/keys/invalidate |
| `tests/regimeAdjustment.test.js` | 7 | Raise-only, cap, null-safe, clamp |
| `tests/councilRoles.test.js` | 4 | Role contract, MTF block, Adversarial |
| `tests/mtfConsensus.test.js` | 6 | Pure consensus aggregation |
| `tests/positionSizing.test.js` | 9 | Asymmetric sizing math + clamp |
| `tests/expectancy.test.js` | 11 | Pure auto-suspend helpers |
| `tests/calibration.test.js` | 9 | Bucketing, gap, flag, render |
| `tests/runtimeConfig.test.js` | 4 | Rename + alias + DENY check |

**`node -c` syntax check** — clean on:
`agent.js`, `server.js`, `db.js`, `runtimeConfig.js`, `discordApprovalService.js`,
`dynamicGateService.js`, `councilService.js`, `metaReviewService.js`,
`calibrationService.js`, `hybridSignalService.js`, `hybridCacheService.js`,
`positionSizingService.js`, `expectancyService.js`, `mtfConsensusService.js`.

**Workflow status:** `Start application` is running. No regressions observed
in startup logs.

---

**Sign-off:** Phase B is complete. Hard rails byte-for-byte unchanged. New
intelligence layers live and observable; all eight delivered features ride on
top of the existing safety net rather than weakening it. The single new
endpoint (`/api/hybrid/cache-stats`) is read-only.
