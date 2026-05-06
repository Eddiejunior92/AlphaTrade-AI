// =============================================================================
// Proactive Alerts Service
// =============================================================================
// Predictive / early-warning detection layer. All alerts are STRICTLY
// INFORMATIONAL — they fire Discord notifications and persist audit rows,
// but do NOT change quorum, sizing, the daily-loss budget, the drawdown
// breaker, the kill switch, or auto-reset behavior. Existing safety rails
// remain the source of truth; this layer only WARNS earlier than they trip.
//
// Design principles:
//   • Pure additive. Service can be deleted at any time and trading is
//     identical. Detection failures are swallowed — never propagate.
//   • Detectors run on a snapshot the agent already computes. No new market-
//     data fetches, no new LLM calls. Cost-free.
//   • Each alert has a stable `key` (e.g. DAILY_LOSS_70PCT) and a per-key
//     cooldown so the same condition cannot spam Discord every 60s.
//   • Self-clearing: an alert that exits its trigger condition resets the
//     cooldown so it can re-fire if the condition recurs later in the day.
//
// Detectors implemented:
//   1. DAILY_LOSS_70PCT       — loss ≥ 70% of effective daily $ budget
//   2. DRAWDOWN_BREAKER_NEAR  — drawdown ≥ 80% of breaker threshold
//   3. LOSS_VELOCITY          — extrapolated EOD loss > budget at current rate
//   4. MACRO_REGIME_SHIFT     — macro forecast diverges to an adverse regime
//   5. MODEL_HEALTH_DEGRADING — number of unhealthy LLMs increased
//   6. MODEL_PERSISTENT_DOWN  — same model unhealthy across N checks
//   7. LLM_COST_TRAJECTORY    — projected EOD LLM spend > soft budget
//   8. STRATEGY_UNDERPERFORM  — today's closed trades for a strategy weak
//
// Public API:
//   runProactiveCheck({ snapshot, perfMetrics })  → { fired, active }
//   getStatus()                                    → { active, history, cooldowns }
//   setEnabled(bool)
// =============================================================================

const db = require('./db');
const discord = require('./discordService');
const llmService = require('./llmService');
const macroForecastService = require('./macroForecastService');

// ---------------------------------------------------------------------------
// Tunables (env-overridable)
// ---------------------------------------------------------------------------
const ENABLED_DEFAULT      = String(process.env.PROACTIVE_ALERTS_ENABLED || 'true').toLowerCase() !== 'false';
const LOSS_WARN_PCT        = parseFloat(process.env.PROACTIVE_LOSS_WARN_PCT     || '0.70'); // 70% of daily budget
const DRAWDOWN_WARN_PCT    = parseFloat(process.env.PROACTIVE_DD_WARN_PCT       || '0.80'); // 80% of breaker threshold
const LLM_DAILY_SOFT_USD   = parseFloat(process.env.LLM_DAILY_SOFT_BUDGET_USD   || '5.00'); // projected $/day soft cap
const STRAT_MIN_CLOSED     = parseInt(process.env.PROACTIVE_STRAT_MIN_CLOSED    || '5');
const STRAT_WIN_RATE_FLOOR = parseFloat(process.env.PROACTIVE_STRAT_WR_FLOOR    || '0.30');
const MODEL_PERSIST_CHECKS = parseInt(process.env.PROACTIVE_MODEL_PERSIST_CHECKS|| '5');     // ≥5 consecutive 60s checks (= ~5 min)
const VELOCITY_MIN_MIN     = parseInt(process.env.PROACTIVE_VELOCITY_MIN_MIN    || '30');    // need 30min elapsed before extrapolating

