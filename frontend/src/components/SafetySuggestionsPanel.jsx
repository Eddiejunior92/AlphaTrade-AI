import { useEffect, useState, useCallback } from 'react';
import Tooltip from './Tooltip';

const SEV_COLOR = {
  high: 'text-[var(--red)]',
  medium: 'text-[var(--yellow)]',
  low: 'text-[var(--blue)]',
};
const SEV_BORDER = {
  high: 'border-[var(--red)]/40',
  medium: 'border-[var(--yellow)]/30',
  low: 'border-[var(--blue)]/30',
};

function fmtKindLabel(kind, target, suggested) {
  if (kind === 'risk_scale_change') return `Switch Risk Tier → ${suggested}`;
  if (kind === 'strategy_disable') return `Pause ${target} strategy`;
  return `${kind} (${target} → ${suggested})`;
}

function fmtEvidence(ev) {
  if (!ev) return null;
  const parts = [];
  if (ev.window) parts.push(`last ${ev.window} closes`);
  if (typeof ev.winRate === 'number') parts.push(`wr ${(ev.winRate * 100).toFixed(0)}%`);
  if (typeof ev.netPnL === 'number') parts.push(`P&L $${ev.netPnL.toFixed(2)}`);
  if (ev.counterfactualSupport) parts.push(ev.counterfactualSupport);
  return parts.length ? parts.join(' · ') : null;
}

export default function SafetySuggestionsPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/safety-suggestions');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setError(null);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    load();
    // Light polling — suggestions move slowly (30-min refresh on backend).
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch('/api/safety-suggestions/refresh', { method: 'POST' });
      await load();
    } catch (e) { setError(e.message); }
    finally { setRefreshing(false); }
  };

  const onApply = async (id) => {
    if (!confirm('Apply this suggestion? You can always change it back manually.')) return;
    setLoading(l => ({ ...l, [id]: 'apply' }));
    try {
      const r = await fetch(`/api/safety-suggestions/${id}/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decided_by: 'dashboard' }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'Apply failed');
      await load();
    } catch (e) { alert(`Apply failed: ${e.message}`); }
    finally { setLoading(l => { const n = { ...l }; delete n[id]; return n; }); }
  };

  const onReject = async (id) => {
    setLoading(l => ({ ...l, [id]: 'reject' }));
    try {
      const r = await fetch(`/api/safety-suggestions/${id}/reject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decided_by: 'dashboard' }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'Reject failed');
      await load();
    } catch (e) { alert(`Reject failed: ${e.message}`); }
    finally { setLoading(l => { const n = { ...l }; delete n[id]; return n; }); }
  };

  const pending = data?.pending || [];

  return (
    <Tooltip text="Data-backed nudges to bounded safety parameters (risk-scale tier, strategy enable). Nothing is ever applied automatically — every change requires your tap. Hard rails (3-of-4 quorum, kill switch, 5% drawdown breaker, trailing stops) are not exposed here and remain immutable.">
      <section className="glass p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-dim)]">
              Safety Suggestions
            </div>
            <div className="text-[10px] text-[var(--text-dim)] mt-0.5">
              Data-backed · Bounded · Always require your approval
            </div>
          </div>
          <button onClick={onRefresh} disabled={refreshing}
            className="text-[11px] px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50">
            {refreshing ? '…' : '↻ Re-mine'}
          </button>
        </div>

        {error && (
          <div className="text-[11px] text-[var(--red)] mb-2">Failed to load: {error}</div>
        )}

        {pending.length === 0 ? (
          <div className="bg-white/3 rounded-xl p-3 text-[12px] text-[var(--text-dim)]">
            No safety suggestions right now — all metrics within healthy bands.
          </div>
        ) : (
          <div className="space-y-2">
            {pending.map(s => {
              const evLine = fmtEvidence(s.evidence);
              const sevColor = SEV_COLOR[s.severity] || SEV_COLOR.medium;
              const sevBorder = SEV_BORDER[s.severity] || SEV_BORDER.medium;
              const expiresIn = Math.max(0, Math.round((new Date(s.expires_at) - Date.now()) / 3600000));
              return (
                <div key={s.id} className={`bg-white/3 rounded-xl p-3 border ${sevBorder}`}>
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div>
                      <div className="text-[12px] font-semibold">
                        {fmtKindLabel(s.kind, s.target, s.suggested_value)}
                      </div>
                      <div className={`text-[10px] uppercase tracking-wider mt-0.5 ${sevColor}`}>
                        {s.severity} · expires in {expiresIn}h
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => onApply(s.id)} disabled={!!loading[s.id]}
                        className="text-[11px] px-2.5 py-1 rounded-lg bg-[var(--green)]/20 text-[var(--green)] hover:bg-[var(--green)]/30 disabled:opacity-50">
                        {loading[s.id] === 'apply' ? '…' : 'Apply'}
                      </button>
                      <button onClick={() => onReject(s.id)} disabled={!!loading[s.id]}
                        className="text-[11px] px-2.5 py-1 rounded-lg bg-white/5 text-[var(--text-dim)] hover:bg-white/10 disabled:opacity-50">
                        {loading[s.id] === 'reject' ? '…' : 'Dismiss'}
                      </button>
                    </div>
                  </div>
                  <div className="text-[11px] text-[var(--text)] leading-snug mt-1">
                    {s.rationale}
                  </div>
                  {evLine && (
                    <div className="text-[10px] text-[var(--text-dim)] mt-1.5">
                      Evidence: {evLine}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </Tooltip>
  );
}
