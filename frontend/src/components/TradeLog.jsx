import { currencySymbolForMarket } from '../lib/markets';

export default function TradeLog({ trades = [], marketOf }) {
  if (!trades.length) {
    return (
      <div className="text-center py-12">
        <div className="text-4xl mb-2 opacity-40">📜</div>
        <div className="text-sm text-[var(--text-dim)]">No trades yet</div>
        <div className="text-[11px] text-[var(--text-dim)] mt-1">Trades will appear here once Alpha finds a high-conviction signal</div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {trades.map(t => {
        const market = t.market || (marketOf ? marketOf(t.symbol) : 'US');
        const sym = currencySymbolForMarket(market);
        // P&L is stored in USD (the daily-loss budget is USD), so we always
        // print it with `$` regardless of the row's market — the market badge
        // already tells the operator which exchange the trade hit.
        const pnl = t.pnl ? parseFloat(t.pnl) : null;
        const isBuy = t.side === 'BUY';
        const fx = t.fx_rate ? parseFloat(t.fx_rate) : null;
        return (
          <div key={t.id} className="glass p-3.5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold ${
                isBuy ? 'bg-[var(--green)]/15 text-[var(--green)]' : 'bg-[var(--red)]/15 text-[var(--red)]'
              }`}>{isBuy ? '↑' : '↓'}</div>
              <div>
                <div className="font-semibold text-[14px] flex items-center gap-1.5">
                  {t.side} {parseFloat(t.qty).toFixed(0)} {t.symbol}
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                    market === 'ASX' ? 'bg-[var(--purple)]/20 text-[var(--purple)]' : 'bg-[var(--blue)]/20 text-[var(--blue)]'
                  }`}>{market}</span>
                </div>
                <div className="text-[11px] text-[var(--text-dim)]">
                  {sym}{parseFloat(t.price).toFixed(2)} {t.currency || ''}
                  {fx && market === 'ASX' && (
                    <span className="ml-1.5 opacity-70">· fx {fx.toFixed(4)}</span>
                  )}
                  <span className="ml-1.5">· {new Date(t.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
            </div>
            <div className="text-right">
              {pnl !== null && (
                <div className={`text-[14px] font-semibold ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                  {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                  <span className="ml-1 text-[9px] font-medium text-[var(--text-dim)]">USD</span>
                </div>
              )}
              <div className="text-[10px] text-[var(--text-dim)] capitalize">
                {t.confidence ? `${(parseFloat(t.confidence) * 100).toFixed(0)}% · ` : ''}{t.status}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
