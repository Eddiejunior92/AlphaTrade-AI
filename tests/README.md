# Tests — Phase B

Vitest covers the **new math layers** added in the Phase B Master Intelligence
Upgrade. The intent is NOT a full regression suite — `riskManager` core math
(quorum, gate clamping, sizing math, daily-loss budget, drawdown breaker) is
explicitly out of scope and remains byte-for-byte unchanged.

## What is covered

| Test file                       | Surface under test                                                |
|--------------------------------|--------------------------------------------------------------------|
| `smoke.test.js`                | Sanity: vitest wired correctly                                    |
| `hybridCache.test.js`          | LRU + TTL + invalidation contract of `hybridCacheService`         |
| `runtimeConfig.test.js`        | `max_position_pct_day` rename + alias + bounds                    |
| `regimeAdjustment.test.js`     | `dynamicGate.computeRegimeAdjustment()` raise-only invariants     |
| `councilRoles.test.js`         | 8 ROLES present, Adversarial included, quorum threshold raised    |
| `mtfConsensus.test.js`         | Pure MTF agreement scoring                                        |
| `positionSizing.test.js`       | `computeAsymmetricSize()` formula + defence-in-depth bounds       |
| `expectancy.test.js`           | Auto-suspend threshold + reinstate state machine                  |
| `calibration.test.js`          | Bucketed predicted-vs-realized gap detector                       |

## What is NOT covered (intentional)

* `riskManager.evaluateBuy/evaluateSell/checkQuorum/checkCircuitBreaker` — the
  hard-rail math is unchanged; existing prod traffic is the regression suite.
* DB ensureSchema / migrations — exercised at boot, not unit-tested.
* `councilService.deliberate()` end-to-end — Phase B touches roles + Judge
  prompt only; we mock `_callModel` in `councilRoles.test.js` to keep this
  hermetic.

## Running

```bash
npm test           # one shot
npm run test:watch # watch mode
npm run test:ui    # vitest UI on http://localhost:51204
```

Tests must NEVER hit the network, the DB, or any broker. Anything that does
should be mocked via `vi.mock(...)`.