// Cooldown windows per alert key (ms). After firing, the key cannot fire
// again until either the condition CLEARS (auto-reset) or this elapses.
const COOLDOWN_MS = {
  DAILY_LOSS_70PCT:       30 * 60 * 1000,
  DRAWDOWN_BREAKER_NEAR:  30 * 60 * 1000,
  LOSS_VELOCITY:          30 * 60 * 1000,
  MACRO_REGIME_SHIFT:     60 * 60 * 1000,
  MODEL_HEALTH_DEGRADING: 30 * 60 * 1000,
  MODEL_PERSISTENT_DOWN:  30 * 60 * 1000,
  LLM_COST_TRAJECTORY:    60 * 60 * 1000,
  STRATEGY_UNDERPERFORM:  6  * 60 * 60 * 1000, // ~once per session
};

const ADVERSE_MACRO = new Set(['VOL_SPIKE', 'RATE_SHOCK', 'RISK_OFF', 'STAGFLATION']);

// ---------------------------------------------------------------------------
// Internal state — purely in-memory. Surviving restarts is unnecessary; the
// detectors are stateless given the snapshot.
// ---------------------------------------------------------------------------
let _enabled = ENABLED_DEFAULT;
const _lastFiredByKey = new Map();          // alertKey → ts
const _history = [];                        // ring buffer of last 50 fires
const _modelUnhealthyStreak = new Map();    // modelId → consecutive-unhealthy-checks count
let _prevUnhealthyCount = 0;                // for MODEL_HEALTH_DEGRADING delta

function setEnabled(v) { _enabled = !!v; }
function isEnabled()   { return _enabled; }

function _todayUTC() { return new Date().toISOString().slice(0, 10); }

// US session minute-of-day: 09:30-16:00 ET = 390 trading minutes.
function _minutesElapsedET() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === 'hour')?.value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute')?.value, 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    const cur = h * 60 + m;
    const open = 9 * 60 + 30, close = 16 * 60;
    if (cur < open || cur > close) return null;
    return cur - open;
  } catch (_) { return null; }
}
function _sessionMinutesTotal() { return 390; }

// Cooldown helpers — `clear` lets a no-longer-tripping detector reset its
// own cooldown so the condition can re-fire later in the day if it recurs.
function _onCooldown(key) {
  const last = _lastFiredByKey.get(key) || 0;
  return (Date.now() - last) < (COOLDOWN_MS[key] || 30 * 60 * 1000);
}
function _markFired(key) { _lastFiredByKey.set(key, Date.now()); }
function _clearCooldown(key) { _lastFiredByKey.delete(key); }

function _pushHistory(entry) {
  _history.push({ ts: Date.now(), ...entry });
  if (_history.length > 50) _history.shift();
}

// ---------------------------------------------------------------------------
// Discord rendering — informational embeds (amber 0xffbb33). NEVER red, so
// they're visually distinct from actual breaker / kill-switch alerts.
// ---------------------------------------------------------------------------
async function _notify(alert) {
  try {
    await discord.sendAlert({
      title: `⚠️ Proactive Alert — ${alert.title}`,
      description: `${alert.message}\n\n*Informational only — no safety rule changed. ${alert.recommendation || ''}*`.trim(),
      color: 0xffbb33,
      fields: alert.fields || [],
    });
  } catch (e) {
    console.error('[ProactiveAlerts] Discord notify failed:', e.message);
  }
}

async function _record(alert) {
  try {
    await db.recordAudit({
      event_type: 'PROACTIVE_ALERT',
      payload: {
        key: alert.key,
        title: alert.title,
        message: alert.message,
        severity: alert.severity || 'warn',
        details: alert.details || {},
      },
    });
  } catch (e) {
    console.error('[ProactiveAlerts] Audit record failed:', e.message);
  }
}

async function _fire(alert) {
  _markFired(alert.key);
  _pushHistory({ key: alert.key, title: alert.title, message: alert.message });
  await _notify(alert);
  await _record(alert);
}

// ===========================================================================
// DETECTORS — each returns either an alert object or null. None throw.
// ===========================================================================

