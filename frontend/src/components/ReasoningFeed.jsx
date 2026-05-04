const EVENT_META = {
  SIGNAL: { color: 'var(--blue)', icon: '🧠', label: 'Signal' },
  TRADE_EXECUTED: { color: 'var(--green)', icon: '✓', label: 'Trade Executed' },
  TRADE_REJECTED: { color: 'var(--text-dim)', icon: '⊘', label: 'Trade Rejected' },
  TRADE_ERROR: { color: 'var(--red)', icon: '⚠', label: 'Trade Error' },
  CIRCUIT_BREAKER_TRIPPED: { color: 'var(--red)', icon: '🚨', label: 'Circuit Breaker' },
  CIRCUIT_BREAKER_RESET: { color: 'var(--green)', icon: '↻', label: 'CB Reset' },
  EMERGENCY_PAUSE: { color: 'var(--red)', icon: '⏸', label: 'Emergency Pause' },
  EMERGENCY_RESUME: { color: 'var(--green)', icon: '▶', label: 'Resumed' },
  STOP_LOSS: { color: 'var(--red)', icon: '⬇', label: 'Stop-Loss' },
  TAKE_PROFIT: { color: 'var(--green)', icon: '🎯', label: 'Take-Profit' },
  AGENT_STARTED: { color: 'var(--green)', icon: '▶', label: 'Agent Started' },
  AGENT_STOPPED: { color: 'var(--text-dim)', icon: '⏹', label: 'Agent Stopped' },
  DAILY_RESET: { color: 'var(--yellow)', icon: '☀', label: 'Daily Reset' },
  CYCLE_ERROR: { color: 'var(--red)', icon: '⚠', label: 'Cycle Error' },
};

export default function ReasoningFeed({ entries = [], compact = false }) {
  if (!entries.length) {
    return (
      <div className="text-center py-12">
        <div className="text-4xl mb-2 opacity-40">💭</div>
        <div className="text-sm text-[var(--text-dim)]">No reasoning yet</div>
        <div className="text-[11px] text-[var(--text-dim)] mt-1">Start the agent to see Alpha's live thinking</div>
      </div>
    );
  }
  return (
    <div className={`space-y-3 ${compact ? 'max-h-[420px]' : 'max-h-[70vh]'} overflow-y-auto pr-1`}>
      {entries.map(e => {
        const meta = EVENT_META[e.event_type] || { color: 'var(--text-dim)', icon: '·', label: e.event_type };
        const time = new Date(e.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const models = e.models || null;
        const payload = e.payload || {};
        return (
          <div key={e.id} className="glass p-3.5 anim-fade">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs"
                  style={{ background: `color-mix(in srgb, ${meta.color} 18%, transparent)`, color: meta.color }}>
                  {meta.icon}
                </span>
                <div>
                  <div className="text-[12px] font-semibold" style={{ color: meta.color }}>{meta.label}</div>
                  <div className="text-[10px] text-[var(--text-dim)]">
                    {e.symbol && <span className="font-mono mr-1.5">{e.symbol}</span>}
                    {e.decision && (
                      <span className={
                        e.decision === 'BUY' ? 'text-[var(--green)] font-bold' :
                        e.decision === 'SELL' ? 'text-[var(--red)] font-bold' :
                        'text-[var(--yellow)] font-bold'
                      }>{e.decision}</span>
                    )}
                    {e.confidence != null && (
                      <span className="ml-1.5">· {(parseFloat(e.confidence) * 100).toFixed(0)}%</span>
                    )}
                  </div>
                </div>
              </div>
              <span className="text-[10px] text-[var(--text-dim)]">{time}</span>
            </div>
            {payload.reason && (
              <div className="text-[12px] text-[var(--text)]/80 leading-snug">{payload.reason}</div>
            )}
            {payload.error && (
              <div className="text-[12px] text-[var(--red)]">{payload.error}</div>
            )}
            {!compact && models && Array.isArray(models) && models.length > 0 && (
              <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {models.map((m, i) => (
                  <div key={i} className="bg-white/3 border border-white/5 rounded-xl p-2">
                    <div className="flex items-center justify-between text-[11px] mb-0.5">
                      <span className="font-semibold">{m.label || m.model}</span>
                      <span className={
                        m.action === 'BUY' ? 'text-[var(--green)] font-semibold' :
                        m.action === 'SELL' ? 'text-[var(--red)] font-semibold' :
                        'text-[var(--yellow)] font-semibold'
                      }>{m.action} {(m.confidence * 100).toFixed(0)}%</span>
                    </div>
                    {m.rationale && (
                      <div className="text-[10.5px] text-[var(--text-dim)] leading-snug">{m.rationale}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
