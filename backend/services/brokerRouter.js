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

async function getBars(symbol, timeframe, limit, opts) {
  return getBroker(symbol).getBars(symbol, timeframe, limit, opts);
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
};
