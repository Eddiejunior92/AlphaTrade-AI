export default function StatCard({ label, value, sub, color = 'text-white', icon }) {
  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4 flex flex-col gap-1">
      <div className="flex items-center gap-2 text-[#8b949e] text-xs uppercase tracking-wider">
        {icon && <span>{icon}</span>}
        {label}
      </div>
      <div className={`text-2xl font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-xs text-[#8b949e]">{sub}</div>}
    </div>
  );
}
