import { SECTORS, sectorMeta } from '../lib/sectors';

// Reusable sector chip selector. Mirrors MarketFilter's compact pill style
// so a row of [MarketFilter] + [SectorFilter] reads as one consistent
// scope-control bar across Markets / Positions / Signals / Companies.
//
// `counts` is optional `{ [sectorId]: number }`. Sectors with zero entries
// are hidden when `counts` is provided so the row stays short on mobile.
// "All" is always shown and resets the filter.
export default function SectorFilter({ value = 'ALL', onChange, counts, className = '' }) {
  const visible = counts
    ? SECTORS.filter(s => (counts[s.id] || 0) > 0)
    : SECTORS;
  const total = counts ? Object.values(counts).reduce((a, b) => a + (b || 0), 0) : null;

  if (visible.length === 0 && counts) return null;

  return (
    <div className={`inline-flex flex-wrap items-center gap-1 p-0.5 rounded-2xl bg-white/5 border border-white/5 ${className}`}>
      <Chip
        active={value === 'ALL'}
        onClick={() => onChange?.('ALL')}
        icon="🌐"
        label="All"
        n={total}
      />
      {visible.map(s => (
        <Chip
          key={s.id}
          active={value === s.id}
          onClick={() => onChange?.(s.id)}
          icon={s.icon}
          label={s.label}
          n={counts ? counts[s.id] || 0 : null}
        />
      ))}
    </div>
  );
}

function Chip({ active, onClick, icon, label, n }) {
  return (
    <button
      onClick={onClick}
      className={`text-[11px] font-semibold px-2.5 py-1 rounded-xl transition-colors flex items-center gap-1.5 ${
        active ? 'bg-white/15 text-white' : 'text-[var(--text-dim)] hover:text-white'
      }`}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
      {n != null && (
        <span className={`text-[9px] tabular-nums ${active ? 'text-white/70' : 'text-[var(--text-dim)]'}`}>
          {n}
        </span>
      )}
    </button>
  );
}

// Helper: given a list of items and a getter for sector id, build a count map
// for SectorFilter. Skip items the getter returns no sector for.
export function buildSectorCounts(items, getSector) {
  const out = {};
  for (const it of items || []) {
    const s = getSector(it);
    if (!s) continue;
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}

export { sectorMeta };
