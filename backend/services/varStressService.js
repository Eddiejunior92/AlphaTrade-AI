// =============================================================================
// VAR + STRESS-TEST SERVICE — Upgrade #3 / Capital & Risk Capacity
// =============================================================================
//
// Computes PORTFOLIO-LEVEL Value-at-Risk (1-day, 95% + 99%) two ways:
//   • Historical VaR — empirical percentile of synthetic past portfolio
//     returns. Synthetic = Σ_i weight_i × daily_return_i over last 252
//     trading days, where weights come from CURRENT holdings × USD price.
//   • Monte-Carlo VaR — estimate μ + σ of the synthetic series, simulate
//     N=5000 next-day returns from a normal distribution, take the
//     5th / 1st percentiles. Provides a smoother estimate when the
//     historical sample is sparse or the distribution is well-behaved.
//
// Then runs a fixed bank of STRESS scenarios against the current portfolio
// (market crash, vol spike, rates up, crypto crash, sector rotation), each
// expressed as per-symbol % shocks — multiplied by holdings to get $ impact.
//
// Source data: `historical_intelligence` table (already populated daily, 20Y
// of closes per symbol). No extra API calls are made by this service.
//
// SAFETY CONTRACT — STRICTLY INFORMATIONAL.
//   • Outputs flow ONLY into the LLM prompt's upgradeContext block.
//   • Cannot bypass quorum, the 75-85% confidence gate, the $100/day loss
//     budget, the 5% drawdown breaker, the kill switch, or any sizing math.
//   • All failures swallow to null → trading loop never crashes here.
// =============================================================================

const db = require('./db');
const fxService = require('./fxService');
const marketRegistry = require('./marketRegistry');
const brokerRouter = require('./brokerRouter');

// Per-symbol daily-bar cache. Daily closes only change once per day, so a
// 6-hour TTL is plenty and bounds API usage even if VaR is queried often.
const _barsCache = new Map(); // symbol -> { ts, closes }
const BARS_TTL_MS = 6 * 60 * 60 * 1000;

const MS_HOUR = 3600 * 1000;
const HIST_LOOKBACK_DAYS = 252;        // ~1 trading year
const MC_SIMS = 5000;                   // Monte-Carlo iterations
const VAR_TTL_MS = 30 * 60 * 1000;      // 30-min cache
const MC_SEED_DEFAULT = 0xC0FFEE;       // deterministic by default

// In-process cache. One entry — portfolio-level snapshot.
let _cache = null; // { ts, data }

// ---- Stress scenario bank ---------------------------------------------------
// Each scenario maps SYMBOL_PATTERNS or sector buckets → % price shock.
// Patterns supported: '*' (all), 'CRYPTO' (bito-style), exact ticker match.
// Defaults are conservative single-day shocks calibrated to historical
// 1-in-20-year events (e.g. Aug 2024 yen carry unwind, Mar 2020 Covid).
const STRESS_SCENARIOS = [
  {
    name: 'market_crash_5',
    description: 'Broad equity sell-off (-5% across indices)',
    shocks: { '*': -0.05 },
  },
  {
    name: 'market_crash_10',
    description: 'Severe equity sell-off (-10% across indices, -15% high-beta)',
    shocks: { '*': -0.10, 'TSLA': -0.15, 'NVDA': -0.15, 'COIN': -0.20, 'PLTR': -0.18 },
  },
  {
    name: 'vol_spike',
    description: 'VIX shock (+50%) — high-beta names down 8%, low-beta down 3%',
    shocks: { '*': -0.04, 'TSLA': -0.08, 'NVDA': -0.08, 'AMD': -0.07, 'COIN': -0.10 },
  },
  {
    name: 'rates_up_50bps',
    description: 'Rates +50bps single-day — long-duration tech down 6%, banks up 1%',
    shocks: { '*': -0.03, 'TSLA': -0.06, 'NVDA': -0.05, 'GOOGL': -0.04, 'MSFT': -0.04, 'JPM': 0.01, 'BAC': 0.01 },
  },
  {
    name: 'crypto_crash',
    description: 'BTC -25%, crypto-adjacent names hit hardest',
    shocks: { '*': -0.01, 'COIN': -0.20, 'MSTR': -0.18, 'TSLA': -0.04 },
  },
  {
    name: 'sector_rotation_growth_to_value',
    description: 'Mega-cap tech down 5%, financials/energy up 2%',
    shocks: {
      'AAPL': -0.05, 'MSFT': -0.05, 'NVDA': -0.06, 'GOOGL': -0.05, 'META': -0.05, 'AMZN': -0.05, 'TSLA': -0.07,
      'JPM': 0.02, 'BAC': 0.02, 'WFC': 0.02, 'XOM': 0.025, 'CVX': 0.02,
    },
  },
];

