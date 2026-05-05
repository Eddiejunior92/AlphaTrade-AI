// =============================================================================
// LIQUIDITY SERVICE — Upgrade #3 / Capital & Risk Capacity
// =============================================================================
//
// Per-symbol liquidity profile + LIQUIDITY-ADJUSTED MAX POSITION ADVISORY.
// Computes:
//   • 30-day Average Daily Volume (ADV) in shares + dollar terms
//   • Spread proxy from intraday bar high-low / VWAP
//   • Suggested prudent max position size = min(0.5% of $ADV, existing limit)
//
// The LLM ensemble sees this in its prompt context and is encouraged to size
// down when the proposed position is large relative to ADV. The hard sizing
// math in `riskManager.evaluateBuy()` is UNCHANGED. This layer can only
// REDUCE perceived ambition via prompt advice — it cannot raise the cap.
//
// Source data: cached `historical_intelligence` payload (daily bars). No
// extra API calls. ADV refreshed with the daily intelligence cycle.
//
// SAFETY: strictly informational. Never bypasses quorum, gate, or sizing.
// =============================================================================

const brokerRouter = require('./brokerRouter');

const LIQ_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const ADV_LOOKBACK_DAYS = 30;
const MAX_PRUDENT_PCT_OF_ADV = 0.005;   // 0.5% of $ADV — institutional rule of thumb

let _cache = new Map(); // symbol -> { ts, data }

async function ensureSchema() { /* no-op */ }

async function getDailyBars(symbol) {
  try {
    // brokerRouter dispatches to alpaca (US) or IBKR (ASX) automatically.
    // Without `start`, Alpaca returns 0 bars; without `noMock`, alpaca falls
    // back to synthetic data that would yield fake ADV numbers. Both are
    // unacceptable for a sizing-advisory layer.
    const start = new Date(Date.now() - (ADV_LOOKBACK_DAYS + 30) * 24 * 3600 * 1000).toISOString();
    const bars = await brokerRouter.getBars(symbol, '1Day', ADV_LOOKBACK_DAYS + 5, { start, adjustment: 'all', noMock: true });
    return Array.isArray(bars) && bars.length ? bars : null;
  } catch (_) { return null; }
}

function spreadProxy(bars) {
  // Proxy: average (high - low) / typical_price across last 5 bars. Real
  // spreads aren't in our daily-bar feed; this is a volatility-of-tape
  // surrogate. Higher → wider effective execution cost.
  const recent = bars.slice(-5);
  let s = 0, n = 0;
  for (const b of recent) {
    const h = +(b.h ?? b.high), l = +(b.l ?? b.low), c = +(b.c ?? b.close);
    if (Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c) && c > 0) {
      s += (h - l) / c; n++;
    }
  }
  return n ? +(s / n * 10000).toFixed(1) : null; // bps
}

function liquidityLabel(advUSD) {
  if (advUSD == null) return 'unknown';
  if (advUSD >= 1_000_000_000) return 'mega-liquid';
  if (advUSD >= 100_000_000)  return 'liquid';
  if (advUSD >= 25_000_000)   return 'adequate';
  if (advUSD >= 5_000_000)    return 'thin';
  return 'illiquid';
}

