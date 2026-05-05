// Reusable market chip selector. Used on Markets, Positions, Trades,
// Reasoning, Backtest, and the Home Live-Signals strip so every list in
// the dashboard scopes consistently.
//
// `counts` is optional `{ US: number, ASX: number }`; when present the chip
// shows the count so empty markets don't look broken — they just say "0".
export default function MarketFilter({ value = 'ALL', onChange, counts, className = '' }) {
  const opts = [
    { id: 'ALL', label: 'All',  flag: '🌐' },
    { id: 'US',  label: 'US',   flag: '🇺🇸' },
    { id: 'ASX', label: 'ASX',  flag: '🇦🇺' },
  ];
  const total = counts ? (counts.US || 0) + (counts.ASX || 0) : null;
  return (
    <div className={`inline-flex items-center gap-1 p-0.5 rounded-2xl bg-white/5 border border-white/5 ${className}`}>
      {opts.map(o => {
        const active = value === o.id;
        const n = counts ? (o.id === 'ALL' ? total : counts[o.id] || 0) : null;
        return (
          <button
            key={o.id}
            onClick={() => onChange?.(o.id)}
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-xl transition-colors flex items-center gap-1.5 ${
              active ? 'bg-white/15 text-white' : 'text-[var(--text-dim)] hover:text-white'
            }`}
          >
            <span aria-hidden="true">{o.flag}</span>
            <span>{o.label}</span>
            {n != null && (
              <span className={`text-[9px] tabular-nums ${active ? 'text-white/70' : 'text-[var(--text-dim)]'}`}>
                {n}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
