// =============================================================================
// DYNAMIC HEDGING SERVICE — Upgrade #3 / Capital & Risk Capacity
// =============================================================================
//
// PURELY ADVISORY. Reads the current portfolio + the latest VaR snapshot +
// macro regime + daily-loss-budget utilization, and emits a SUGGESTED hedging
// posture as a prompt-context block. The LLM ensemble can choose to act or
// ignore; quorum (3-of-4 raw), the 75-85% confidence gate, the daily loss
// budget, the 5% drawdown breaker, the kill switch, and the existing
// `hedgingService.js` (which performs auto-hedging at much higher thresholds)
// are all unchanged and retain full veto power.
//
// Heuristics (deliberately conservative — these are SUGGESTIONS, not actions):
//   • Long-only equity exposure → if risk-utilization > 60% AND macro = RISK_OFF,
//     suggest 5-10% inverse hedge (SH or SQQQ) or raising cash.
//   • Concentration → if any single name > 25% of portfolio notional, flag it.
//   • Beta-weighted exposure → uses 1.0 as default beta (we don't track per-
//     symbol betas yet); future-proofed via the `betaLookup` parameter.
//   • Drawdown proximity → if intraday loss > 70% of the daily budget,
//     suggest pausing new entries (advisory).
//   • Crypto/high-beta concentration → if BITO/COIN/MSTR > 15% notional,
//     suggest scaling back during high-VIX regimes.
// =============================================================================

const HEDGE_TTL_MS = 30 * 60 * 1000; // 30 min

const HIGH_BETA_TICKERS = new Set(['TSLA', 'NVDA', 'COIN', 'MSTR', 'PLTR', 'AMD', 'SMCI', 'ARM']);
const CRYPTO_PROXY = new Set(['COIN', 'MSTR', 'BITO', 'IBIT', 'GBTC', 'MARA', 'RIOT']);

let _cache = null; // { ts, data }

async function ensureSchema() { /* no-op */ }

// Compute concentration + beta-weighted exposure given holdings + USD prices.
function buildExposure(holdings, priceLookup, betaLookup = {}) {
  let totalLongNotional = 0;
  let totalShortNotional = 0;
  let highBetaNotional = 0;
  let cryptoNotional = 0;
  let betaWeightedNotional = 0;
  const positions = [];
  for (const h of holdings) {
    const qty = parseFloat(h.qty);
    const px = priceLookup[h.symbol];
    if (!Number.isFinite(qty) || qty === 0 || !Number.isFinite(px) || px <= 0) continue;
    const notional = qty * px;
    const beta = Number.isFinite(betaLookup[h.symbol]) ? betaLookup[h.symbol] : 1.0;
    positions.push({ symbol: h.symbol, qty, px, notional, beta });
    if (notional > 0) totalLongNotional += notional;
    else totalShortNotional += Math.abs(notional);
    betaWeightedNotional += notional * beta;
    if (HIGH_BETA_TICKERS.has(h.symbol)) highBetaNotional += Math.abs(notional);
    if (CRYPTO_PROXY.has(h.symbol)) cryptoNotional += Math.abs(notional);
  }
  const grossNotional = totalLongNotional + totalShortNotional;
  positions.sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional));
  const topConcentration = grossNotional > 0
    ? positions.slice(0, 3).map(p => ({
        symbol: p.symbol,
        pct: +((Math.abs(p.notional) / grossNotional) * 100).toFixed(1),
        notional: +p.notional.toFixed(2),
      }))
    : [];
  return {
    grossNotional: +grossNotional.toFixed(2),
    netNotional: +(totalLongNotional - totalShortNotional).toFixed(2),
    totalLongNotional: +totalLongNotional.toFixed(2),
    totalShortNotional: +totalShortNotional.toFixed(2),
    betaWeightedNotional: +betaWeightedNotional.toFixed(2),
    highBetaPct: grossNotional > 0 ? +((highBetaNotional / grossNotional) * 100).toFixed(1) : 0,
    cryptoPct: grossNotional > 0 ? +((cryptoNotional / grossNotional) * 100).toFixed(1) : 0,
    topConcentration,
    positionCount: positions.length,
  };
}

