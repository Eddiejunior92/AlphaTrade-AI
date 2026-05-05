// Market registry — single source of truth for which symbols belong to which
// market, what currency they trade in, which broker handles them, and when
// each market is open. Adding a new market is a one-place change here.
//
// Why a registry (vs sprinkling `symbol.endsWith('.AX')` everywhere)? Because
// the agent has ~15 places that need to ask "is this symbol US or ASX?" and
// each lookup must give the same answer. A single map prevents drift.

const ASX_WATCHLIST_DEFAULT = [
  'CBA',  // Commonwealth Bank — largest bank, ~$200B mcap
  'BHP',  // BHP Group — diversified miner, dual-listed (ASX primary)
  'CSL',  // CSL Limited — biotech / blood plasma
  'MQG',  // Macquarie Group — investment bank
  'WES',  // Wesfarmers — Bunnings/Kmart conglomerate
  'RIO',  // Rio Tinto — iron ore + copper
  'FMG',  // Fortescue — pure-play iron ore
  'TLS',  // Telstra — telco
  'WOW',  // Woolworths Group — supermarkets
  'ANZ',  // ANZ Banking Group — big-four bank
];

function getAsxWatchlist() {
  const fromEnv = (process.env.WATCHLIST_ASX || '').split(',').map(s => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : ASX_WATCHLIST_DEFAULT;
}

// Build the symbol → market map at import. Recomputed if env overrides change
// at runtime would require a process restart — fine for this scale.
function buildMap() {
  const map = new Map();
  for (const s of getAsxWatchlist()) {
    map.set(s.toUpperCase(), {
      market: 'ASX', currency: 'AUD', broker: 'ibkr',
      timezone: 'Australia/Sydney',
    });
  }
  return map;
}

let SYMBOL_MAP = buildMap();

// Returns market info for a symbol. Defaults to US/USD/Alpaca for any symbol
// not in the ASX list — that's the safe fallback because the platform was
// US-only before this change. Operators who add a new market should add it
// to the registry, not let it silently default to US.
function getSymbolInfo(symbol) {
  const u = (symbol || '').toUpperCase();
  return SYMBOL_MAP.get(u) || {
    market: 'US', currency: 'USD', broker: 'alpaca', timezone: 'America/New_York',
  };
}

function isAsx(symbol)  { return getSymbolInfo(symbol).market === 'ASX'; }
function isUs(symbol)   { return getSymbolInfo(symbol).market === 'US'; }
function brokerFor(symbol) { return getSymbolInfo(symbol).broker; }
function currencyFor(symbol) { return getSymbolInfo(symbol).currency; }

// ASX market hours: 10:00–16:00 Sydney time, Mon–Fri. Sydney is AEST (UTC+10)
// or AEDT (UTC+11) during DST. Rather than hardcode UTC offsets (which break
// twice a year), use Intl.DateTimeFormat with the IANA zone — this respects
// DST automatically.
//
// We treat the opening auction (10:00 Sydney) as "open" and the closing
// single-price auction (16:10) is OUT — we close at 16:00 to avoid
// post-close drift. Holidays are NOT modeled; on ASX holidays the broker
// will simply reject the order, which the IBKR mock/real client handles
// gracefully (logged + audit-tagged, no cascade).
function isAsxOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = t => parts.find(p => p.type === t)?.value;
  const wd = get('weekday'); // Mon..Sun
  if (wd === 'Sat' || wd === 'Sun') return false;
  const h = parseInt(get('hour'), 10);
  const m = parseInt(get('minute'), 10);
  const mins = h * 60 + m;
  return mins >= 10 * 60 && mins < 16 * 60;
}

// Returns ISO timestamp of the next 10:00 Sydney open (rounded to the next
// weekday). Used by the dashboard + cycle scheduler so the operator can see
// when ASX trading resumes.
function nextAsxOpen(now = new Date()) {
  // Walk forward up to 7 days; on each candidate day compute 10:00 Sydney
  // and check if it's after `now` and not weekend.
  for (let i = 0; i < 7; i++) {
    const candidate = new Date(now.getTime() + i * 24 * 3600 * 1000);
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(candidate);
    const get = t => parts.find(p => p.type === t)?.value;
    const wd = get('weekday');
    if (wd === 'Sat' || wd === 'Sun') continue;
    // Construct 10:00 Sydney for that calendar day. Naive but adequate:
    // Australia/Sydney UTC offset is +10 (AEST) or +11 (AEDT). We compute by
    // formatting that day's 00:00 in Sydney and inferring offset.
    const y = get('year'), mo = get('month'), d = get('day');
    // Try both offsets and pick the one whose resulting UTC instant
    // formats back to 10:00 Sydney.
    for (const offset of [10, 11]) {
      const utcMs = Date.UTC(+y, +mo - 1, +d, 10 - offset, 0, 0);
      const cand = new Date(utcMs);
      const sydH = +new Intl.DateTimeFormat('en-AU', {
        timeZone: 'Australia/Sydney', hour: '2-digit', hour12: false,
      }).formatToParts(cand).find(p => p.type === 'hour').value;
      if (sydH === 10 && cand > now) return cand.toISOString();
    }
  }
  return null;
}

module.exports = {
  getAsxWatchlist, getSymbolInfo, isAsx, isUs, brokerFor, currencyFor,
  isAsxOpen, nextAsxOpen,
};
