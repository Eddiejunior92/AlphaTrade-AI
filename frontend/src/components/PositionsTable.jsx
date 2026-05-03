export default function PositionsTable({ positions = [] }) {
  if (!positions.length) {
    return (
      <div className="text-center text-[#8b949e] py-8 text-sm">
        No open positions
      </div>
    );
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
            <th className="text-right pb-2 pr-4">Market Val</th>
            <th className="text-right pb-2">P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const pnl = parseFloat(p.unrealized_pl);
            const pnlPct = parseFloat(p.unrealized_plpc) * 100;
            const isPos = pnl >= 0;
            return (
              <tr key={p.symbol} className="border-b border-[#30363d]/50 hover:bg-[#161b22]/50">
                <td className="py-2 pr-4 font-bold font-mono">{p.symbol}</td>
                <td className="py-2 pr-4 text-right font-mono">{p.qty}</td>
                <td className="py-2 pr-4 text-right font-mono">${parseFloat(p.avg_entry_price).toFixed(2)}</td>
                <td className="py-2 pr-4 text-right font-mono">${parseFloat(p.current_price).toFixed(2)}</td>
                <td className="py-2 pr-4 text-right font-mono">${parseFloat(p.market_value).toFixed(2)}</td>
                <td className={`py-2 text-right font-mono ${isPos ? 'text-[#00c851]' : 'text-[#ff4444]'}`}>
                  {isPos ? '+' : ''}{pnl.toFixed(2)} ({pnlPct.toFixed(2)}%)
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