// 1. Daily $ loss reached 70% of effective budget but hasn't tripped yet.
function _detectDailyLoss70({ snapshot }) {
  try {
    const lossUSD = Number(snapshot?.dailyLossUSD) || 0;
    const budget  = Number(snapshot?.breakerConfig?.maxDailyLossUSD) || 0;
    if (budget <= 0 || snapshot?.circuitBreakerTripped) return null;
    const ratio = lossUSD / budget;
    if (ratio < LOSS_WARN_PCT) { _clearCooldown('DAILY_LOSS_70PCT'); return null; }
    return {
      key: 'DAILY_LOSS_70PCT',
      title: 'Daily loss approaching budget',
      message: `Today's loss is **$${lossUSD.toFixed(2)}**, which is **${(ratio * 100).toFixed(0)}%** of the $${budget.toFixed(0)} daily budget. ${(100 - ratio * 100).toFixed(0)}% of headroom remains before the breaker would trip on the loss-cap.`,
      recommendation: 'Consider tightening sizing or pausing new entries.',
      details: { lossUSD, budget, ratio },
      fields: [
        { name: 'Loss', value: `$${lossUSD.toFixed(2)}`, inline: true },
        { name: 'Budget', value: `$${budget.toFixed(0)}`, inline: true },
        { name: '% of cap', value: `${(ratio * 100).toFixed(0)}%`, inline: true },
      ],
    };
  } catch (_) { return null; }
}

// 2. Drawdown ≥ 80% of breaker threshold. Independent from $ loss because
//    the breaker trips on EITHER.
function _detectDrawdownNear({ snapshot }) {
  try {
    const dd       = Number(snapshot?.breakerConfig?.currentDrawdownPct) || 0;
    const ddCap    = Number(snapshot?.breakerConfig?.maxDailyDrawdownPct) || 0;
    if (ddCap <= 0 || snapshot?.circuitBreakerTripped) return null;
    const warnAt = ddCap * DRAWDOWN_WARN_PCT;
    if (dd < warnAt) { _clearCooldown('DRAWDOWN_BREAKER_NEAR'); return null; }
    const remaining = (ddCap - dd) * 100;
    return {
      key: 'DRAWDOWN_BREAKER_NEAR',
      title: `Drawdown approaching ${(ddCap * 100).toFixed(0)}% breaker`,
      message: `Drawdown is **${(dd * 100).toFixed(2)}%** vs the **${(ddCap * 100).toFixed(0)}%** breaker threshold (${remaining.toFixed(2)}pp remaining).`,
      recommendation: 'A further adverse move would trip the breaker and flatten all positions.',
      details: { drawdownPct: dd, thresholdPct: ddCap },
      fields: [
        { name: 'Drawdown', value: `${(dd * 100).toFixed(2)}%`, inline: true },
        { name: 'Threshold', value: `${(ddCap * 100).toFixed(0)}%`, inline: true },
        { name: 'Headroom', value: `${remaining.toFixed(2)}pp`, inline: true },
      ],
    };
  } catch (_) { return null; }
}

// 3. Velocity-based projection. If we keep losing at today's average rate,
//    will we exceed the budget by the close? Only meaningful after some
//    elapsed time inside the US session.
function _detectLossVelocity({ snapshot }) {
  try {
    if (snapshot?.circuitBreakerTripped) return null;
    const lossUSD = Number(snapshot?.dailyLossUSD) || 0;
    const budget  = Number(snapshot?.breakerConfig?.maxDailyLossUSD) || 0;
    if (budget <= 0 || lossUSD <= 0) { _clearCooldown('LOSS_VELOCITY'); return null; }
    const elapsed = _minutesElapsedET();
    if (elapsed == null || elapsed < VELOCITY_MIN_MIN) return null;
    const totalMin = _sessionMinutesTotal();
    const remaining = Math.max(0, totalMin - elapsed);
    const lossPerMin = lossUSD / elapsed;
    const projectedAdditional = lossPerMin * remaining;
    const projectedTotal = lossUSD + projectedAdditional;
    if (projectedTotal < budget) { _clearCooldown('LOSS_VELOCITY'); return null; }
    return {
      key: 'LOSS_VELOCITY',
      title: 'Loss velocity on track to exceed daily budget',
      message: `Current loss rate ($${lossPerMin.toFixed(2)}/min over ${elapsed} min) extrapolates to **~$${projectedTotal.toFixed(0)}** by the close — exceeding the $${budget.toFixed(0)} daily budget.`,
      recommendation: 'Loss velocity, not absolute loss, would trip the breaker before close at the current pace.',
      details: { lossUSD, lossPerMin, projectedTotal, budget, elapsedMin: elapsed },
      fields: [
        { name: 'Now', value: `$${lossUSD.toFixed(2)} loss`, inline: true },
        { name: 'EOD projection', value: `$${projectedTotal.toFixed(0)}`, inline: true },
        { name: 'Budget', value: `$${budget.toFixed(0)}`, inline: true },
      ],
    };
  } catch (_) { return null; }
}

