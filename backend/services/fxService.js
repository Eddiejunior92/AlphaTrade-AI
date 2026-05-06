// FX rate service — currently AUD/USD (the only non-USD market we trade).
//
// Architecture: cached spot rate, refreshed every FX_TTL_SECONDS (default 30
// min) by the scheduler in agent.js. Lazy refresh also fires on-demand if
// any caller requests a rate that's gone past TTL.
//
// Used by:
//   - riskManager sizing for ASX trades (convert AUD price → USD-equivalent
//     so existing minRiskUSD/maxRiskUSD math stays in USD)
//   - equity computation (convert AUD-denominated holdings → USD for the
//     daily-loss circuit breaker, drawdown cap, and dashboard)
//   - P&L conversion at trade close (so the realized $ figure that flows
//     into adaptive learning + Discord alerts is USD)
//
// Source priority (first hit wins):
//   1. AUDUSD_RATE env override — operator pin for testing or feed outage
//   2. exchangerate-api.com v6 (paid/free tier) — needs EXCHANGERATE_API_KEY
//   3. open.er-api.com — fully free, no key required, same data backing
//   4. exchangerate.host — needs FX_HOST_API_KEY (was free, now key-gated)
//   5. Last-known-good cached rate (preserved across refresh failures, marked stale)
//   6. Hardcoded fallback 0.66 (logged WARN, surfaces RED on dashboard)
//
// **Never throws** — currency conversion failures must NEVER block trading
// or position evaluation. A stale-but-reasonable rate is always preferable
// to a crashed cycle.

const axios = require('axios');

// Hardened TTL parse — clamp to [60s, 24h] so a typo can't turn the scheduler
// into a tight loop (TTL=0 → setInterval 0ms hammer) or disable it entirely.
function _parseTtlSeconds() {
  const raw = parseInt(process.env.FX_TTL_SECONDS || '1800', 10);
  if (!Number.isFinite(raw) || raw < 60) return 1800;
  if (raw > 86400) return 86400;
  return raw;
}
const FX_TTL_SECONDS = _parseTtlSeconds();
const FALLBACK_AUDUSD = 0.66;

const cache = {
  audusd: null,            // USD per 1 AUD
  fetchedAt: 0,
  source: null,            // human-readable provider id
  stale: false,            // true if last refresh failed but we still have a cached value
  lastError: null,         // last network/provider error message (for diagnostics)
  health: 'cold',          // 'live' | 'stale' | 'fallback' | 'cold'
};

// Sanity range — anything outside this band is treated as a bad upstream
// payload and rejected. AUD/USD has not been outside [0.45, 1.10] in 30+ years.
const MIN_PLAUSIBLE = 0.30;
const MAX_PLAUSIBLE = 1.50;

function _validRate(r) {
  return Number.isFinite(r) && r >= MIN_PLAUSIBLE && r <= MAX_PLAUSIBLE;
}

// ------- providers ----------------------------------------------------------
// Each returns { rate, source } on success, throws on failure. Wrapped in
// try/catch by the caller — order in fetchAudUsd() defines preference.

async function _envOverride() {
  const r = parseFloat(process.env.AUDUSD_RATE || '0');
  if (_validRate(r)) return { rate: r, source: 'env_override' };
  throw new Error('no env override');
}

async function _exchangerateApiV6() {
  const key = process.env.EXCHANGERATE_API_KEY;
  if (!key) throw new Error('EXCHANGERATE_API_KEY not set');
  const url = `https://v6.exchangerate-api.com/v6/${encodeURIComponent(key)}/pair/AUD/USD`;
  const { data } = await axios.get(url, { timeout: 5000 });
  if (data?.result !== 'success') throw new Error(`provider error: ${data?.['error-type'] || 'unknown'}`);
  const r = Number(data.conversion_rate);
  if (!_validRate(r)) throw new Error(`implausible rate ${r}`);
  return { rate: r, source: 'exchangerate-api.com' };
}

async function _openErApi() {
  // Fully keyless — backed by the same data as exchangerate-api.com paid tier
  // but updated daily. Excellent fallback. https://www.exchangerate-api.com/docs/free
  const { data } = await axios.get('https://open.er-api.com/v6/latest/AUD', { timeout: 5000 });
  if (data?.result !== 'success') throw new Error(`provider error: ${data?.['error-type'] || 'unknown'}`);
  const r = Number(data?.rates?.USD);
  if (!_validRate(r)) throw new Error(`implausible rate ${r}`);
  return { rate: r, source: 'open.er-api.com' };
}

