export default function HoldingsTable({ holdings = [] }) {
  if (!holdings.length) {
    return <div className="text-center text-[#8b949e] py-8 text-sm">No open positions</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[#8b949e] text-xs uppercase border-b border-[#30363d]">
            <th className="text-left pb-2 pr-4">Symbol</th>
            <th className="text-right pb-2 pr-4">Qty</th>
            <th className="text-right pb-2 pr-4">Avg Cost</th>
            <th className="text-right pb-2 pr-4">Current</th>
            <th className="text-right pb-2 pr-4">Stop / Target</th>
            <th className="text-right pb-2 pr-4">Market Val</th>
            <th className="text-right pb-2">Unrealized P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map(h => {
            const pnl = h.unrealizedPnL || 0;
            const isPos = pnl >= 0;
            return (
              <tr key={h.symbol} className="border-b border-[#30363d]/50 hover:bg-[#161b22]/50">
                <td className="py-2 pr-4 font-bold font-mono">{h.symbol}</td>
                <td className="py-2 pr-4 text-right font-mono">{h.qty}</td>
                <td className="py-2 pr-4 text-right font-mono">${h.avgCost.toFixed(2)}</td>
                <td className="py-2 pr-4 text-right font-mono">${h.currentPrice.toFixed(2)}</td>
                <td className="py-2 pr-4 text-right font-mono text-xs">
                  {h.stopLoss ? <span className="text-[#ff4444]">${h.stopLoss}</span> : '—'}
                  {' / '}
                  {h.takeProfit ? <span className="text-[#00c851]">${h.takeProfit}</span> : '—'}
                </td>
                <td className="py-2 pr-4 text-right font-mono">${h.marketValue.toFixed(2)}</td>
                <td className={`py-2 text-right font-mono ${isPos ? 'text-[#00c851]' : 'text-[#ff4444]'}`}>
                  {isPos ? '+' : ''}${pnl.toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
