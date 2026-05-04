export default function TradeLog({ trades = [] }) {
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
        const pnl = t.pnl ? parseFloat(t.pnl) : null;
        const isBuy = t.side === 'BUY';
        return (
          <div key={t.id} className="glass p-3.5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold ${
                isBuy ? 'bg-[var(--green)]/15 text-[var(--green)]' : 'bg-[var(--red)]/15 text-[var(--red)]'
              }`}>{isBuy ? '↑' : '↓'}</div>
              <div>
                <div className="font-semibold text-[14px]">
                  {t.side} {parseFloat(t.qty).toFixed(0)} {t.symbol}
                </div>
                <div className="text-[11px] text-[var(--text-dim)]">
                  ${parseFloat(t.price).toFixed(2)} · {new Date(t.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
            <div className="text-right">
              {pnl !== null && (
                <div className={`text-[14px] font-semibold ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                  {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
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