// Generate suggestion strings from the joined context. Each suggestion is
// purely informational — the LLM can use, ignore, or push back.
function generateSuggestions(exposure, varSnapshot, macroRegime, dailyLossUtilizationPct) {
  const suggestions = [];

  const varUtil = varSnapshot?.varUtilizationPct;
  const isRiskOff = macroRegime === 'RISK_OFF' || macroRegime === 'RISK-OFF';
  const isRiskOn  = macroRegime === 'RISK_ON'  || macroRegime === 'RISK-ON';

  // 1. High VaR utilization in adverse regime → suggest inverse hedge or cash.
  if (Number.isFinite(varUtil) && varUtil > 60 && isRiskOff) {
    suggestions.push({
      severity: 'high',
      category: 'macro_hedge',
      action: `Consider 5-10% inverse hedge (SH for SPY exposure, SQQQ for tech-heavy) or raising cash — VaR utilization ${varUtil}% in RISK_OFF regime.`,
    });
  } else if (Number.isFinite(varUtil) && varUtil > 80) {
    suggestions.push({
      severity: 'high',
      category: 'budget_utilization',
      action: `VaR utilization ${varUtil}% of daily loss budget — defer new entries or trim largest positions.`,
    });
  } else if (Number.isFinite(varUtil) && varUtil > 50) {
    suggestions.push({
      severity: 'medium',
      category: 'budget_utilization',
      action: `VaR utilization ${varUtil}% — moderate; new entries should clear an above-average confidence bar.`,
    });
  }

  // 2. Single-name concentration > 25%.
  for (const c of exposure.topConcentration || []) {
    if (c.pct > 25) {
      suggestions.push({
        severity: 'medium',
        category: 'concentration',
        action: `${c.symbol} is ${c.pct}% of portfolio — single-name concentration risk; consider trimming or pairing with sector hedge.`,
      });
      break; // one mention is enough
    }
  }

  // 3. High-beta concentration > 30% in elevated-vol regime (proxy via RISK_OFF).
  if (exposure.highBetaPct > 30 && isRiskOff) {
    suggestions.push({
      severity: 'medium',
      category: 'beta_concentration',
      action: `High-beta exposure ${exposure.highBetaPct}% of book in RISK_OFF regime — vol-shock vulnerability elevated.`,
    });
  }

  // 4. Crypto-proxy exposure in adverse regime.
  if (exposure.cryptoPct > 15 && isRiskOff) {
    suggestions.push({
      severity: 'medium',
      category: 'crypto_exposure',
      action: `Crypto-proxy exposure ${exposure.cryptoPct}% in RISK_OFF regime — historically correlates with risk-asset drawdowns.`,
    });
  }

  // 5. Daily loss budget proximity (separate from VaR — based on REALISED PnL).
  if (Number.isFinite(dailyLossUtilizationPct) && dailyLossUtilizationPct > 70) {
    suggestions.push({
      severity: 'high',
      category: 'realised_loss_proximity',
      action: `Today's realised loss is ${dailyLossUtilizationPct}% of the daily budget — breaker trips at 100%. Defer marginal trades.`,
    });
  }

  // 6. Worst stress scenario > daily budget → flag.
  if (varSnapshot?.worstStressUSD != null && varSnapshot?.dailyLossBudgetUSD > 0) {
    const worstAbs = Math.abs(varSnapshot.worstStressUSD);
    if (worstAbs > varSnapshot.dailyLossBudgetUSD * 2) {
      suggestions.push({
        severity: 'high',
        category: 'tail_risk',
        action: `Worst-case stress (${(varSnapshot.stressScenarios?.[0]?.name || 'scenario')}) would be ~$${worstAbs.toFixed(0)}, > 2× daily loss budget — tail-risk hedge worth weighing.`,
      });
    }
  }

  // 7. RISK_ON + flat exposure → opportunity note (informational, NOT a buy
  //    signal — quorum still owns every entry decision).
  if (isRiskOn && exposure.netNotional < exposure.grossNotional * 0.3 && (varUtil == null || varUtil < 30)) {
    suggestions.push({
      severity: 'low',
      category: 'capacity_headroom',
      action: `Capacity headroom: VaR low + RISK_ON regime + relatively flat book — room to deploy if quorum + gate align.`,
    });
  }

  return suggestions;
}

async function refresh(holdings, priceLookup, varSnapshot, macroRegime, dailyLossUtilizationPct, betaLookup = {}) {
  try {
    const exposure = buildExposure(holdings || [], priceLookup || {}, betaLookup);
    const suggestions = generateSuggestions(exposure, varSnapshot, macroRegime, dailyLossUtilizationPct);
    const data = {
      ok: true,
      ts: Date.now(),
      regime: macroRegime || null,
      exposure,
      suggestions,
      counts: {
        high: suggestions.filter(s => s.severity === 'high').length,
        medium: suggestions.filter(s => s.severity === 'medium').length,
        low: suggestions.filter(s => s.severity === 'low').length,
      },
    };
    _cache = { ts: Date.now(), data };
    return data;
  } catch (e) {
    return { ok: false, reason: e.message, ts: Date.now() };
  }
}

function getCached() {
  if (!_cache) return null;
  if (Date.now() - _cache.ts > HEDGE_TTL_MS) return null;
  return _cache.data;
}

function getCachedRaw() {
  if (!_cache) return null;
  return { ..._cache.data, _ageMs: Date.now() - _cache.ts, _stale: Date.now() - _cache.ts > HEDGE_TTL_MS };
}

function renderForPrompt(d) {
  if (!d || !d.ok || !d.suggestions?.length) return null;
  const e = d.exposure;
  const lines = [];
  lines.push(`Dynamic hedging posture (advisory — execution requires quorum + 75-85% gate):`);
  lines.push(`  Book: gross $${e.grossNotional.toFixed(0)} · net $${e.netNotional.toFixed(0)} · ${e.positionCount} positions · highBeta ${e.highBetaPct}%${e.cryptoPct > 0 ? ` · crypto ${e.cryptoPct}%` : ''}`);
  if (e.topConcentration?.length) {
    lines.push(`  Top: ${e.topConcentration.map(c => `${c.symbol} ${c.pct}%`).join(' · ')}`);
  }
  for (const s of d.suggestions.slice(0, 5)) {
    const tag = s.severity === 'high' ? '!' : s.severity === 'medium' ? '·' : '·';
    lines.push(`  ${tag} ${s.action}`);
  }
  return lines.join('\n');
}

module.exports = {
  ensureSchema, refresh, getCached, getCachedRaw, renderForPrompt,
  _internal: { buildExposure, generateSuggestions, HIGH_BETA_TICKERS, CRYPTO_PROXY },
};
