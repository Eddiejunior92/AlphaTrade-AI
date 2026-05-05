// Broker router — single entry point for any "send order to broker" /
// "fetch bars" call. Dispatches by symbol's market (US → Alpaca, ASX → IBKR).
//
// This indirection is the architectural seam that makes adding a third
// broker tomorrow (e.g. for HKEX / TSE) a one-line change in
// marketRegistry + a new service file. The agent never has to know which
// broker it's talking to.

const alpacaService = require('./alpacaService');
const ibkrService = require('./ibkrService');
const { brokerFor, isAsxOpen, isUs, isAsx } = require('./marketRegistry');

function getBroker(symbol) {
  return brokerFor(symbol) === 'ibkr' ? ibkrService : alpacaService;
}

async function placeOrder({ symbol, qty, side, type, time_in_force }) {
  const broker = getBroker(symbol);
  if (broker === ibkrService) {
    return broker.placeOrder({ symbol, qty, side, type: type || 'MKT', tif: time_in_force || 'DAY' });
  }
  return broker.placeOrder({ symbol, qty, side: side.toLowerCase(), type, time_in_force });
}

// =============================================================================
// [Upgrade #4 / Scale & Speed] Bar-cache layer + in-flight de-duplication.
// =============================================================================
// A single trading cycle can request the same (symbol, timeframe, limit) many
// times across different code paths (price snapshot in runCycle, intraday
// analysis, indicators, signal storage). Hitting the broker every time is
// wasteful and adds 50-300 ms of latency per repeat. This cache:
//   • TTLs short timeframes only (1Min=8s, 5Min=60s) — long timeframes either
//     have their own service-level caches (varStress, liquidity, historical)
//     or are bespoke historical fetches (skip when opts.start/end is set).
//   • Coalesces in-flight identical calls so 5 simultaneous requests for the
//     same bars produce ONE broker round-trip instead of five.
//   • SAFETY: cache is bypassed entirely when `opts.start`, `opts.end`,
//     `opts.paginate`, or `opts.noMock` is set — those callers (historical
//     intelligence, VaR, liquidity) need exact, unshared data.
//   • Cache is read-only data. Cannot influence sizing, quorum, or any
//     existing safety check.
const BAR_CACHE_TTL_MS = { '1Min': 8000, '5Min': 60_000, '15Min': 180_000, '1Hour': 600_000 };
const _barCache = new Map();   // key -> { ts, data }
const _barInFlight = new Map(); // key -> Promise
const _barMetrics = { hits: 0, misses: 0, inflight: 0, bypass: 0 };

function _shouldBypass(opts) {
  if (!opts) return false;
  return !!(opts.start || opts.end || opts.paginate || opts.noMock);
}

async function getBars(symbol, timeframe, limit, opts) {
  const ttl = BAR_CACHE_TTL_MS[timeframe];
  if (!ttl || _shouldBypass(opts)) {
    _barMetrics.bypass++;
    return getBroker(symbol).getBars(symbol, timeframe, limit, opts);
  }
  const key = `${symbol}|${timeframe}|${limit}`;
  const cached = _barCache.get(key);
  if (cached && Date.now() - cached.ts < ttl) {
    _barMetrics.hits++;
    return cached.data;
  }
  // Coalesce concurrent fetches for the same key.
  const pending = _barInFlight.get(key);
  if (pending) {
    _barMetrics.inflight++;
    return pending;
  }
  _barMetrics.misses++;
  const p = getBroker(symbol).getBars(symbol, timeframe, limit, opts)
    .then(data => {
      _barCache.set(key, { ts: Date.now(), data });
      return data;
    })
    .finally(() => { _barInFlight.delete(key); });
  _barInFlight.set(key, p);
  return p;
}

function getBarCacheMetrics() {
  const total = _barMetrics.hits + _barMetrics.misses + _barMetrics.inflight + _barMetrics.bypass;
  const cacheable = _barMetrics.hits + _barMetrics.misses + _barMetrics.inflight;
  return {
    ..._barMetrics,
    total,
    hitRatePct: cacheable > 0 ? +(((_barMetrics.hits + _barMetrics.inflight) / cacheable) * 100).toFixed(1) : 0,
    cacheSize: _barCache.size,
  };
}

function resetBarCacheMetrics() {
  _barMetrics.hits = 0; _barMetrics.misses = 0; _barMetrics.inflight = 0; _barMetrics.bypass = 0;
}

async function closePosition(symbol) {
  return getBroker(symbol).closePosition(symbol);
}

// Flatten EVERYTHING across both brokers — used by kill switch and
// circuit-breaker cascades. Each broker's closeAllPositions is independent;
// failure on one doesn't block the other.
async function closeAllPositionsAllBrokers() {
  const [a, i] = await Promise.allSettled([
    alpacaService.closeAllPositions(),
    ibkrService.closeAllPositions(),
  ]);
  return {
    alpaca: a.status === 'fulfilled' ? a.value : { error: a.reason?.message },
    ibkr: i.status === 'fulfilled' ? i.value : { error: i.reason?.message },
  };
}

async function cancelAllOpenOrdersAllBrokers() {
  const [a, i] = await Promise.allSettled([
    alpacaService.cancelAllOpenOrders(),
    ibkrService.cancelAllOpenOrders(),
  ]);
  return {
    alpaca: a.status === 'fulfilled' ? a.value : { error: a.reason?.message },
    ibkr: i.status === 'fulfilled' ? i.value : { error: i.reason?.message },
  };
}

// Mirror kill switch to BOTH brokers atomically. Called by agent.killSwitch.
function setKillSwitchActiveAll(v) {
  try { alpacaService.setKillSwitchActive(v); } catch (_) {}
  try { ibkrService.setKillSwitchActive(v); } catch (_) {}
}

// Returns { isOpen, nextOpen, nextClose } for the symbol's market.
// Alpaca already exposes a clock for US — we reuse it. ASX is computed
// in marketRegistry from timezone math.
async function getMarketStatus(symbol) {
  if (isUs(symbol)) {
    const c = await alpacaService.getClock();
    return {
      market: 'US',
      isOpen: !!c.is_open,
      nextOpen: c.next_open || null,
      nextClose: c.next_close || null,
    };
  }
  if (isAsx(symbol)) {
    const { nextAsxOpen } = require('./marketRegistry');
    const open = isAsxOpen();
    return {
      market: 'ASX',
      isOpen: open,
      nextOpen: open ? null : nextAsxOpen(),
      // ASX always closes at 16:00 Sydney; if currently open, next close
      // is today 16:00 Sydney. We don't currently surface this — the
      // strategy doesn't auto-flatten ASX (it's swing-only).
      nextClose: null,
    };
  }
  return { market: 'UNKNOWN', isOpen: false, nextOpen: null, nextClose: null };
}

module.exports = {
  getBroker, placeOrder, getBars, closePosition,
  closeAllPositionsAllBrokers, cancelAllOpenOrdersAllBrokers,
  setKillSwitchActiveAll, getMarketStatus,
  // [Upgrade #4] bar-cache observability — surfaced via /api/perf
  getBarCacheMetrics, resetBarCacheMetrics,
};
