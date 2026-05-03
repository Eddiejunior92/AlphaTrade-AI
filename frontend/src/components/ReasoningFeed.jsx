const EVENT_COLORS = {
  SIGNAL: 'border-[#2196f3]/40 text-[#2196f3]',
  TRADE_EXECUTED: 'border-[#00c851]/40 text-[#00c851]',
  TRADE_REJECTED: 'border-[#8b949e]/40 text-[#8b949e]',
  TRADE_ERROR: 'border-[#ff4444]/40 text-[#ff4444]',
  CIRCUIT_BREAKER_TRIPPED: 'border-[#ff4444]/60 text-[#ff4444]',
  CIRCUIT_BREAKER_RESET: 'border-[#00c851]/40 text-[#00c851]',
  EMERGENCY_PAUSE: 'border-[#ff4444]/60 text-[#ff4444]',
  EMERGENCY_RESUME: 'border-[#00c851]/40 text-[#00c851]',
  STOP_LOSS: 'border-[#ff4444]/40 text-[#ff4444]',
  TAKE_PROFIT: 'border-[#00c851]/40 text-[#00c851]',
  AGENT_STARTED: 'border-[#00c851]/40 text-[#00c851]',
  AGENT_STOPPED: 'border-[#8b949e]/40 text-[#8b949e]',
  DAILY_RESET: 'border-[#ffbb33]/40 text-[#ffbb33]',
  CYCLE_ERROR: 'border-[#ff4444]/40 text-[#ff4444]',
};

export default function ReasoningFeed({ entries = [] }) {
  if (!entries.length) {
    return (
      <div className="text-center text-[#8b949e] py-8 text-sm">
        No AI reasoning recorded yet. Start the agent to see live decisions.
      </div>
    );
  }

  return (
    <div className="space-y-2 max-h-[600px] overflow-y-auto pr-2">
      {entries.map(e => {
        const colorClass = EVENT_COLORS[e.event_type] || 'border-[#30363d] text-[#e6edf3]';
        const time = new Date(e.created_at).toLocaleTimeString();
        const models = e.models || null;
        const payload = e.payload || {};
        return (
          <div key={e.id} className={`border-l-2 pl-3 py-1.5 ${colorClass.split(' ')[0]}`}>
            <div className="flex items-center justify-between text-xs mb-1">
              <div className="flex items-center gap-2">
                <span className={`font-mono font-semibold ${colorClass.split(' ')[1] || ''}`}>
                  {e.event_type}
                </span>
                {e.symbol && <span className="font-mono text-white">{e.symbol}</span>}
                {e.decision && (
                  <span className={`font-bold ${
                    e.decision === 'BUY' ? 'text-[#00c851]' :
                    e.decision === 'SELL' ? 'text-[#ff4444]' : 'text-[#ffbb33]'
                  }`}>{e.decision}</span>
                )}
                {e.confidence !== null && e.confidence !== undefined && (
                  <span className="text-[#8b949e]">
                    {(parseFloat(e.confidence) * 100).toFixed(0)}%
                  </span>
                )}
              </div>
              <span className="text-[#8b949e] font-mono">{time}</span>
            </div>
            {payload.reason && (
              <div className="text-xs text-[#8b949e]">{payload.reason}</div>
            )}
            {payload.error && (
              <div className="text-xs text-[#ff4444]">⚠ {payload.error}</div>
            )}
            {models && Array.isArray(models) && models.length > 0 && (
              <div className="mt-1.5 grid grid-cols-2 gap-1">
                {models.map((m, i) => (
                  <div key={i} className="text-[10px] bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-[#e6edf3]">{m.label || m.model}</span>
                      <span className={
                        m.action === 'BUY' ? 'text-[#00c851]' :
                        m.action === 'SELL' ? 'text-[#ff4444]' : 'text-[#ffbb33]'
                      }>{m.action} {(m.confidence * 100).toFixed(0)}%</span>
                    </div>
                    {m.rationale && (
                      <div className="text-[#8b949e] mt-0.5 leading-snug">{m.rationale}</div>
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
