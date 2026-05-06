import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import MarketCard from './MarketCard';
import ErrorBoundary from './ErrorBoundary';
import MarketClocks from './MarketClocks';
import MarketFilter from './MarketFilter';
import SectorFilter, { buildSectorCounts } from './SectorFilter';
import FxBadge from './FxBadge';

export default function MarketsTab({ fx, sectorOf = () => 'Other', focusSymbol = null, onFocusConsumed, asxEnabled = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('ALL');
  const [sector, setSector] = useState('ALL');
  const [highlight, setHighlight] = useState(null);
  const cardRefs = useRef({});

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/markets');
      const json = await res.json();
      setData(json);
    } catch {
      setData({ cards: [] });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000); // refresh card metadata every 30s
    return () => clearInterval(t);
  }, [load]);

  const handleRefresh = () => { setRefreshing(true); load(); };

  const allCards = data?.cards || [];
  const counts = useMemo(() => ({
    US: allCards.filter(c => (c.market || 'US') === 'US').length,
    ASX: allCards.filter(c => c.market === 'ASX').length,
  }), [allCards]);
  // Apply market filter first, then sector. Sector counts reflect what would
  // be selectable under the active market scope so chips never lie.
  const afterMarket = filter === 'ALL' ? allCards : allCards.filter(c => (c.market || 'US') === filter);
  const sectorCounts = useMemo(
    () => buildSectorCounts(afterMarket, c => sectorOf(c.symbol)),
    [afterMarket, sectorOf],
  );
  const cards = sector === 'ALL' ? afterMarket : afterMarket.filter(c => sectorOf(c.symbol) === sector);

  // When App passes focusSymbol (user clicked "Markets" on a Company card),
  // clear any active filter that would hide it, scroll the card into view,
  // and pulse a highlight ring for ~2s so the eye can latch on.
  useEffect(() => {
    if (!focusSymbol || loading) return;
    const sym = String(focusSymbol).toUpperCase();
    const card = allCards.find(c => c.symbol === sym);
    if (!card) { onFocusConsumed?.(); return; }
    // Make sure filters don't hide the focused card.
    setFilter('ALL');
    setSector('ALL');
    // Defer scroll until after render flush so refs exist.
    requestAnimationFrame(() => {
      const node = cardRefs.current[sym];
      if (node?.scrollIntoView) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlight(sym);
      setTimeout(() => setHighlight(null), 2000);
      onFocusConsumed?.();
    });
  }, [focusSymbol, loading, allCards, onFocusConsumed]);

  return (
    <div className="space-y-4">
      <MarketClocks />
      {fx && <FxBadge fx={fx} />}

      <div className="flex items-center justify-between gap-3 flex-wrap px-1">
        <div>
          <div className="text-base font-semibold tracking-tight">Markets</div>
          <div className="text-[11px] text-[var(--text-dim)]">
            {cards.length} of {allCards.length} symbols · charts, AI signal, news sentiment
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <MarketFilter value={filter} onChange={setFilter} counts={counts} asxEnabled={asxEnabled} />
          <SectorFilter value={sector} onChange={setSector} counts={sectorCounts} />
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-[11px] font-medium px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 transition disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="rounded-3xl bg-white/[0.03] border border-white/5 p-8 text-center text-sm text-[var(--text-dim)]">
          Loading markets…
        </div>
      ) : cards.length === 0 ? (
        <div className="rounded-3xl bg-white/[0.03] border border-white/5 p-8 text-center text-sm text-[var(--text-dim)]">
          No symbols in {filter === 'ALL' ? 'any market' : filter}.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {cards.map(c => (
            <div
              key={c.symbol}
              ref={el => { cardRefs.current[c.symbol] = el; }}
              className={`rounded-3xl transition-all ${highlight === c.symbol ? 'ring-2 ring-[var(--blue)] ring-offset-2 ring-offset-[var(--bg)]' : ''}`}
            >
              <ErrorBoundary>
                <MarketCard card={c} />
              </ErrorBoundary>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
