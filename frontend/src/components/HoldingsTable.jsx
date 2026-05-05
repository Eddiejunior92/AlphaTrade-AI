import { currencySymbolForMarket } from '../lib/markets';

// Renders a list of holdings. Each row is shown in its NATIVE currency
// (US shows $, ASX shows A$) so the operator never confuses an AUD avg-cost
// with a USD price. The badge in the corner makes the market explicit.
export default function HoldingsTable({ holdings = [], emptyHint }) {
  if (!holdings.length) {
    return (
      <div className="text-center py-12">
        <div className="text-4xl mb-2 opacity-40">📭</div>
        <div className="text-sm text-[var(--text-dim)]">No open positions</div>
        <div className="text-[11px] text-[var(--text-dim)] mt-1">
          {emptyHint || "Alpha is watching the market for high-conviction setups"}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {holdings.map(h => {
        const market = h.market || 'US';
        const sym = currencySymbolForMarket(market);
        const pnl = h.unrealizedPnL || 0;
        const pct = h.avgCost ? ((h.currentPrice - h.avgCost) / h.avgCost * 100) : 0;
        const isPos = pnl >= 0;
        return (
          <div key={`${market}-${h.symbol}-${h.strategy}`} className="glass p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center font-bold text-[12px]">
                {h.symbol.slice(0, 3)}
              </div>
              <div>
                <div className="font-semibold text-[15px] flex items-center gap-1.5">
                  {h.symbol}
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                    market === 'ASX' ? 'bg-[var(--purple)]/20 text-[var(--purple)]' : 'bg-[var(--blue)]/20 text-[var(--blue)]'
                  }`}>{market}</span>
                </div>
                <div className="text-[11px] text-[var(--text-dim)]">
                  {h.qty} sh · avg {sym}{h.avgCost.toFixed(2)} {h.currency || ''}
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="font-semibold text-[15px]">{sym}{h.marketValue.toFixed(2)}</div>
              <div className={`text-[12px] font-medium ${isPos ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                {isPos ? '+' : ''}{sym}{pnl.toFixed(2)} · {isPos ? '+' : ''}{pct.toFixed(2)}%
              </div>
              {(h.stopLoss || h.takeProfit) && (
                <div className="text-[10px] text-[var(--text-dim)] mt-0.5">
                  {h.stopLoss && <span className="text-[var(--red)]">SL {sym}{h.stopLoss}</span>}
                  {h.stopLoss && h.takeProfit && ' · '}
                  {h.takeProfit && <span className="text-[var(--green)]">TP {sym}{h.takeProfit}</span>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
