// Side-by-side US + ASX session clocks. Mirrors the existing US clock
// (NYSE 09:30–16:00 ET) and adds ASX (10:00–16:00 Sydney). Both are
// timezone-correct via Intl, so DST transitions on either side just work.

import { useEffect, useState } from 'react';

const DAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function readTZ(now, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return {
    y: +parts.year, mo: +parts.month, d: +parts.day,
    h: (+parts.hour) % 24, mi: +parts.minute, s: +parts.second,
    weekday: parts.weekday,
  };
}

// Convert a wall-clock instant in `tz` to a real UTC epoch ms. Same DST-safe
// convergence trick as the US-only clock — works for any IANA zone.
function tzWallToEpoch(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let i = 0; i < 3; i += 1) {
    const r = readTZ(new Date(guess), tz);
    const guessAsTz = Date.UTC(r.y, r.mo - 1, r.d, r.h, r.mi, r.s);
    const offset = guessAsTz - guess;
    if (offset === 0) break;
    guess = Date.UTC(y, mo - 1, d, h, mi, 0) - offset;
  }
  return guess;
}

function statusFor({ now, tz, openMin, closeMin }) {
  const r = readTZ(now, tz);
  const dow = DAY_MAP[r.weekday];
  const minutes = r.h * 60 + r.mi;
  const isWeekday = dow >= 1 && dow <= 5;
  const isOpen = isWeekday && minutes >= openMin && minutes < closeMin;

  let label, targetEpoch;
  if (isOpen) {
    label = 'closes';
    targetEpoch = tzWallToEpoch(r.y, r.mo, r.d, Math.floor(closeMin / 60), closeMin % 60, tz);
  } else {
    label = 'opens';
    let dayOffset;
    if (isWeekday && minutes < openMin) {
      dayOffset = 0;
    } else {
      dayOffset = 1;
      let testDow = (dow + 1) % 7;
      while (testDow === 0 || testDow === 6) { dayOffset += 1; testDow = (testDow + 1) % 7; }
    }
    const future = new Date(now.getTime() + dayOffset * 86400000);
    const fut = readTZ(future, tz);
    targetEpoch = tzWallToEpoch(fut.y, fut.mo, fut.d, Math.floor(openMin / 60), openMin % 60, tz);
  }
  return { isOpen, label, ms: Math.max(0, targetEpoch - now.getTime()) };
}

function formatHMS(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

const MARKETS = [
  { id: 'US',  name: 'US',  flag: '🇺🇸', tz: 'America/New_York',  openMin: 9 * 60 + 30, closeMin: 16 * 60, sub: 'NYSE · Nasdaq · 09:30–16:00 ET',  tzShort: 'ET'  },
  { id: 'ASX', name: 'ASX', flag: '🇦🇺', tz: 'Australia/Sydney', openMin: 10 * 60,     closeMin: 16 * 60, sub: 'ASX · 10:00–16:00 Sydney',         tzShort: 'AEST/AEDT' },
];

function MarketPanel({ m, now }) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: m.tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const { isOpen, label, ms } = statusFor({ now, tz: m.tz, openMin: m.openMin, closeMin: m.closeMin });
  const dot = isOpen ? 'bg-[var(--green)]' : 'bg-[var(--text-dim)]';
  return (
    <div className="rounded-2xl bg-white/[0.03] border border-white/5 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`inline-block w-2 h-2 rounded-full ${dot} ${isOpen ? 'animate-pulse' : ''} flex-shrink-0`} />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold flex items-center gap-1.5">
              <span aria-hidden>{m.flag}</span>
              <span>{m.name} {isOpen ? 'Open' : 'Closed'}</span>
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] truncate">{m.sub}</div>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)]">{label} in</div>
          <div className="text-base sm:text-lg font-semibold tracking-tight font-mono tabular-nums">{formatHMS(ms)}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--text-dim)]">
        <span>{m.tzShort}</span>
        <span className="font-mono tabular-nums text-white/85">{fmt.format(now)}</span>
      </div>
    </div>
  );
}

export default function MarketClocks({ compact = false }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  if (compact) {
    return (
      <div className="grid grid-cols-2 gap-2">
        {MARKETS.map(m => {
          const { isOpen, label, ms } = statusFor({ now, tz: m.tz, openMin: m.openMin, closeMin: m.closeMin });
          return (
            <div key={m.id} className="flex items-center gap-1.5 text-[11px]">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${isOpen ? 'bg-[var(--green)] animate-pulse' : 'bg-[var(--text-dim)]'}`} />
              <span className="font-medium">{m.flag} {m.name}</span>
              <span className="text-[var(--text-dim)]">·</span>
              <span className="text-[var(--text-dim)]">{label}</span>
              <span className="font-mono text-white/85">{formatHMS(ms)}</span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="rounded-3xl bg-white/[0.03] border border-white/5 p-3 sm:p-4 backdrop-blur-xl">
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="text-[12px] font-semibold tracking-tight">Market Sessions</div>
        <div className="text-[10px] text-[var(--text-dim)]">live · all times local to each market</div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3">
        {MARKETS.map(m => <MarketPanel key={m.id} m={m} now={now} />)}
      </div>
    </div>
  );
}