// ---- Schema (in-memory only — no new tables needed) ------------------------
async function ensureSchema() { /* no-op */ }

// ---- Stat helpers -----------------------------------------------------------
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.max(0, Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length)));
  return sortedArr[idx];
}

// Box-Muller transform with a deterministic LCG so test runs are reproducible.
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---- Pull daily closes for a symbol (per-symbol cached, 6h TTL) -------------
// Uses brokerRouter so US and ASX symbols both work transparently. Cache
// keeps us under 1 broker call per symbol per 6 hours regardless of how
// often VaR is recomputed.
async function getDailyCloses(symbol, n = HIST_LOOKBACK_DAYS + 5) {
  try {
    const cached = _barsCache.get(symbol);
    if (cached && Date.now() - cached.ts < BARS_TTL_MS) return cached.closes.slice(-n);
    // Alpaca returns 0 bars without a `start` window; pass a generous lookback
    // (calendar days, not trading days) and `noMock:true` so we never compute
    // VaR off synthetic data — that would produce convincingly precise but
    // fabricated risk numbers and silently feed them to the LLM ensemble.
    const start = new Date(Date.now() - (n + 60) * 24 * 3600 * 1000).toISOString();
    const bars = await brokerRouter.getBars(symbol, '1Day', n, { start, adjustment: 'all', noMock: true });
    if (!Array.isArray(bars) || bars.length < 30) return null;
    const closes = bars.map(b => +(b.c ?? b.close)).filter(x => Number.isFinite(x) && x > 0);
    if (closes.length < 30) return null;
    _barsCache.set(symbol, { ts: Date.now(), closes });
    return closes.slice(-n);
  } catch (_) { return null; }
}

// Build per-day percentage returns from a closes series.
function toReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) r.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return r;
}

// ---- Compute synthetic portfolio return series ------------------------------
// Aligns each symbol's return history by index from the most recent day
// backward. Symbols with shorter history are padded with zeros so they don't
// dominate the percentile estimate. Returns: { series, weights, totalNotional }
async function buildPortfolioReturns(holdings, priceLookup) {
  const eligible = [];
  for (const h of holdings) {
    const sym = h.symbol;
    const qty = parseFloat(h.qty);
    const px = priceLookup[sym];
    if (!Number.isFinite(qty) || qty === 0 || !Number.isFinite(px) || px <= 0) continue;
    const closes = await getDailyCloses(sym);
    if (!closes || closes.length < 30) continue;
    const rets = toReturns(closes);
    eligible.push({ symbol: sym, notional: qty * px, rets });
  }
  const totalNotional = eligible.reduce((s, e) => s + Math.abs(e.notional), 0);
  if (totalNotional <= 0 || !eligible.length) return { series: [], weights: {}, totalNotional: 0, contributors: 0 };

  const weights = {};
  for (const e of eligible) weights[e.symbol] = e.notional / totalNotional;

  // Align: take the last min(HIST_LOOKBACK_DAYS, shortest series) days.
  const minLen = Math.min(HIST_LOOKBACK_DAYS, ...eligible.map(e => e.rets.length));
  if (minLen < 20) return { series: [], weights, totalNotional, contributors: eligible.length };
  const series = new Array(minLen).fill(0);
  for (const e of eligible) {
    const tail = e.rets.slice(-minLen);
    const w = weights[e.symbol];
    for (let i = 0; i < minLen; i++) series[i] += tail[i] * w;
  }
  return { series, weights, totalNotional, contributors: eligible.length };
}

