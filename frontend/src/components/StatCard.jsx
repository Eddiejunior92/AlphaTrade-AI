export default function StatCard({ label, value, sub, icon, color, accent }) {
  return (
    <div className="glass p-4 sm:p-5 transition-transform hover:-translate-y-0.5">
      <div className="flex items-start justify-between mb-2">
        <span className="text-[11px] font-medium text-[var(--text-dim)] uppercase tracking-wider">{label}</span>
        {icon && <span className="text-base opacity-60">{icon}</span>}
      </div>
      <div className={`text-2xl sm:text-3xl font-semibold tracking-tight ${color || 'text-[var(--text)]'}`}>{value}</div>
      {sub && <div className="text-[12px] text-[var(--text-dim)] mt-1">{sub}</div>}
      {accent && <div className={`mt-3 h-0.5 rounded-full ${accent}`} />}
    </div>
  );
}