// 4. Macro forecast diverges to an adverse regime (VOL_SPIKE, RATE_SHOCK,
//    RISK_OFF, STAGFLATION) with reasonable confidence, AND the current
//    regime is NOT already that regime — i.e. a forecast SHIFT.
function _detectMacroRegimeShift() {
  try {
    const f = macroForecastService.getCached();
    if (!f || f.cold) return null;
    const cur = f.current?.regime;
    const next = f.forecast?.regime;
    const conf = Number(f.forecast?.confidence) || 0;
    if (!ADVERSE_MACRO.has(next)) { _clearCooldown('MACRO_REGIME_SHIFT'); return null; }
    if (cur === next) { _clearCooldown('MACRO_REGIME_SHIFT'); return null; }
    if (conf < 0.55) return null;
    const reasons = (f.forecast?.reasons || []).slice(0, 2).join(' · ') || 'momentum extrapolation';
    return {
      key: 'MACRO_REGIME_SHIFT',
      title: `Macro forecast → ${next}`,
      message: `Cross-asset signals project a regime shift from **${cur}** to **${next}** within the next 24-48h (confidence ${(conf * 100).toFixed(0)}%). ${reasons}.`,
      recommendation: 'Sizing & confidence-gate auto-tighten via the macro layer; consider whether to raise risk-scale or flatten swings ahead of the shift.',
      details: { current: cur, forecast: next, confidence: conf },
      fields: [
        { name: 'Now', value: cur, inline: true },
        { name: 'Forecast (24-48h)', value: next, inline: true },
        { name: 'Confidence', value: `${(conf * 100).toFixed(0)}%`, inline: true },
      ],
    };
  } catch (_) { return null; }
}