async function refresh(symbol) {
  try {
    const bars = await getDailyBars(symbol);
    if (!Array.isArray(bars) || bars.length < 10) {
      const data = { ok: false, symbol, reason: 'insufficient_history', ts: Date.now() };
      _cache.set(symbol, { ts: Date.now(), data });
      return data;
    }
    const recent = bars.slice(-ADV_LOOKBACK_DAYS);
    let advShares = 0, advUSD = 0, n = 0;
    for (const b of recent) {
      const v = +(b.v ?? b.volume), c = +(b.c ?? b.close);
      if (Number.isFinite(v) && v > 0 && Number.isFinite(c) && c > 0) {
        advShares += v;
        advUSD += v * c;
        n++;
      }
    }
    if (n === 0) {
      const data = { ok: false, symbol, reason: 'no_volume', ts: Date.now() };
      _cache.set(symbol, { ts: Date.now(), data });
      return data;
    }
    advShares = advShares / n;
    advUSD = advUSD / n;
    const spreadBps = spreadProxy(bars);
    const prudentMaxUSD = +(advUSD * MAX_PRUDENT_PCT_OF_ADV).toFixed(2);
    const lastClose = +(bars[bars.length - 1].c ?? bars[bars.length - 1].close);
    const prudentMaxShares = Number.isFinite(lastClose) && lastClose > 0
      ? Math.floor(prudentMaxUSD / lastClose) : null;
    const data = {
      ok: true,
      symbol,
      ts: Date.now(),
      advShares: Math.round(advShares),
      advUSD: +advUSD.toFixed(2),
      label: liquidityLabel(advUSD),
      spreadProxyBps: spreadBps,
      prudentMaxUSD,
      prudentMaxShares,
      lookbackDays: n,
      lastClose,
    };
    _cache.set(symbol, { ts: Date.now(), data });
    return data;
  } catch (e) {
    return { ok: false, symbol, reason: e.message, ts: Date.now() };
  }
}

async function getOrRefresh(symbol) {
  const cached = _cache.get(symbol);
  if (cached && Date.now() - cached.ts < LIQ_TTL_MS) return cached.data;
  return refresh(symbol);
}

function getCached(symbol) {
  const c = _cache.get(symbol);
  if (!c) return null;
  if (Date.now() - c.ts > LIQ_TTL_MS) return null;
  return c.data;
}

function getCachedRaw(symbol) {
  const c = _cache.get(symbol);
  if (!c) return null;
  return { ...c.data, _ageMs: Date.now() - c.ts, _stale: Date.now() - c.ts > LIQ_TTL_MS };
}

// Render a SINGLE-LINE liquidity advisory for the prompt. Comparison against
// the proposed position size happens in the LLM's reasoning — we surface the
// raw numbers + label so it can reason explicitly about market-impact risk.
function renderForPrompt(d, proposedPositionUSD = null) {
  if (!d || !d.ok) return null;
  const advFmt = d.advUSD >= 1e9 ? `$${(d.advUSD / 1e9).toFixed(2)}B` :
                 d.advUSD >= 1e6 ? `$${(d.advUSD / 1e6).toFixed(1)}M` : `$${(d.advUSD / 1e3).toFixed(0)}K`;
  const prudentFmt = d.prudentMaxUSD >= 1e6 ? `$${(d.prudentMaxUSD / 1e6).toFixed(2)}M` : `$${(d.prudentMaxUSD / 1e3).toFixed(0)}K`;
  const spreadBit = d.spreadProxyBps != null ? ` · spread proxy ${d.spreadProxyBps}bps` : '';
  let warning = '';
  if (proposedPositionUSD != null && d.prudentMaxUSD > 0 && proposedPositionUSD > d.prudentMaxUSD) {
    const ratio = (proposedPositionUSD / d.prudentMaxUSD).toFixed(1);
    warning = ` · ⚠ proposed $${proposedPositionUSD.toFixed(0)} = ${ratio}× prudent cap → market-impact risk`;
  }
  return `Liquidity profile: ${d.label} (30d ADV ${advFmt}${spreadBit}, prudent max ≤ ${prudentFmt} = 0.5% of ADV${warning})`;
}

async function refreshBatch(symbols) {
  let ok = 0;
  for (const s of symbols) {
    try { const r = await refresh(s); if (r?.ok) ok++; } catch (_) {}
  }
  return { refreshed: ok, total: symbols.length };
}

module.exports = {
  ensureSchema, refresh, refreshBatch, getOrRefresh, getCached, getCachedRaw, renderForPrompt,
  _internal: { spreadProxy, liquidityLabel, MAX_PRUDENT_PCT_OF_ADV },
};