async function _exchangerateHost() {
  const key = process.env.FX_HOST_API_KEY;
  if (!key) throw new Error('FX_HOST_API_KEY not set');
  const { data } = await axios.get('https://api.exchangerate.host/live', {
    params: { access_key: key, source: 'AUD', currencies: 'USD' },
    timeout: 5000,
  });
  if (data?.success !== true) throw new Error(`provider error: ${data?.error?.info || 'unknown'}`);
  const r = Number(data?.quotes?.AUDUSD);
  if (!_validRate(r)) throw new Error(`implausible rate ${r}`);
  return { rate: r, source: 'exchangerate.host' };
}

const PROVIDERS = [_envOverride, _exchangerateApiV6, _openErApi, _exchangerateHost];

async function fetchAudUsd() {
  const errs = [];
  for (const p of PROVIDERS) {
    try {
      const out = await p();
      return { ...out, errs };
    } catch (e) {
      errs.push(`${p.name}: ${e.message}`);
    }
  }
  return null; // all providers failed
}

// In-flight de-dupe — concurrent callers (lazy getAudToUsd + scheduled tick +
// operator POST) all share the same pending promise so we never make
// duplicate provider requests in parallel.
let _refreshInFlight = null;
async function refresh() {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = _doRefresh().finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}

async function _doRefresh() {
  const fresh = await fetchAudUsd();
  if (fresh) {
    cache.audusd     = fresh.rate;
    cache.source     = fresh.source;
    cache.fetchedAt  = Date.now();
    cache.stale      = false;
    cache.lastError  = null;
    cache.health     = 'live';
    return { ok: true, rate: fresh.rate, source: fresh.source };
  }
  // All providers failed. Keep last-known-good if we have one.
  if (cache.audusd != null && cache.source !== 'fallback_constant') {
    cache.stale  = true;
    cache.health = 'stale';
    console.warn(`[FX] Refresh failed — using stale AUD/USD ${cache.audusd} (${cache.source})`);
    return { ok: false, rate: cache.audusd, source: cache.source, stale: true };
  }
  // Cold start with no providers reachable → emergency constant.
  cache.audusd     = FALLBACK_AUDUSD;
  cache.source     = 'fallback_constant';
  cache.stale      = true;
  cache.fetchedAt  = Date.now();
  cache.health     = 'fallback';
  cache.lastError  = 'all providers failed';
  console.warn(`[FX] AUD/USD using hardcoded fallback ${FALLBACK_AUDUSD} — no network rate available`);
  return { ok: false, rate: FALLBACK_AUDUSD, source: 'fallback_constant' };
}

// Returns USD per 1 AUD. Refreshes lazily when stale. Synchronous when warm.
async function getAudToUsd() {
  if (cache.audusd == null || (Date.now() - cache.fetchedAt) > FX_TTL_SECONDS * 1000) {
    await refresh();
  }
  return cache.audusd ?? FALLBACK_AUDUSD;
}

// Convert a native amount in `fromCurrency` to USD. USD passthrough is free.
async function toUsd(amount, fromCurrency) {
  if (!Number.isFinite(amount)) return amount;
  const cur = (fromCurrency || 'USD').toUpperCase();
  if (cur === 'USD') return amount;
  if (cur === 'AUD') return amount * (await getAudToUsd());
  // Unknown currency → treat as USD (safest: don't fabricate a rate for a
  // currency we don't support yet).
  console.warn(`[FX] Unknown currency '${cur}' — treating as USD`);
  return amount;
}

// Convert USD to native. Used when sizing has produced USD figures (stop,
// take-profit) and we need to send the native value to the broker.
async function fromUsd(usdAmount, toCurrency) {
  if (!Number.isFinite(usdAmount)) return usdAmount;
  const cur = (toCurrency || 'USD').toUpperCase();
  if (cur === 'USD') return usdAmount;
  if (cur === 'AUD') {
    const r = await getAudToUsd();
    return r > 0 ? usdAmount / r : usdAmount;
  }
  return usdAmount;
}

function getStatus() {
  const ageSec = cache.fetchedAt ? Math.round((Date.now() - cache.fetchedAt) / 1000) : null;
  const providersConfigured = {
    env_override:        !!parseFloat(process.env.AUDUSD_RATE || '0'),
    exchangerate_api:    !!process.env.EXCHANGERATE_API_KEY,
    open_er_api:         true, // keyless
    exchangerate_host:   !!process.env.FX_HOST_API_KEY,
  };
  return {
    audusd:     cache.audusd,
    source:     cache.source,
    stale:      cache.stale,
    health:     cache.health,                 // 'live' | 'stale' | 'fallback' | 'cold'
    fetchedAt:  cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    ageSeconds: ageSec,
    ttlSeconds: FX_TTL_SECONDS,
    lastError:  cache.lastError,
    providersConfigured,
  };
}

module.exports = { getAudToUsd, toUsd, fromUsd, refresh, getStatus };
