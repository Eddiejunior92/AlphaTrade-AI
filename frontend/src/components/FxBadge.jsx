// Compact AUD→USD FX rate pill. Pulls from /api/state's `fx` block, which is
// the same status object the backend uses for risk sizing on ASX trades, so
// the operator sees the exact rate that will be applied to the next order.
//
// Three states: live (fresh), stale (last good but older than the service
// freshness window), and offline (no rate at all → ASX sizing will refuse).
export default function FxBadge({ fx, compact = false }) {
  if (!fx) return null;
  const rate = fx.audusd;
  const ok = typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
  // health is the canonical signal from the backend: 'live' | 'stale' |
  // 'fallback' | 'cold'. Older payloads only had `stale`, so derive it.
  const health = fx.health || (!ok ? 'cold' : fx.stale ? 'stale' : 'live');
  const isFallback = health === 'fallback' || fx.source === 'fallback_constant';
  const color = !ok ? 'var(--red)'
              : isFallback ? 'var(--red)'
              : health === 'stale' ? 'var(--yellow)'
              : 'var(--green)';
  const label = !ok ? 'No FX rate'
              : isFallback ? 'FX (fallback)'
              : health === 'stale' ? 'FX (stale)'
              : 'FX (live)';
  const fetched = fx.fetchedAt
    ? new Date(fx.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  if (compact) {
    return (
      <span
        title={`AUD/USD ${ok ? rate.toFixed(4) : '—'} · source ${fx.source || '?'}${fetched ? ` · @ ${fetched}` : ''}${health !== 'live' ? ` · ${health}` : ''}`}
        className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
        style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: color }} />
        AUD/USD {ok ? rate.toFixed(4) : '—'}
      </span>
    );
  }

  return (
    <div className="rounded-2xl bg-white/[0.03] border border-white/5 p-3 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
        <div>
          <div className="text-[12px] font-semibold">{label}</div>
          <div className="text-[10px] text-[var(--text-dim)]">
            AUD/USD · source {fx.source || 'n/a'}
            {fetched && <> · {fetched}</>}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-lg font-mono tabular-nums font-semibold">
          {ok ? rate.toFixed(4) : '—'}
        </div>
        <div className="text-[10px] text-[var(--text-dim)]">used for ASX sizing</div>
      </div>
    </div>
  );
}
