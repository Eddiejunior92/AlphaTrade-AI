import { useEffect, useState, useCallback } from 'react';
import Tooltip from './Tooltip';

// Automated Strategy Discovery panel. Shows pending proposals (rule
// variations the backtest engine found promising) with one-tap Apply /
// Dismiss buttons, plus the list of currently-active overlays so the
// operator can revert anything that's not behaving as expected.
//
// SAFETY: nothing here is auto-applied — every change is operator-driven.
// Apply/Dismiss/Revert hit operator-gated endpoints; pending proposals
// are pure recommendations until the operator clicks Apply.

function getOperatorToken() {
  // Mirror SafetySuggestionsPanel pattern — token is stored in localStorage
  // (set once in the dashboard settings drawer). Empty in dev where the
  // server runs without an OPERATOR_TOKEN env var.
  try { return localStorage.getItem('operator_token') || ''; } catch (_) { return ''; }
}

function fmtPnl(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${n.toFixed(2)}`;
}
function fmtPct(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

export default function StrategyProposalsPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState({});
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/strategy-discovery/summary');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setError(null);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    load();
    // Light polling — discovery refreshes every 4h backend-side.
    const t = setInterval(load, 90_000);
    return () => clearInterval(t);
  }, [load]);

  const act = useCallback(async (kind, id) => {
    const key = `${kind}:${id}`;
    setLoading(s => ({ ...s, [key]: true }));
    try {
      const token = getOperatorToken();
      const headers = { 'content-type': 'application/json' };
      if (token) headers['x-operator-token'] = token;
      let url, method;
      if (kind === 'apply')   { url = `/api/strategy-proposals/${id}/apply`;   method = 'POST'; }
      if (kind === 'dismiss') { url = `/api/strategy-proposals/${id}/dismiss`; method = 'POST'; }
      if (kind === 'revoke')  { url = `/api/strategy-overlays/${id}`;          method = 'DELETE'; }
      const r = await fetch(url, { method, headers });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(s => { const n = { ...s }; delete n[key]; return n; });
    }
  }, [load]);

  const pending  = data?.pending || [];
  const overlays = data?.overlays || [];

  // Don't show anything when there's nothing to act on AND no overlays —
  // saves vertical space on a fresh install.
  if (!pending.length && !overlays.length && !error) return null;

  return (
    <section className="glass p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold tracking-tight flex items-center gap-2">
          <span>🧪</span> Strategy Discovery
          <Tooltip text="Backtested rule variations the system found promising. Apply to add as a tightening filter on top of the existing safety rules — never auto-applied.">
            <span className="text-[11px] text-[var(--text-dim)] cursor-help">ⓘ</span>
          </Tooltip>
        </h2>
        <span className="text-[11px] text-[var(--text-dim)]">
          {pending.length} pending · {overlays.length} active
        </span>
      </div>

      {error && (
        <div className="text-[11px] text-[var(--red)]">⚠ {error}</div>
      )}

      {/* Pending proposals */}
      {pending.length > 0 && (
        <div className="space-y-2">
          {pending.map(p => {
            const baselinePnl = Number(p.baseline_pnl);
            const keptPnl = Number(p.kept_pnl);
            const deltaPnl = Number(p.delta_pnl);
            return (
              <div key={p.id} className="p-3 rounded-lg border border-[var(--blue)]/30 bg-[var(--surface-2)]/40">
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium leading-snug">{p.rule_label}</div>
                    <div className="text-[11px] text-[var(--text-dim)] mt-0.5">
                      {p.strategy} · {p.regime} · {p.market}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[13px] font-semibold text-[var(--green)]">{fmtPnl(deltaPnl)}</div>
                    <div className="text-[10px] text-[var(--text-dim)]">vs baseline</div>
                  </div>
                </div>
                <div className="text-[11px] text-[var(--text-dim)] mb-2">
                  Baseline {fmtPnl(baselinePnl)} (n={p.baseline_n}, wr {fmtPct(p.baseline_wr)})
                  {' → '}
                  Kept {fmtPnl(keptPnl)} (n={p.kept_n}, wr {fmtPct(p.kept_wr)}, dropped {p.dropped_n})
                </div>
                <div className="flex gap-2">
                  <button onClick={() => act('apply', p.id)}
                    disabled={!!loading[`apply:${p.id}`] || !!loading[`dismiss:${p.id}`]}
                    className="ios-btn ios-btn-success text-[12px] py-1.5 px-3">
                    {loading[`apply:${p.id}`] ? '…' : '✓ Apply'}
                  </button>
                  <button onClick={() => act('dismiss', p.id)}
                    disabled={!!loading[`apply:${p.id}`] || !!loading[`dismiss:${p.id}`]}
                    className="ios-btn ios-btn-ghost text-[12px] py-1.5 px-3">
                    {loading[`dismiss:${p.id}`] ? '…' : '✕ Dismiss'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Active overlays */}
      {overlays.length > 0 && (
        <div className="pt-2 border-t border-[var(--border)]/40">
          <div className="text-[11px] font-semibold text-[var(--text-dim)] uppercase tracking-wide mb-2">
            Active Overlays — tightening filters on top of safety stack
          </div>
          <div className="space-y-1.5">
            {overlays.map(o => (
              <div key={o.id} className="flex items-center justify-between gap-2 text-[12px]">
                <div className="flex-1 min-w-0">
                  <div className="truncate">{o.rule_label}</div>
                  <div className="text-[10px] text-[var(--text-dim)]">{o.strategy} · {o.regime} · {o.market}</div>
                </div>
                <button onClick={() => act('revoke', o.id)}
                  disabled={!!loading[`revoke:${o.id}`]}
                  className="ios-btn ios-btn-ghost text-[11px] py-1 px-2.5">
                  {loading[`revoke:${o.id}`] ? '…' : 'Revert'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
