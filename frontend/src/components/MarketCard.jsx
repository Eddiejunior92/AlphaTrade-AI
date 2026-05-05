import { useEffect, useState, memo } from 'react';
import {
  XAxis, YAxis, Tooltip as RTip, ResponsiveContainer, Area, AreaChart,
} from 'recharts';

// Concrete hex colors — SVG `stopColor` and `stroke` need real color strings.
// CSS custom-property strings (var(--green)) sometimes break React 19 dev
// profiling with structuredClone OOM via performance.measure.
const COLOR_GREEN = '#34D399';
const COLOR_RED   = '#F87171';
const COLOR_GREEN_SOFT = '#7CD992';
const COLOR_RED_SOFT   = '#FF8C8C';

function fmtPrice(n) {
  return typeof n === 'number'
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
}

function sentimentColor(score) {
  if (score >= 0.4) return COLOR_GREEN;
  if (score >= 0.15) return COLOR_GREEN_SOFT;
  if (score <= -0.4) return COLOR_RED;
  if (score <= -0.15) return COLOR_RED_SOFT;
  return '#9CA3AF';
}

function signalColor(action) {
  if (action === 'BUY') return COLOR_GREEN;
  if (action === 'SELL') return COLOR_RED;
  return '#9CA3AF';
}

// Market-aware currency prefix. ASX symbols quote in AUD, US in USD; the
// chart/tooltip/labels all swap to A$ when the card belongs to ASX so the
// operator never confuses the two.
function MarketCard({ card }) {
  const market = card.market || 'US';
  const csym = market === 'ASX' ? 'A$' : '$';
  const [range, setRange] = useState('1d');
  const [bars, setBars] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | empty | error
  const [lastBarAt, setLastBarAt] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    fetch(`/api/bars/${card.symbol}?range=${range}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => {
        if (cancelled) return;
        const valid = Array.isArray(d.bars)
          ? d.bars.filter(b => b && Number.isFinite(b.c) && b.t)
          : [];
        setBars(valid);
        setLastBarAt(d.lastBarAt || null);
        setStatus(valid.length >= 2 ? 'ready' : 'empty');
      })
      .catch(() => {
        if (!cancelled) { setBars([]); setStatus('error'); }
      });
    return () => { cancelled = true; };
  }, [card.symbol, range]);

  // Build chart series. Recharts needs numeric values + at least 2 points.
  const series = bars.map(b => ({ t: new Date(b.t).getTime(), c: +b.c }));
  const first = series[0]?.c;
  const last = series[series.length - 1]?.c;
  const periodPct = first && last ? +(((last - first) / first) * 100).toFixed(2) : null;
  const up = periodPct == null ? (card.changePct ?? 0) >= 0 : periodPct >= 0;
  const lineColor = up ? COLOR_GREEN : COLOR_RED;
  const gradId = `grad-${card.symbol}-${range}`;

  // Latest price preference: live card.price > last bar close > —.
  const displayPrice = card.price ?? last ?? null;
  const displayChange = card.changePct != null ? card.changePct : periodPct;

  const sent = card.sentiment;
  const sig = card.signal;
  const confPct = sig?.confidence != null ? Math.round(sig.confidence * 100) : null;

  // Compute Y domain with small padding so the line isn't flush against edges.
  const ys = series.map(s => s.c);
  const yMin = ys.length ? Math.min(...ys) : 0;
  const yMax = ys.length ? Math.max(...ys) : 1;
  const yPad = (yMax - yMin) * 0.08 || yMax * 0.005 || 1;
  const yDomain = [yMin - yPad, yMax + yPad];

  // X-axis ticks:
  //   1d → top of each ET hour inside the data range (avoids overnight gaps).
  //   5d → first bar of each unique ET calendar day (one label per session).
  const xTicks = (() => {
    if (series.length < 2) return [];
    if (range === '1d') {
      const stepMs = 60 * 60 * 1000;
      const start = Math.ceil(series[0].t / stepMs) * stepMs;
      const ticks = [];
      for (let t = start; t <= series[series.length - 1].t; t += stepMs) ticks.push(t);
      return ticks;
    }
    // 5d: one tick per unique ET date — picks the first bar of each session.
    const seen = new Set();
    const ticks = [];
    for (const pt of series) {
      const key = new Date(pt.t).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
      if (!seen.has(key)) { seen.add(key); ticks.push(pt.t); }
    }
    return ticks;
  })();
  const xTickFmt = (v) => {
    if (range === '1d') {
      return new Date(v).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', hour12: true,
      }).replace(/\s/g, '').toLowerCase();
    }
    return new Date(v).toLocaleDateString('en-US', {
      timeZone: 'America/New_York', month: 'numeric', day: 'numeric',
    });
  };
  const yTickFmt = (v) => `${csym}${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`;

  return (
    <div className="rounded-3xl bg-white/[0.03] border border-white/5 p-4 sm:p-5 backdrop-blur-xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-base font-semibold tracking-tight flex items-center gap-1.5">
            {card.symbol}
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
              market === 'ASX' ? 'bg-[var(--purple)]/20 text-[var(--purple)]' : 'bg-[var(--blue)]/20 text-[var(--blue)]'
            }`}>{market}</span>
          </div>
          <div className="text-[11px] text-[var(--text-dim)]">
            {displayPrice != null ? `${csym}${fmtPrice(displayPrice)}` : '—'}
            <span className="ml-1 opacity-60">{card.currency || (market === 'ASX' ? 'AUD' : 'USD')}</span>
            {displayChange != null && (
              <span className={`ml-2 font-medium ${displayChange >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                {displayChange >= 0 ? '+' : ''}{displayChange}%
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

      {/* Chart area — fixed height, ResponsiveContainer needs explicit parent height */}
      <div style={{ width: '100%', height: 180 }}>
        {status === 'loading' && (
          <div className="h-full flex items-center justify-center text-[10px] text-[var(--text-dim)]">
            <div className="animate-pulse">Loading chart…</div>
          </div>
        )}
        {status === 'error' && (
          <div className="h-full flex items-center justify-center text-[10px] text-[var(--red)]">
            Failed to load
          </div>
        )}
        {status === 'empty' && (
          <div className="h-full flex flex-col items-center justify-center gap-1 text-[10px] text-[var(--text-dim)]">
            <span>No bars available for this range</span>
            <span className="opacity-60">populates on next market open</span>
          </div>
        )}
        {status === 'ready' && (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 6, right: 8, left: 0, bottom: 4 }}>
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={lineColor} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis
                domain={yDomain}
                width={48}
                tick={{ fill: '#9CA3AF', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={yTickFmt}
                orientation="left"
              />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                ticks={xTicks}
                tick={{ fill: '#9CA3AF', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={xTickFmt}
                minTickGap={20}
              />
              <RTip
                contentStyle={{
                  background: 'rgba(20,20,22,0.95)', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 12, fontSize: 11, padding: '6px 10px', color: '#fff',
                }}
                labelFormatter={(v) => new Date(v).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) + ' ET'}
                formatter={(v) => [`${csym}${fmtPrice(v)}`, 'Price']}
              />
              <Area
                type="monotone" dataKey="c" stroke={lineColor} strokeWidth={1.75}
                fill={`url(#${gradId})`} dot={false} isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {periodPct != null && status === 'ready' && (
        <div className="mt-1 text-[10px] text-[var(--text-dim)]">
          {range.toUpperCase()} change:{' '}
          <span className={periodPct >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>
            {periodPct >= 0 ? '+' : ''}{periodPct}%
          </span>
          {lastBarAt && (
            <span className="ml-2 opacity-60">
              · last bar {new Date(lastBarAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
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

      {sig?.reason && (
        <div className="mt-3 pt-3 border-t border-white/5 text-[10px] text-[var(--text-dim)]">
          <span className="text-white/70">AI: </span>{sig.reason}
        </div>
      )}
    </div>
  );
}

// Memoize on symbol + price + signal/sentiment timestamps so identical-shape
// re-renders from the 30s parent poll don't churn 15 charts.
function areEqual(prev, next) {
  const a = prev.card, b = next.card;
  return (
    a.symbol === b.symbol &&
    a.market === b.market &&
    a.currency === b.currency &&
    a.price === b.price &&
    a.changePct === b.changePct &&
    a.signal?.timestamp === b.signal?.timestamp &&
    a.signal?.consensus === b.signal?.consensus &&
    a.signal?.confidence === b.signal?.confidence &&
    a.signal?.reason === b.signal?.reason &&
    a.sentiment?.fetchedAt === b.sentiment?.fetchedAt &&
    a.sentiment?.score === b.sentiment?.score &&
    a.sentiment?.summary === b.sentiment?.summary
  );
}

export default memo(MarketCard, areEqual);
