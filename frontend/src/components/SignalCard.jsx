const ACTION_COLORS = {
  BUY: 'text-[#00c851] border-[#00c851]/30 bg-[#00c851]/5',
  SELL: 'text-[#ff4444] border-[#ff4444]/30 bg-[#ff4444]/5',
  HOLD: 'text-[#ffbb33] border-[#ffbb33]/30 bg-[#ffbb33]/5',
};

const MODEL_LABELS = {
  gemini: 'Gemini',
  claude: 'Claude',
  gpt4o: 'GPT-4o',
  grok: 'Grok',
};

export default function SignalCard({ signal }) {
  const colorClass = ACTION_COLORS[signal.signal] || ACTION_COLORS.HOLD;
  const confidence = (signal.confidence * 100).toFixed(1);

  return (
    <div className={`border rounded-xl p-4 ${colorClass}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="font-bold text-lg font-mono">{signal.symbol}</span>
        <span className={`text-xs font-bold px-2 py-1 rounded border ${colorClass}`}>
          {signal.signal}
        </span>
      </div>
      <div className="flex items-center justify-between text-sm mb-3">
        <span className="text-[#8b949e]">${typeof signal.price === 'number' ? signal.price.toFixed(2) : signal.price}</span>
        <span className="text-[#8b949e]">{signal.change}</span>
      </div>
      <div className="mb-2">
        <div className="flex justify-between text-xs text-[#8b949e] mb-1">
          <span>Confidence</span>
          <span>{confidence}%</span>
        </div>
        <div className="w-full bg-[#30363d] rounded-full h-1.5">
          <div
            className="h-1.5 rounded-full transition-all"
            style={{
              width: `${confidence}%`,
              backgroundColor: signal.signal === 'BUY' ? '#00c851' : signal.signal === 'SELL' ? '#ff4444' : '#ffbb33',
            }}
          />
        </div>
      </div>
      {signal.votes && (
        <div className="flex gap-2 mt-2 flex-wrap">
          {Object.entries(signal.votes).map(([action, count]) =>
            count > 0 ? (
              <span key={action} className="text-xs bg-[#0d1117] border border-[#30363d] px-2 py-0.5 rounded font-mono">
                {action}: {count}
              </span>
            ) : null
          )}
        </div>
      )}
      {signal.models && signal.models.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {signal.models.map(m => (
            <span key={m.model} className="text-xs text-[#8b949e] bg-[#0d1117] px-1.5 py-0.5 rounded border border-[#30363d]">
              {MODEL_LABELS[m.model] || m.model}: {m.action}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 text-xs text-[#8b949e]">
        {new Date(signal.timestamp).toLocaleTimeString()}
      </div>
    </div>
  );
}
