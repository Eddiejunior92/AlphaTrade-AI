import { useEffect, useState, useCallback } from 'react';
import MarketCard from './MarketCard';
import ErrorBoundary from './ErrorBoundary';
import MarketClock from './MarketClock';

export default function MarketsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

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

  const cards = data?.cards || [];

  return (
    <div className="space-y-4">
      <MarketClock />
      <div className="flex items-center justify-between px-1">
        <div>
          <div className="text-base font-semibold tracking-tight">Markets</div>
          <div className="text-[11px] text-[var(--text-dim)]">
            {cards.length} symbols · charts, AI signal, news sentiment
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="text-[11px] font-medium px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 transition disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {loading ? (
        <div className="rounded-3xl bg-white/[0.03] border border-white/5 p-8 text-center text-sm text-[var(--text-dim)]">
          Loading markets…
        </div>
      ) : cards.length === 0 ? (
        <div className="rounded-3xl bg-white/[0.03] border border-white/5 p-8 text-center text-sm text-[var(--text-dim)]">
          No market data available.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {cards.map(c => (
            <ErrorBoundary key={c.symbol}>
              <MarketCard card={c} />
            </ErrorBoundary>
          ))}
        </div>
      )}
    </div>
  );
}