// 5/6. Model health: degrading (unhealthy count just increased) and
//      persistent (same model down for ≥ N consecutive checks).
function _detectModelHealth() {
  const out = { degrading: null, persistent: null };
  try {
    const ps = llmService.getProviderStatus();
    const health = ps.health || [];
    const unhealthy = health.filter(h => h.configured && !h.healthy);
    const unhealthyCount = unhealthy.length;

    // Update per-model streaks
    for (const h of health) {
      if (!h.configured) { _modelUnhealthyStreak.delete(h.id); continue; }
      if (h.healthy) _modelUnhealthyStreak.delete(h.id);
      else _modelUnhealthyStreak.set(h.id, (_modelUnhealthyStreak.get(h.id) || 0) + 1);
    }

    // 5. Degrading — unhealthy count INCREASED since previous check, AND
    //    quorum still possible (because if quorum is impossible the existing
    //    banner already alerts loudly).
    if (unhealthyCount > _prevUnhealthyCount && unhealthyCount > 0 && ps.quorumPossible) {
      const list = unhealthy.map(h => h.label).join(', ');
      out.degrading = {
        key: 'MODEL_HEALTH_DEGRADING',
        title: 'LLM health trending down',
        message: `**${unhealthyCount}/${health.length}** model(s) currently unhealthy: ${list}. Quorum is still possible (${ps.activeHealthy}/${ps.activePoolSize} active healthy ≥ ${ps.requiredHealthy} required), but the safety margin is shrinking.`,
        recommendation: 'If a second cheap-tier model fails, quorum will become impossible and trading will halt.',
        details: { unhealthy: unhealthy.map(h => ({ id: h.id, lastError: h.lastError })) },
        fields: [
          { name: 'Healthy', value: `${ps.activeHealthy}/${ps.activePoolSize}`, inline: true },
          { name: 'Required', value: String(ps.requiredHealthy), inline: true },
        ],
      };
    } else if (unhealthyCount === 0) {
      _clearCooldown('MODEL_HEALTH_DEGRADING');
    }
    _prevUnhealthyCount = unhealthyCount;

    // 6. Persistent — any model down for ≥ MODEL_PERSIST_CHECKS in a row.
    const persistent = [...(_modelUnhealthyStreak.entries())]
      .filter(([, n]) => n >= MODEL_PERSIST_CHECKS);
    if (persistent.length > 0) {
      const labels = persistent.map(([id, n]) => {
        const m = health.find(h => h.id === id);
        return `${m?.label || id} (${n} checks, last error: ${m?.lastError || 'n/a'})`;
      }).join('; ');
      out.persistent = {
        key: 'MODEL_PERSISTENT_DOWN',
        title: 'LLM persistently failing',
        message: `Model(s) failing for ≥${MODEL_PERSIST_CHECKS} consecutive health checks: **${labels}**. This is more than a transient blip — the provider may have a sustained outage.`,
        recommendation: 'Check the provider status page or rotate the API key.',
        details: { persistent: persistent.map(([id, n]) => ({ id, checks: n })) },
        fields: persistent.slice(0, 3).map(([id, n]) => {
          const m = health.find(h => h.id === id);
          return { name: m?.label || id, value: `${n} checks down`, inline: true };
        }),
      };
    } else {
      _clearCooldown('MODEL_PERSISTENT_DOWN');
    }
  } catch (_) { /* swallow */ }
  return out;
}

// 7. Project today's LLM spend at the current call rate. If the projected
//    EOD spend exceeds LLM_DAILY_SOFT_USD, warn once.
function _detectLlmCostTrajectory({ perfMetrics }) {
  try {
    const calls = Number(perfMetrics?.ensembleCalls) || 0;
    if (calls < 50) return null; // not enough samples to project
    const startedAt = Number(perfMetrics?.startedAt) || 0;
    if (!startedAt) return null;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs < 30 * 60 * 1000) return null; // need ≥ 30min elapsed for a stable rate
    const callCost = Number(process.env.LLM_CALL_COST_USD) || 0.002;
    const elapsed = _minutesElapsedET();
    if (elapsed == null || elapsed < VELOCITY_MIN_MIN) return null;
    const remaining = Math.max(0, _sessionMinutesTotal() - elapsed);
    const callsPerMin = calls / elapsed;
    const projectedCalls = calls + callsPerMin * remaining;
    const projectedUSD = projectedCalls * callCost;
    if (projectedUSD < LLM_DAILY_SOFT_USD) { _clearCooldown('LLM_COST_TRAJECTORY'); return null; }
    return {
      key: 'LLM_COST_TRAJECTORY',
      title: 'LLM spend on track to exceed soft budget',
      message: `Current LLM call rate (${callsPerMin.toFixed(1)}/min over ${elapsed} min) projects to **~$${projectedUSD.toFixed(2)}** of LLM cost by the close, vs the **$${LLM_DAILY_SOFT_USD.toFixed(2)}** soft daily budget.`,
      recommendation: 'Consider raising LLM_QUIET_REGIMES coverage or LLM_SKIP_TTL_SECONDS to reduce call volume.',
      details: { calls, callsPerMin, projectedCalls, projectedUSD, softBudget: LLM_DAILY_SOFT_USD },
      fields: [
        { name: 'Calls so far', value: String(calls), inline: true },
        { name: 'EOD projection', value: `$${projectedUSD.toFixed(2)}`, inline: true },
        { name: 'Soft budget', value: `$${LLM_DAILY_SOFT_USD.toFixed(2)}`, inline: true },
      ],
    };
  } catch (_) { return null; }
}