// ---- VaR computations -------------------------------------------------------
// VaR USD scaling uses TOTAL NOTIONAL (gross book value) — NOT account equity.
// The synthetic return series is built per dollar of notional exposure, so a
// −2% portfolio return means −2% of *invested* dollars, not −2% of equity
// (which would understate VaR for a partly-cash account, or double-count for a
// margined one). This is the contract enforced by the upgrade spec.
function historicalVaR(series, totalNotional) {
  if (!series.length) return null;
  const sorted = [...series].sort((a, b) => a - b);
  const p5 = percentile(sorted, 5);
  const p1 = percentile(sorted, 1);
  return {
    method: 'historical',
    confidence_95: { retPct: +(p5 * 100).toFixed(3), lossUSD: +(-p5 * totalNotional).toFixed(2) },
    confidence_99: { retPct: +(p1 * 100).toFixed(3), lossUSD: +(-p1 * totalNotional).toFixed(2) },
    sample: series.length,
  };
}

function monteCarloVaR(series, totalNotional, sims = MC_SIMS, seed = MC_SEED_DEFAULT) {
  if (series.length < 20) return null;
  const mu = mean(series);
  const sigma = std(series);
  if (!Number.isFinite(sigma) || sigma <= 0) return null;
  const rng = makeRng(seed);
  const sims_arr = new Array(sims);
  for (let i = 0; i < sims; i++) sims_arr[i] = mu + sigma * gauss(rng);
  sims_arr.sort((a, b) => a - b);
  const p5 = percentile(sims_arr, 5);
  const p1 = percentile(sims_arr, 1);
  return {
    method: 'monte_carlo',
    confidence_95: { retPct: +(p5 * 100).toFixed(3), lossUSD: +(-p5 * totalNotional).toFixed(2) },
    confidence_99: { retPct: +(p1 * 100).toFixed(3), lossUSD: +(-p1 * totalNotional).toFixed(2) },
    mu: +(mu * 100).toFixed(4), sigma: +(sigma * 100).toFixed(4), sims,
  };
}

// ---- Stress scenarios -------------------------------------------------------
function applyScenario(scenario, holdings, priceLookup) {
  const def = scenario.shocks['*'] ?? 0;
  let pnlUSD = 0;
  const perSymbol = [];
  for (const h of holdings) {
    const px = priceLookup[h.symbol];
    const qty = parseFloat(h.qty);
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(qty) || qty === 0) continue;
    const shock = scenario.shocks[h.symbol] ?? def;
    const positionPnl = qty * px * shock;
    pnlUSD += positionPnl;
    if (Math.abs(positionPnl) > 1) perSymbol.push({ symbol: h.symbol, shock, pnlUSD: +positionPnl.toFixed(2) });
  }
  perSymbol.sort((a, b) => a.pnlUSD - b.pnlUSD);
  return {
    name: scenario.name,
    description: scenario.description,
    pnlUSD: +pnlUSD.toFixed(2),
    worstContributors: perSymbol.slice(0, 3),
  };
}

