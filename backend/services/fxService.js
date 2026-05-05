// FX rate service — currently AUD/USD (the only non-USD market we trade).
//
// Architecture: cached spot rate, refreshed every FX_TTL_SECONDS (default 1h).
// Used by:
//   - riskManager sizing for ASX trades (convert AUD price → USD-equivalent
//     so existing minRiskUSD/maxRiskUSD math stays in USD)
//   - equity computation (convert AUD-denominated holdings → USD for the
//     daily-loss circuit breaker, drawdown cap, and dashboard)
//   - P&L conversion at trade close (so the realized $ figure that flows
//     into adaptive learning + Discord alerts is USD)
//
// Source priority:
//   1. AUDUSD_RATE env override (operator pin — useful for testing or when
//      the upstream feed is down and the operator wants a known rate)
//   2. exchangerate.host (free, no API key, returns JSON `{rates: {USD: x}}`)
//   3. Last-known good cached rate (preserved across refresh failures)
//   4. Hardcoded fallback (0.66 USD per AUD — within historical 5-yr range,
//      logged as a WARN so operators notice)
//
// **Never throws** — currency conversion failures must NEVER block trading
// or position evaluation. A stale-but-reasonable rate is always preferable
// to a crashed cycle.

const axios = require('axios');

const FX_TTL_SECONDS = parseInt(process.env.FX_TTL_SECONDS || '3600');
const FALLBACK_AUDUSD = 0.66;

const cache = {
  audusd: null,            // USD per 1 AUD
  fetchedAt: 0,
  source: null,
  stale: false,
};

async function fetchAudUsd() {
  // 1. Operator override — highest priority, no network call
  const envRate = parseFloat(process.env.AUDUSD_RATE || '0');
  if (envRate > 0 && envRate < 5) {
    return { rate: envRate, source: 'env_override' };
  }

  // 2. exchangerate.host — free, no key, ISO 4217 base/quote
  try {
    const res = await axios.get('https://api.exchangerate.host/latest', {
      params: { base: 'AUD', symbols: 'USD' },
      timeout: 5000,
    });
    const r = res.data?.rates?.USD;
    if (Number.isFinite(r) && r > 0.3 && r < 1.5) {
      return { rate: r, source: 'exchangerate.host' };
    }
    throw new Error(`Unexpected response shape: ${JSON.stringify(res.data).slice(0, 200)}`);
  } catch (e) {
    console.warn(`[FX] AUD/USD fetch failed: ${e.message}`);
    return null;
  }
}

async function refresh() {
  const fresh = await fetchAudUsd();
  if (fresh) {
    cache.audusd = fresh.rate;
    cache.source = fresh.source;
    cache.fetchedAt = Date.now();
    cache.stale = false;
    return;
  }
  if (cache.audusd != null) {
    // Keep the last-known-good value; mark stale so callers can surface it.
    cache.stale = true;
    console.warn(`[FX] Using stale AUD/USD ${cache.audusd} (${cache.source})`);
    return;
  }
  cache.audusd = FALLBACK_AUDUSD;
  cache.source = 'fallback_constant';
  cache.stale = true;
  cache.fetchedAt = Date.now();
  console.warn(`[FX] AUD/USD using hardcoded fallback ${FALLBACK_AUDUSD} — no network rate available`);
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
  return {
    audusd: cache.audusd,
    source: cache.source,
    stale: cache.stale,
    fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    ttlSeconds: FX_TTL_SECONDS,
  };
}

module.exports = { getAudToUsd, toUsd, fromUsd, refresh, getStatus };
