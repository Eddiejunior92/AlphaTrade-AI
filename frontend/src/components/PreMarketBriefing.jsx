import { useState } from 'react';

const biasColor = {
  bullish: 'text-[var(--green)]',
  bearish: 'text-[var(--red)]',
  neutral: 'text-[var(--text-dim)]',
  mixed: 'text-[var(--yellow)]',
};
const stanceColor = {
  strong: 'text-[var(--green)]',
  weak: 'text-[var(--red)]',
  neutral: 'text-[var(--text-dim)]',
};
const biasIcon = { bullish: '📈', bearish: '📉', neutral: '➖', mixed: '⚖️' };
const setupColor = {
  BUY: 'bg-[var(--green)]/15 text-[var(--green)] border-[var(--green)]/30',
  SELL: 'bg-[var(--red)]/15 text-[var(--red)] border-[var(--red)]/30',
  WATCH: 'bg-[var(--yellow)]/15 text-[var(--yellow)] border-[var(--yellow)]/30',
};

function fmtAge(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function PreMarketBriefing({ briefing, onRefresh, loading }) {
  const [expanded, setExpanded] = useState(false);

  if (!briefing) {
    return (
      <section className="glass p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">🌅 Pre-Market Briefing</h2>
            <p className="text-[12px] text-[var(--text-dim)] mt-1">No briefing on file yet. Auto-generates daily at 8:00 AM ET.</p>
          </div>
          <button onClick={onRefresh} disabled={loading}
            className="ios-btn ios-btn-primary text-[12px] px-3 py-1.5">
            {loading ? 'Generating…' : 'Generate now'}
          </button>
        </div>
      </section>
    );
  }

  const bias = briefing.marketBias || 'mixed';
  const setups = briefing.topSetups || [];
  const sectors = briefing.sectorPulse || [];
  const macro = briefing.macroEvents || [];
  const warnings = briefing.warnings || [];
  const futures = briefing.indexFutures || {};

  return (
    <section className="glass-strong p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-[15px] font-semibold tracking-tight">🌅 Pre-Market Briefing</h2>
            <span className={`text-[11px] font-medium uppercase tracking-wider ${biasColor[bias]}`}>
              {biasIcon[bias] || ''} {bias}
            </span>
            <span className="text-[11px] text-[var(--text-dim)]">· {briefing.date} · {fmtAge(briefing.generatedAt || briefing.createdAt)}</span>
          </div>
          {briefing.headline && (
            <p className="text-[13px] text-[var(--text)] mt-2 leading-snug">{briefing.headline}</p>
          )}
        </div>
        <button onClick={onRefresh} disabled={loading}
          className="ios-btn ios-btn-ghost text-[11px] px-2.5 py-1 shrink-0">
          {loading ? '…' : '↻'}
        </button>
      </div>

      {/* Index futures strip */}
      {Object.keys(futures).length > 0 && (
        <div className="flex flex-wrap gap-3 text-[11px] py-2 border-t border-b border-white/5 mb-3">
          {Object.entries(futures).map(([k, v]) => (
            <span key={k} className="text-[var(--text-dim)]">
              <span className="font-medium text-[var(--text)]">{k}</span> {v}
            </span>
          ))}
        </div>
      )}

      {/* Top setups — the headline content */}
      {setups.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wider text-[var(--text-dim)] mb-2">Top Setups</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {setups.slice(0, expanded ? 12 : 4).map((s, i) => (
              <div key={i} className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[13px]">{s.symbol}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${setupColor[s.bias] || setupColor.WATCH}`}>
                      {s.bias}
                    </span>
                  </div>
                  {s.catalyst && <span className="text-[10px] text-[var(--text-dim)] truncate ml-2">{s.catalyst}</span>}
                </div>
                <p className="text-[12px] text-[var(--text)] leading-snug">{s.thesis}</p>
                {s.keyLevels && (s.keyLevels.support || s.keyLevels.resistance || s.keyLevels.trigger) && (
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[var(--text-dim)] mt-1.5">
                    {s.keyLevels.trigger != null && <span>▶ trig <span className="text-[var(--text)]">${s.keyLevels.trigger}</span></span>}
                    {s.keyLevels.support != null && <span className="text-[var(--green)]">▲ sup ${s.keyLevels.support}</span>}
                    {s.keyLevels.resistance != null && <span className="text-[var(--red)]">▼ res ${s.keyLevels.resistance}</span>}
                  </div>
                )}
                {s.riskFlag && <div className="text-[10px] text-[var(--yellow)] mt-1">⚠ {s.riskFlag}</div>}
              </div>
            ))}
          </div>
          {setups.length > 4 && (
            <button onClick={() => setExpanded(!expanded)}
              className="text-[11px] text-[var(--blue)] mt-2 hover:underline">
              {expanded ? 'Show fewer' : `Show all ${setups.length} setups`}
            </button>
          )}
        </div>
      )}

      {/* Sectors + macro side-by-side */}
      {(sectors.length > 0 || macro.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          {sectors.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[var(--text-dim)] mb-1.5">Sector Pulse</div>
              <ul className="space-y-1">
                {sectors.slice(0, 6).map((s, i) => (
                  <li key={i} className="text-[12px] flex items-baseline gap-2">
                    <span className={`font-medium ${stanceColor[s.stance] || stanceColor.neutral}`}>{s.sector}</span>
                    <span className="text-[var(--text-dim)] text-[11px] truncate">{s.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {macro.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[var(--text-dim)] mb-1.5">Macro / Calendar</div>
              <ul className="space-y-1">
                {macro.map((m, i) => (
                  <li key={i} className="text-[12px] text-[var(--text)] leading-snug">• {m}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-[var(--yellow)]/30 bg-[var(--yellow)]/10 p-2.5">
          <div className="text-[11px] uppercase tracking-wider text-[var(--yellow)] mb-1">⚠ Session Warnings</div>
          <ul className="space-y-0.5">
            {warnings.map((w, i) => (
              <li key={i} className="text-[12px] text-[var(--text)]">{w}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[10px] text-[var(--text-dim)] mt-3 italic">
        Auto-injected into LLM prompts during the first 60 minutes after market open.
      </p>
    </section>
  );
}
