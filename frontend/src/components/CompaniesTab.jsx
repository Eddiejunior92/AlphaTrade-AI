import { useMemo, useState } from 'react';
import MarketFilter from './MarketFilter';
import SectorFilter, { buildSectorCounts, sectorMeta } from './SectorFilter';
import { SECTORS } from '../lib/sectors';

// Companies tab — one card per stock in the combined US + ASX universe,
// grouped by sector. Static catalog (name/sector/industry/description)
// renders instantly; live fundamentals (P/E, EPS growth, valuation, sector
// strength) come from the swing-strategy fundamentals cache when present.
//
// Quick-link buttons jump the user to the Markets card or the Pre-market
// briefing for that symbol — both flows already exist in App.jsx.
export default function CompaniesTab({ companies = [], onJumpToMarkets, onJumpToBriefing }) {
  // App.jsx fetches /api/companies once on mount and shares it with every
  // surface (Markets sector lookup, Live Signals chip, etc.) — we consume
  // that same list here instead of re-fetching to keep one source of truth.
  const [marketFilter, setMarketFilter] = useState('ALL');
  const [sectorFilter, setSectorFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const all = companies;
  const loading = !companies || companies.length === 0;

  // Apply market + search first; sector filter is applied per-section so the
  // counts in the chip row reflect what *would* show if you selected each.
  const afterMarketAndSearch = useMemo(() => {
    const q = search.trim().toUpperCase();
    return all.filter(c => {
      if (marketFilter !== 'ALL' && c.market !== marketFilter) return false;
      if (q && !c.symbol.includes(q) && !c.name.toUpperCase().includes(q)) return false;
      return true;
    });
  }, [all, marketFilter, search]);

  const marketCounts = useMemo(() => ({
    US:  all.filter(c => c.market === 'US').length,
    ASX: all.filter(c => c.market === 'ASX').length,
  }), [all]);

  const sectorCounts = useMemo(
    () => buildSectorCounts(afterMarketAndSearch, c => c.sector),
    [afterMarketAndSearch],
  );

  const visible = sectorFilter === 'ALL'
    ? afterMarketAndSearch
    : afterMarketAndSearch.filter(c => c.sector === sectorFilter);

  // Group visible companies by sector, preserving the canonical sector order.
  const grouped = useMemo(() => {
    const bySector = new Map();
    for (const c of visible) {
      const s = c.sector || 'Other';
      if (!bySector.has(s)) bySector.set(s, []);
      bySector.get(s).push(c);
    }
    // Sort each sector's companies alphabetically by symbol.
    for (const arr of bySector.values()) arr.sort((a, b) => a.symbol.localeCompare(b.symbol));
    // Emit groups in canonical order, then any unknown sector at the end.
    const ordered = [];
    for (const s of SECTORS) {
      if (bySector.has(s.id)) ordered.push([s.id, bySector.get(s.id)]);
    }
    for (const [k, v] of bySector.entries()) {
      if (!SECTORS.find(s => s.id === k)) ordered.push([k, v]);
    }
    return ordered;
  }, [visible]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="glass-strong p-5 bg-gradient-to-br from-[var(--purple)]/10 to-transparent">
        <div className="flex items-center gap-3">
          <div className="text-3xl">🏢</div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Companies</h2>
            <div className="text-[12px] text-[var(--text-dim)]">
              Every stock Alpha follows — grouped by sector with name, description, and key fundamentals when available.
            </div>
          </div>
        </div>
      </div>

      {/* Scope controls */}
      <div className="flex flex-wrap items-center gap-2">
        <MarketFilter value={marketFilter} onChange={setMarketFilter} counts={marketCounts} />
        <SectorFilter value={sectorFilter} onChange={setSectorFilter} counts={sectorCounts} />
        <div className="ml-auto flex items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search ticker or name…"
            className="text-[12px] px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 placeholder:text-[var(--text-dim)] focus:outline-none focus:border-white/20 w-48"
          />
          <span className="text-[11px] text-[var(--text-dim)]">
            {visible.length} of {all.length}
          </span>
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div className="rounded-3xl bg-white/[0.03] border border-white/5 p-8 text-center text-sm text-[var(--text-dim)]">
          Loading companies…
        </div>
      ) : grouped.length === 0 ? (
        <div className="rounded-3xl bg-white/[0.03] border border-white/5 p-8 text-center text-sm text-[var(--text-dim)]">
          No companies match these filters.
        </div>
      ) : (
        grouped.map(([sectorId, companies]) => {
          const meta = sectorMeta(sectorId);
          return (
            <section key={sectorId}>
              <div className="sticky top-0 z-10 -mx-1 px-1 py-1 mb-2 backdrop-blur bg-[var(--bg)]/70">
                <div className="flex items-baseline gap-2">
                  <span aria-hidden>{meta.icon}</span>
                  <h3 className={`text-[13px] font-semibold tracking-tight ${meta.accent}`}>{meta.label}</h3>
                  <span className="text-[11px] text-[var(--text-dim)]">{companies.length}</span>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {companies.map(c => (
                  <CompanyCard key={c.symbol} c={c}
                    onJumpToMarkets={onJumpToMarkets}
                    onJumpToBriefing={onJumpToBriefing} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function CompanyCard({ c, onJumpToMarkets, onJumpToBriefing }) {
  const f = c.fundamentals;
  const valColor = {
    cheap: 'text-[var(--green)]', fair: 'text-[var(--yellow)]', rich: 'text-[var(--red)]',
  }[f?.valuationLabel] || 'text-[var(--text-dim)]';
  const sectColor = {
    strong: 'text-[var(--green)]', flat: 'text-[var(--yellow)]', weak: 'text-[var(--red)]',
  }[f?.sectorStrengthLabel] || 'text-[var(--text-dim)]';

  return (
    <div className="glass p-4 flex flex-col gap-3">
      {/* Header: symbol + name + market badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-bold text-[15px] flex items-center gap-1.5">
            <span>{c.symbol}</span>
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
              c.market === 'ASX' ? 'bg-[var(--purple)]/20 text-[var(--purple)]' : 'bg-[var(--blue)]/20 text-[var(--blue)]'
            }`}>{c.market}</span>
          </div>
          <div className="text-[12px] text-white/90 truncate">{c.name}</div>
          <div className="text-[10px] text-[var(--text-dim)] truncate">{c.industry}</div>
        </div>
      </div>

      {/* Description */}
      <div className="text-[11px] text-[var(--text-dim)] leading-snug line-clamp-3">
        {c.description}
      </div>

      {/* Fundamentals grid (if cached) */}
      {f ? (
        <div className="grid grid-cols-3 gap-2 text-[11px] bg-white/[0.02] rounded-xl p-2">
          <Stat label="P/E" value={f.peRatio != null ? f.peRatio.toFixed(1) : '—'} />
          <Stat label="EPS YoY" value={f.epsGrowthYoyPct != null ? `${f.epsGrowthYoyPct >= 0 ? '+' : ''}${f.epsGrowthYoyPct}%` : '—'}
                color={f.epsGrowthYoyPct != null ? (f.epsGrowthYoyPct >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]') : ''} />
          <Stat label="Rev YoY" value={f.revenueGrowthYoyPct != null ? `${f.revenueGrowthYoyPct >= 0 ? '+' : ''}${f.revenueGrowthYoyPct}%` : '—'}
                color={f.revenueGrowthYoyPct != null ? (f.revenueGrowthYoyPct >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]') : ''} />
          <Stat label="Valuation" value={f.valuationLabel || '—'} color={valColor} />
          <Stat label="Sector 30d" value={f.sectorStrength30dPct != null ? `${f.sectorStrength30dPct >= 0 ? '+' : ''}${f.sectorStrength30dPct}%` : '—'} color={sectColor} />
          <Stat label="Earnings" value={f.earningsNextDate ? f.earningsNextDate.slice(5) : '—'} />
        </div>
      ) : (
        <div className="text-[10px] text-[var(--text-dim)] italic bg-white/[0.02] rounded-xl p-2">
          Live fundamentals load when the swing strategy analyzes this name.
        </div>
      )}

      {/* Quick links */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => onJumpToMarkets?.(c.symbol)}
          className="flex-1 text-[11px] font-medium px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/90 transition"
        >
          📈 Markets
        </button>
        <button
          onClick={() => onJumpToBriefing?.(c.symbol)}
          className="flex-1 text-[11px] font-medium px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/90 transition"
        >
          🌅 Briefing
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, color = '' }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-[var(--text-dim)]">{label}</div>
      <div className={`text-[12px] font-semibold tabular-nums truncate ${color}`}>{value}</div>
    </div>
  );
}
