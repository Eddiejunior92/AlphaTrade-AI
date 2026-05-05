// Frontend market helpers — single source of truth for "which market is this
// symbol in?" on the client. The backend tags signals/holdings/trades with
// `market`/`currency` directly, but signals coming straight off the WebSocket
// `state.signals` map (and audit rows derived only from symbol) need a quick
// lookup, so we mirror the registry on the client using `state.asxWatchlist`.

export const MARKETS = ['US', 'ASX'];

export function makeMarketOf(asxWatchlist = []) {
  const set = new Set((asxWatchlist || []).map(s => String(s).toUpperCase()));
  return (sym) => set.has(String(sym || '').toUpperCase()) ? 'ASX' : 'US';
}

export function currencyForMarket(market) {
  return market === 'ASX' ? 'AUD' : 'USD';
}

export function currencySymbolForMarket(market) {
  return market === 'ASX' ? 'A$' : '$';
}

export function marketLabel(market) {
  return market === 'ASX' ? 'ASX' : 'US';
}

// Format an amount using the currency symbol of its market. Defaults to USD.
export function fmtMoney(n, market = 'US') {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${currencySymbolForMarket(market)}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Convert a native amount in `market` currency to USD using the FX status
// shape from /api/state (`{ audusd, ... }`). For USD positions this is a no-op.
export function toUsd(amountNative, market, fx) {
  if (market !== 'ASX') return amountNative;
  const rate = fx?.audusd;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;
  return amountNative * rate;
}
