// Macro-factor intelligence — pulls cross-asset signals from Alpaca's free
// daily-bar feed using liquid ETF proxies (no extra API keys, no extra cost).
//
// What we read (all symbols are Alpaca-tradeable US ETFs):
//   • SHY  — 1-3yr Treasury  → short-end rate proxy (price ↑ = rates ↓)
//   • IEF  — 7-10yr Treasury → mid-curve rate proxy
//   • TLT  — 20+yr Treasury  → long-end rate proxy
//   • TIP  — TIPS            → inflation-protected; vs IEF = breakeven proxy
//   • VXX  — short-term VIX  → vol expectations (price ↑ = vol bid)
//   • UUP  — bullish USD     → dollar strength
//   • GLD  — gold            → safe-haven / inflation hedge
//   • USO  — oil             → growth/inflation pulse
//   • DBC  — broad commodity → secondary commodity confirmation
//   • HYG  — high-yield bonds → credit risk (price ↓ = credit stress)
//   • SPY  — S&P 500         → equity risk
//   • EEM  — emerging mkts   → global risk appetite
//
// For every proxy we compute 1d / 5d / 20d log-returns + a 20d vol estimate.
// Pure read; cached per symbol with TTL. Errors are swallowed and downgrade
// the affected factor to null — the forecast layer simply ignores nulls.

const alpacaService = require('./alpacaService');

const PROXIES = {
  rate_short: 'SHY',
  rate_mid:   'IEF',
  rate_long:  'TLT',
  tips:       'TIP',
  vix:        'VXX',
  usd:        'UUP',
  gold:       'GLD',
  oil:        'USO',
  commod:     'DBC',
  credit:     'HYG',
  equity:     'SPY',
  em:         'EEM',
};

const TTL_MS = 60 * 60 * 1000;        // 60-min cache
const BAR_LOOKBACK_DAYS = 45;         // need ~30 trading days for 20d windows
const TIMEOUT_MS = 12000;

let _cache = { ts: 0, data: null };
let _inflight = null;

function pctChange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return +(((b - a) / a) * 100).toFixed(3);
}
function logRet(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return +Math.log(b / a).toFixed(6);
}
function stdev(arr) {
  if (!arr.length) return null;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length;
  return Math.sqrt(v);
}

async function fetchBars(symbol) {
  const start = new Date(Date.now() - BAR_LOOKBACK_DAYS * 86400000).toISOString();
  try {
    const bars = await alpacaService.getBars(symbol, '1Day', BAR_LOOKBACK_DAYS, { start, adjustment: 'all' });
    return Array.isArray(bars) ? bars.filter(b => Number.isFinite(b?.c)) : [];
  } catch (e) {
    console.warn(`[Macro] getBars(${symbol}) failed:`, e.message);
    return [];
  }
}

// Compact per-factor read. Returns {last, ret1d, ret5d, ret20d, vol20d} or
// null when bar coverage is insufficient.
function summarizeBars(bars) {
  if (!bars || bars.length < 6) return null;
  const closes = bars.map(b => b.c);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const c5   = closes[closes.length - 6] ?? closes[0];
  const c20  = closes[closes.length - 21] ?? closes[0];
  const dailyRets = [];
  for (let i = 1; i < closes.length; i++) {
    const r = logRet(closes[i - 1], closes[i]);
    if (r != null) dailyRets.push(r);
  }
  const recentRets = dailyRets.slice(-20);
  const vol20 = recentRets.length >= 5 ? stdev(recentRets) : null;
  return {
    last: +last.toFixed(4),
    ret1d:  pctChange(prev, last),
    ret5d:  pctChange(c5, last),
    ret20d: pctChange(c20, last),
    vol20dPct: vol20 != null ? +(vol20 * 100).toFixed(3) : null,
    bars: bars.length,
  };
}

// Public: pull all proxies in parallel, summarise, and derive a small set of
// composite signals (yield-curve steepness change, breakeven inflation
// change, credit-equity divergence, etc.). Cached for TTL_MS.
async function getFactors() {
  if (_cache.data && Date.now() - _cache.ts < TTL_MS) return _cache.data;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const symbols = Object.entries(PROXIES);
    const results = await Promise.all(symbols.map(async ([k, sym]) => {
      const bars = await fetchBars(sym);
      return [k, { symbol: sym, ...(summarizeBars(bars) || {}) }];
    }));
    const factors = Object.fromEntries(results);

    // Composite signals — defensive: any null upstream → composite null.
    const composites = {};
    // Yield-curve change proxy: TLT 5d return − SHY 5d return. If long-end
    // is OUTPERFORMING (TLT up more than SHY), curve is FLATTENING (long
    // yields falling faster) — bullish duration / risk-off bias.
    const tlt5 = factors.rate_long?.ret5d, shy5 = factors.rate_short?.ret5d;
    composites.curveChg5d = (tlt5 != null && shy5 != null) ? +(tlt5 - shy5).toFixed(3) : null;
    // Breakeven inflation proxy: TIP 20d − IEF 20d. Positive = inflation
    // expectations rising faster than nominal yields (real yields falling).
    const tip20 = factors.tips?.ret20d, ief20 = factors.rate_mid?.ret20d;
    composites.breakevenChg20d = (tip20 != null && ief20 != null) ? +(tip20 - ief20).toFixed(3) : null;
    // Credit-equity divergence: HYG underperforming SPY = credit warning.
    const hyg5 = factors.credit?.ret5d, spy5 = factors.equity?.ret5d;
    composites.creditEquityDiv5d = (hyg5 != null && spy5 != null) ? +(hyg5 - spy5).toFixed(3) : null;
    // Risk-on/off composite — equity + EM + credit minus VIX + USD + gold.
    // Each component is its 5d return in pp; equal-weighted average. Range
    // typically -3 to +3 pp; positive = risk-on.
    const riskOnParts = [factors.equity?.ret5d, factors.em?.ret5d, factors.credit?.ret5d];
    const riskOffParts = [factors.vix?.ret5d, factors.usd?.ret5d, factors.gold?.ret5d];
    const onAvg  = avg(riskOnParts);
    const offAvg = avg(riskOffParts);
    composites.riskOnOff5d = (onAvg != null && offAvg != null) ? +(onAvg - offAvg).toFixed(3) : null;

    const out = { factors, composites, ts: Date.now() };
    _cache = { ts: Date.now(), data: out };
    return out;
  })();
  try { return await _inflight; } finally { _inflight = null; }
}

function avg(arr) {
  const xs = arr.filter(v => Number.isFinite(v));
  if (!xs.length) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function getCached() { return _cache.data; }

module.exports = { getFactors, getCached, PROXIES };
