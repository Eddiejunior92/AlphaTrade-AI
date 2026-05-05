import { currencySymbolForMarket } from '../lib/markets';

export default function SignalCard({ signal }) {
  const sig = signal.signal;
  const market = signal.market || 'US';
  const csym = currencySymbolForMarket(market);
  const bg = sig === 'BUY' ? 'from-[var(--green)]/20 to-transparent' :
             sig === 'SELL' ? 'from-[var(--red)]/20 to-transparent' :
             'from-[var(--yellow)]/15 to-transparent';
  const tag = sig === 'BUY' ? 'bg-[var(--green)]/15 text-[var(--green)]' :
              sig === 'SELL' ? 'bg-[var(--red)]/15 text-[var(--red)]' :
              'bg-[var(--yellow)]/15 text-[var(--yellow)]';
  const change = parseFloat(signal.change);
  return (
    <div className={`glass p-4 bg-gradient-to-br ${bg}`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="font-bold text-[15px] flex items-center gap-1.5">
            {signal.symbol}
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
              market === 'ASX' ? 'bg-[var(--purple)]/20 text-[var(--purple)]' : 'bg-[var(--blue)]/20 text-[var(--blue)]'
            }`}>{market}</span>
          </div>
          <div className="text-[11px] text-[var(--text-dim)]">{csym}{signal.price?.toFixed?.(2) || signal.price}</div>
        </div>
        <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${tag}`}>{sig}</span>
      </div>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-[10px] text-[var(--text-dim)] uppercase">Confidence</div>
          <div className="text-xl font-semibold">{(signal.confidence * 100).toFixed(0)}%</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-[var(--text-dim)] uppercase">Change</div>
          <div className={`text-sm font-medium ${change >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
            {change >= 0 ? '+' : ''}{signal.change}
          </div>
        </div>
      </div>
      <div className="h-1 rounded-full bg-white/5 overflow-hidden">
        <div className={`h-full rounded-full ${
          signal.confidence >= 0.85 ? 'bg-[var(--green)]' :
          signal.confidence >= 0.6 ? 'bg-[var(--yellow)]' : 'bg-[var(--red)]'
        }`} style={{ width: `${signal.confidence * 100}%` }} />
      </div>
      {signal.votes && (
        <div className="flex gap-1.5 mt-3 text-[10px]">
          <span className="text-[var(--green)]">▲ {signal.votes.BUY}</span>
          <span className="text-[var(--text-dim)]">— {signal.votes.HOLD}</span>
          <span className="text-[var(--red)]">▼ {signal.votes.SELL}</span>
        </div>
      )}
    </div>
  );
}
