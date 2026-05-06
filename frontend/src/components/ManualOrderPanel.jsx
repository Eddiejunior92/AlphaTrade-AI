import { useState, useMemo } from 'react';

const STRATEGIES = [
  { value: 'day',       label: 'US · Day',   market: 'US' },
  { value: 'swing',     label: 'US · Swing', market: 'US' },
  { value: 'asx_day',   label: 'ASX · Day',   market: 'ASX' },
  { value: 'asx_swing', label: 'ASX · Swing', market: 'ASX' },
];

export default function ManualOrderPanel({ manualOrder, loading, watchlist, holdings, tokenMissing }) {
  const [symbol, setSymbol]     = useState('');
  const [side, setSide]         = useState('BUY');
  const [qty, setQty]           = useState('');
  const [strategy, setStrategy] = useState('day');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult]     = useState(null);

  const sortedWatchlist = useMemo(
    () => Array.isArray(watchlist) ? [...watchlist].sort() : [],
    [watchlist]
  );

  // For SELL, prefill qty with the open position size (most common case).
  const matchingHolding = useMemo(() => {
    if (!Array.isArray(holdings)) return null;
    return holdings.find(h => h.symbol === symbol && h.strategy === strategy) || null;
  }, [holdings, symbol, strategy]);

  const reset = () => {
    setSymbol(''); setQty(''); setSide('BUY'); setStrategy('day');
    setConfirming(false); setResult(null);
  };

  const submit = async () => {
    setResult(null);
    const r = await manualOrder({
      symbol: symbol.trim().toUpperCase(),
      side,
      qty: parseInt(qty, 10),
      strategy,
    });
    setResult(r);
    setConfirming(false);
    if (r?.ok) {
      // Keep the result visible for 4s, then clear the form.
      setTimeout(() => { setResult(null); setSymbol(''); setQty(''); }, 4000);
    }
  };

  const ready = symbol.trim() && parseInt(qty, 10) > 0 && !tokenMissing;
  const busy  = !!loading?.manualOrder;

  return (
    <div className="glass rounded-2xl p-4 border border-white/5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-semibold text-[15px]">Manual Trade</div>
          <div className="text-[11px] text-[var(--text-dim)]">Operator override — bypasses quorum but enforces all safety rails (kill switch, atomic cash, audit).</div>
        </div>
        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-[var(--yellow)]/15 text-[var(--yellow)] border border-[var(--yellow)]/30">Operator</span>
      </div>

      {tokenMissing && (
        <div className="mb-3 text-[12px] px-3 py-2 rounded-lg bg-[var(--red)]/10 text-[var(--red)] border border-[var(--red)]/30">
          Operator token required. Paste it in Settings before placing manual orders.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {/* Side */}
        <div className="col-span-2 sm:col-span-1">
          <label className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] block mb-1">Side</label>
          <div className="flex rounded-lg overflow-hidden border border-white/10">
            <button
              type="button"
              onClick={() => setSide('BUY')}
              className={`flex-1 py-2 text-[13px] font-semibold transition-colors ${side === 'BUY' ? 'bg-[var(--green)] text-black' : 'bg-white/5 hover:bg-white/10'}`}>
              BUY
            </button>
            <button
              type="button"
              onClick={() => setSide('SELL')}
              className={`flex-1 py-2 text-[13px] font-semibold transition-colors ${side === 'SELL' ? 'bg-[var(--red)] text-white' : 'bg-white/5 hover:bg-white/10'}`}>
              SELL
            </button>
          </div>
        </div>

        {/* Symbol */}
        <div>
          <label className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] block mb-1">Symbol</label>
          <input
            list="manual-order-symbols"
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            placeholder="NVDA"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] outline-none focus:border-[var(--blue)]"
          />
          <datalist id="manual-order-symbols">
            {sortedWatchlist.map(s => <option key={s} value={s} />)}
          </datalist>
        </div>

        {/* Qty */}
        <div>
          <label className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] block mb-1">
            Qty
            {side === 'SELL' && matchingHolding && (
              <button
                type="button"
                onClick={() => setQty(String(matchingHolding.qty))}
                className="ml-2 text-[10px] text-[var(--blue)] hover:underline">
                Max {matchingHolding.qty}
              </button>
            )}
          </label>
          <input
            type="number" min="1" step="1"
            value={qty}
            onChange={e => setQty(e.target.value)}
            placeholder="10"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] outline-none focus:border-[var(--blue)]"
          />
        </div>

        {/* Strategy */}
        <div className="col-span-2 sm:col-span-1">
          <label className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] block mb-1">Strategy</label>
          <select
            value={strategy}
            onChange={e => setStrategy(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] outline-none focus:border-[var(--blue)]">
            {STRATEGIES.map(s => (
              <option key={s.value} value={s.value} className="bg-[#0a0a0a]">{s.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        {!confirming ? (
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() => setConfirming(true)}
            className={`px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              side === 'BUY' ? 'bg-[var(--green)] text-black hover:opacity-90' : 'bg-[var(--red)] text-white hover:opacity-90'
            }`}>
            Place {side} order
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={submit}
              className={`px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors disabled:opacity-50 ${
                side === 'BUY' ? 'bg-[var(--green)] text-black' : 'bg-[var(--red)] text-white'
              }`}>
              {busy ? 'Sending…' : `Confirm ${side} ${qty} ${symbol} (${strategy})`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="px-3 py-2 rounded-lg text-[13px] bg-white/5 hover:bg-white/10 border border-white/10">
              Cancel
            </button>
          </>
        )}
        {(symbol || qty) && !confirming && (
          <button type="button" onClick={reset}
            className="ml-auto text-[11px] text-[var(--text-dim)] hover:text-[var(--text)]">
            Clear
          </button>
        )}
      </div>

      {result && (
        <div className={`mt-3 text-[12px] px-3 py-2 rounded-lg border ${
          result.ok
            ? 'bg-[var(--green)]/10 text-[var(--green)] border-[var(--green)]/30'
            : 'bg-[var(--red)]/10 text-[var(--red)] border-[var(--red)]/30'
        }`}>
          {result.ok
            ? `✓ ${result.trade?.side} ${result.trade?.qty} ${result.trade?.symbol} filled @ $${Number(result.price).toFixed(2)} (${result.trade?.strategy}). Trade #${result.trade?.id} logged.`
            : `✗ ${result.error || 'Order rejected.'}`}
        </div>
      )}
    </div>
  );
}