// 8. Strategy underperformance for today: a strategy with ≥ STRAT_MIN_CLOSED
//    closed trades and a win rate below STRAT_WIN_RATE_FLOOR.
async function _detectStrategyUnderperform() {
  try {
    const date = _todayUTC();
    const { rows } = await db.query(`
      SELECT strategy,
             COUNT(*)::int                       AS n,
             COUNT(*) FILTER (WHERE won)::int    AS wins,
             COALESCE(SUM(pnl_usd), 0)::float    AS pnl
      FROM trade_memory
      WHERE created_at >= $1::date
        AND created_at <  ($1::date + INTERVAL '1 day')
      GROUP BY strategy
    `, [date]);
    const weak = rows.filter(r => r.n >= STRAT_MIN_CLOSED && (r.wins / r.n) < STRAT_WIN_RATE_FLOOR);
    if (!weak.length) { _clearCooldown('STRATEGY_UNDERPERFORM'); return null; }
    const lines = weak.map(w => `${w.strategy}: ${w.wins}/${w.n} wins (${(w.wins / w.n * 100).toFixed(0)}%), P&L $${w.pnl.toFixed(2)}`);
    return {
      key: 'STRATEGY_UNDERPERFORM',
      title: 'Strategy underperforming today',
      message: `One or more strategies are below the **${(STRAT_WIN_RATE_FLOOR * 100).toFixed(0)}%** win-rate floor today (n ≥ ${STRAT_MIN_CLOSED}):\n• ${lines.join('\n• ')}`,
      recommendation: 'Consider disabling the strategy for the rest of the session if the regime looks unfavorable for it.',
      details: { weak },
    };
  } catch (_) { return null; }
}

// ===========================================================================
// Orchestrator — called every minute by agent.js
// ===========================================================================
async function runProactiveCheck({ snapshot, perfMetrics } = {}) {
  if (!_enabled) return { fired: [], active: [], skipped: 'disabled' };
  if (!snapshot) return { fired: [], active: [], skipped: 'no-snapshot' };

  const detectors = [];
  detectors.push(_detectDailyLoss70({ snapshot }));
  detectors.push(_detectDrawdownNear({ snapshot }));
  detectors.push(_detectLossVelocity({ snapshot }));
  detectors.push(_detectMacroRegimeShift());
  const mh = _detectModelHealth();
  if (mh.degrading)  detectors.push(mh.degrading);
  if (mh.persistent) detectors.push(mh.persistent);
  detectors.push(_detectLlmCostTrajectory({ perfMetrics }));
  try { detectors.push(await _detectStrategyUnderperform()); } catch (_) {}

  const active = detectors.filter(Boolean);
  const fired = [];
  for (const a of active) {
    if (_onCooldown(a.key)) continue;
    try { await _fire(a); fired.push(a.key); }
    catch (e) { console.error(`[ProactiveAlerts] Fire failed for ${a.key}:`, e.message); }
  }
  return { fired, active: active.map(a => ({ key: a.key, title: a.title, message: a.message })) };
}

function getStatus() {
  const now = Date.now();
  const cooldowns = {};
  for (const [k, ts] of _lastFiredByKey.entries()) {
    const remainMs = Math.max(0, (COOLDOWN_MS[k] || 0) - (now - ts));
    cooldowns[k] = { lastFiredTs: ts, cooldownRemainingMs: remainMs };
  }
  return {
    enabled: _enabled,
    history: _history.slice().reverse(),
    cooldowns,
    config: {
      LOSS_WARN_PCT, DRAWDOWN_WARN_PCT, LLM_DAILY_SOFT_USD,
      STRAT_MIN_CLOSED, STRAT_WIN_RATE_FLOOR,
      MODEL_PERSIST_CHECKS, VELOCITY_MIN_MIN,
    },
  };
}

module.exports = {
  runProactiveCheck,
  getStatus,
  setEnabled,
  isEnabled,
};
