// Frontend mirror of the backend sector taxonomy. Single source of truth on
// the client for sector ordering, color accents, and emoji icons used by the
// SectorFilter chip and CompaniesTab grouping headers.
//
// Order here drives the chip order + Companies-tab section order. Keep
// "ETFs" last so the index/proxy buckets sit at the bottom.
export const SECTORS = [
  { id: 'Technology',         label: 'Tech',          icon: '💻', accent: 'text-[var(--blue)]' },
  { id: 'Semiconductors',     label: 'Semis',         icon: '🔌', accent: 'text-[var(--green)]' },
  { id: 'Financials',         label: 'Financials',    icon: '🏦', accent: 'text-[var(--yellow)]' },
  { id: 'Consumer',           label: 'Consumer',      icon: '🛒', accent: 'text-pink-300' },
  { id: 'Healthcare',         label: 'Healthcare',    icon: '⚕️', accent: 'text-emerald-300' },
  { id: 'Energy',             label: 'Energy',        icon: '🛢️', accent: 'text-orange-300' },
  { id: 'Materials & Mining', label: 'Mining',        icon: '⛏️', accent: 'text-amber-300' },
  { id: 'Industrials',        label: 'Industrials',   icon: '🏗️', accent: 'text-cyan-300' },
  { id: 'ETFs',               label: 'ETFs',          icon: '📊', accent: 'text-[var(--purple)]' },
];

const SECTOR_BY_ID = Object.fromEntries(SECTORS.map(s => [s.id, s]));

export function sectorMeta(sectorId) {
  return SECTOR_BY_ID[sectorId] || { id: sectorId || 'Other', label: sectorId || 'Other', icon: '•', accent: 'text-[var(--text-dim)]' };
}

// Build a lookup function for symbol -> sector. Backed by /api/companies
// data on the client (passed in once on mount).
export function makeSectorOf(companies = []) {
  const map = new Map();
  for (const c of companies) {
    if (c?.symbol) map.set(String(c.symbol).toUpperCase(), c.sector || 'Other');
  }
  return (sym) => map.get(String(sym || '').toUpperCase()) || 'Other';
}
