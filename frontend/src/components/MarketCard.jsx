import { useEffect, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RTip, ResponsiveContainer, Area, AreaChart,
} from 'recharts';

function fmtPrice(n) {
  return typeof n === 'number'
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
}

function sentimentColor(score) {
  if (score >= 0.4) return 'var(--green)';
  if (score >= 0.15) return '#7CD992';
  if (score <= -0.4) return 'var(--red)';
  if (score <= -0.15) return '#FF8C8C';
  return 'var(--text-dim)';
}

function signalColor(action) {
  if (action === 'BUY') return 'var(--green)';
  if (action === 'SELL') return 'var(--red)';
  return 'var(--text-dim)';
}

export default function MarketCard({ card }) {
  const [range, setRange] = useState('1d');
  const [bars, setBars] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/bars/${card.symbol}?range=${range}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setBars(Array.isArray(d.bars) ? d.bars : []); })
      .catch(() => { if (!cancelled) setBars([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [card.symbol, range]);

  const data = bars.map(b => ({ t: b.t, c: b.c }));
  const first = data[0]?.c;
  const last = data[data.length - 1]?.c;
  const periodPct = first && last ? +(((last - first) / first) * 100).toFixed(2) : null;
  const up = periodPct == null ? card.changePct >= 0 : periodPct >= 0;
  const lineColor = up ? 'var(--green)' : 'var(--red)';

  const sent = card.sentiment;
  const sig = card.signal;
  const confPct = sig?.confidence != null ? Math.round(sig.confidence * 100) : null;

  return (
    <div className="rounded-3xl bg-white/[0.03] border border-white/5 p-4 sm:p-5 backdrop-blur-xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-base font-semibold tracking-tight">{card.symbol}</div>
          <div className="text-[11px] text-[var(--text-dim)]">
            {card.price != null ? `$${fmtPrice(card.price)}` : '—'}
            {card.changePct != null && (
              <span className={`ml-2 font-medium ${card.changePct >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                {card.changePct >= 0 ? '+' : ''}{card.changePct}%
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-1">
          {['1d', '5d'].map(r => (
            <button key={r}
              onClick={() => setRange(r)}
              className={`text-[10px] font-medium px-2 py-1 rounded-lg transition ${
                range === r ? 'bg-white/10 text-white' : 'text-[var(--text-dim)] hover:text-white'
              }`}
            >{r.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="h-32 -mx-1">
        {loading ? (
          <div className="h-full flex items-center justify-center text-[10px] text-[var(--text-dim)]">Loading…</div>
        ) : data.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[10px] text-[var(--text-dim)]">No bars</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`grad-${card.symbol}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={lineColor} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis hide domain={['dataMin', 'dataMax']} />
              <XAxis dataKey="t" hide />
              <RTip
                contentStyle={{
                  background: 'rgba(20,20,22,0.95)', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 12, fontSize: 11, padding: '6px 10px',
                }}
                labelFormatter={(v) => new Date(v).toLocaleString()}
                formatter={(v) => [`$${fmtPrice(v)}`, 'Price']}
              />
              <Area
                type="monotone" dataKey="c" stroke={lineColor} strokeWidth={1.75}
                fill={`url(#grad-${card.symbol})`} dot={false} isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {periodPct != null && (
        <div className="mt-1 text-[10px] text-[var(--text-dim)]">
          {range.toUpperCase()} change:{' '}
          <span className={periodPct >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>
            {periodPct >= 0 ? '+' : ''}{periodPct}%
          </span>
        </div>
      )}

      {/* Signal + Sentiment grid */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-2.5">
          <div className="text-[9px] uppercase tracking-wider text-[var(--text-dim)] mb-0.5">AI Signal</div>
          {sig ? (
            <>
              <div className="text-xs font-semibold" style={{ color: signalColor(sig.consensus) }}>
                {sig.consensus}
                <span className="ml-1.5 text-[var(--text-dim)] font-normal">{confPct}%</span>
              </div>
              <div className="text-[9px] text-[var(--text-dim)] mt-0.5">{sig.strategy}</div>
            </>
          ) : (
            <div className="text-[10px] text-[var(--text-dim)]">No signal yet</div>
          )}
        </div>
        <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-2.5">
          <div className="text-[9px] uppercase tracking-wider text-[var(--text-dim)] mb-0.5">News Sentiment</div>
          {sent ? (
            <>
              <div className="text-xs font-semibold capitalize" style={{ color: sentimentColor(sent.score) }}>
                {sent.label}
                <span className="ml-1.5 text-[var(--text-dim)] font-normal">
                  {sent.score >= 0 ? '+' : ''}{sent.score}
                </span>
              </div>
              <div className="text-[9px] text-[var(--text-dim)] mt-0.5">
                {sent.cached ? 'cached' : 'fresh'} · Grok
              </div>
            </>
          ) : (
            <div className="text-[10px] text-[var(--text-dim)]">Pending…</div>
          )}
        </div>
      </div>

      {/* Sentiment summary + insights */}
      {sent?.summary && (
        <div className="mt-3 text-[11px] leading-relaxed text-[var(--text-dim)]">
          <span className="text-white/80">“{sent.summary}”</span>
        </div>
      )}
      {sent?.insights?.length > 0 && (
        <ul className="mt-2 space-y-1">
          {sent.insights.map((ins, i) => (
            <li key={i} className="text-[10px] text-[var(--text-dim)] flex gap-1.5">
              <span className="text-[var(--blue)]">•</span>
              <span>{ins}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Signal rationale */}
      {sig?.reason && (
        <div className="mt-3 pt-3 border-t border-white/5 text-[10px] text-[var(--text-dim)]">
          <span className="text-white/70">AI: </span>{sig.reason}
        </div>
      )}
    </div>
  );
}
