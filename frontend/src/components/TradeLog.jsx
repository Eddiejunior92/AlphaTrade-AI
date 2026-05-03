const STATUS_COLORS = {
  filled: 'text-[#00c851]',
  submitted: 'text-[#2196f3]',
  pending: 'text-[#ffbb33]',
  error: 'text-[#ff4444]',
  skipped: 'text-[#8b949e]',
  mock_filled: 'text-[#00c851]',
};

export default function TradeLog({ trades = [] }) {
  if (!trades.length) {
    return (
      <div className="text-center text-[#8b949e] py-8 text-sm">
        No trades yet. Start the agent to begin.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[#8b949e] text-xs uppercase border-b border-[#30363d]">
            <th className="text-left pb-2 pr-4">Time</th>
            <th className="text-left pb-2 pr-4">Symbol</th>
            <th className="text-left pb-2 pr-4">Action</th>
            <th className="text-right pb-2 pr-4">Qty</th>
            <th className="text-right pb-2 pr-4">Price</th>
            <th className="text-right pb-2 pr-4">Conf</th>
            <th className="text-right pb-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="border-b border-[#30363d]/50 hover:bg-[#161b22]/50">
              <td className="py-2 pr-4 text-[#8b949e] font-mono text-xs">
                {new Date(t.timestamp).toLocaleTimeString()}
              </td>
              <td className="py-2 pr-4 font-bold font-mono">{t.symbol}</td>
              <td className={`py-2 pr-4 font-bold ${t.action === 'BUY' ? 'text-[#00c851]' : t.action === 'SELL' ? 'text-[#ff4444]' : 'text-[#ffbb33]'}`}>
                {t.action}
              </td>
              <td className="py-2 pr-4 text-right font-mono">{t.qty}</td>
              <td className="py-2 pr-4 text-right font-mono">
                {t.price ? `$${typeof t.price === 'number' ? t.price.toFixed(2) : t.price}` : '—'}
              </td>
              <td className="py-2 pr-4 text-right font-mono text-xs">
                {t.confidence ? `${(t.confidence * 100).toFixed(0)}%` : '—'}
              </td>
              <td className={`py-2 text-right font-mono text-xs capitalize ${STATUS_COLORS[t.status] || 'text-[#8b949e]'}`}>
                {t.status}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