// ---- Top-level refresh ------------------------------------------------------
async function refresh(holdings, priceLookup, equity, dailyLossBudget) {
  try {
    if (!Array.isArray(holdings) || !holdings.length) {
      const data = { ok: false, reason: 'no_holdings', ts: Date.now() };
      _cache = { ts: Date.now(), data };
      return data;
    }
    const { series, weights, totalNotional, contributors } = await buildPortfolioReturns(holdings, priceLookup);
    if (!series.length) {
      const data = { ok: false, reason: 'insufficient_history', ts: Date.now(), contributors };
      _cache = { ts: Date.now(), data };
      return data;
    }
    // Scale by totalNotional (gross exposure), not account equity. The
    // synthetic returns are notional-weighted, so the % swings represent
    // moves on invested dollars only.
    const histVaR = historicalVaR(series, totalNotional);
    const mcVaR = monteCarloVaR(series, totalNotional);
    const stress = STRESS_SCENARIOS.map(s => applyScenario(s, holdings, priceLookup));
    stress.sort((a, b) => a.pnlUSD - b.pnlUSD);

    // VaR utilization vs daily loss budget. Capped at 999% so a tiny budget
    // doesn't render as Infinity in the prompt.
    const utilization = dailyLossBudget > 0 && histVaR
      ? Math.min(999, +(histVaR.confidence_95.lossUSD / dailyLossBudget * 100).toFixed(1))
      : null;

    const data = {
      ok: true,
      ts: Date.now(),
      equity: +equity.toFixed(2),
      totalNotional: +totalNotional.toFixed(2),
      contributors,
      historicalVaR: histVaR,
      monteCarloVaR: mcVaR,
      stressScenarios: stress,
      worstStressUSD: stress[0]?.pnlUSD ?? null,
      varUtilizationPct: utilization,
      dailyLossBudgetUSD: dailyLossBudget,
      weights,
    };
    _cache = { ts: Date.now(), data };
    return data;
  } catch (e) {
    return { ok: false, reason: e.message, ts: Date.now() };
  }
}

function getCached() {
  if (!_cache) return null;
  if (Date.now() - _cache.ts > VAR_TTL_MS) return null;
  return _cache.data;
}

function getCachedRaw() {
  if (!_cache) return null;
  return { ..._cache.data, _ageMs: Date.now() - _cache.ts, _stale: Date.now() - _cache.ts > VAR_TTL_MS };
}

// ---- Render for prompt ------------------------------------------------------
// Compact block, only emitted when meaningful (ok=true). Designed to fit the
// rest of the upgradeContext without ballooning prompt size.
function renderForPrompt(d) {
  if (!d || !d.ok) return null;
  const h = d.historicalVaR, m = d.monteCarloVaR;
  if (!h) return null;
  const lines = [];
  lines.push(`Portfolio risk capacity (advisory — quorum + breaker still rule):`);
  lines.push(`  1-day VaR (historical, 95%): -$${h.confidence_95.lossUSD.toFixed(0)} (${h.confidence_95.retPct}%) · 99%: -$${h.confidence_99.lossUSD.toFixed(0)} (${h.confidence_99.retPct}%) — sample ${h.sample}d`);
  if (m) lines.push(`  1-day VaR (Monte-Carlo, ${m.sims} sims, μ=${m.mu}% σ=${m.sigma}%): 95% -$${m.confidence_95.lossUSD.toFixed(0)} · 99% -$${m.confidence_99.lossUSD.toFixed(0)}`);
  if (Number.isFinite(d.varUtilizationPct)) lines.push(`  VaR utilization vs $${d.dailyLossBudgetUSD} daily loss budget: ${d.varUtilizationPct}%`);
  // Top-3 worst stress scenarios
  const top = (d.stressScenarios || []).slice(0, 3);
  if (top.length) {
    lines.push(`  Stress top-3 (worst → best of bank of ${d.stressScenarios.length}):`);
    for (const s of top) {
      const wc = s.worstContributors?.length
        ? ' · drivers: ' + s.worstContributors.map(c => `${c.symbol} $${c.pnlUSD.toFixed(0)}`).join(', ')
        : '';
      lines.push(`    • ${s.name} (${s.description}) → $${s.pnlUSD.toFixed(0)}${wc}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  ensureSchema, refresh, getCached, getCachedRaw, renderForPrompt,
  // exposed for tests / dashboards
  _internal: { historicalVaR, monteCarloVaR, applyScenario, buildPortfolioReturns, STRESS_SCENARIOS },
};
