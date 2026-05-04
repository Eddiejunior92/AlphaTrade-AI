import { useEffect, useState } from 'react';

// US equities cash session (NYSE/Nasdaq): 09:30 – 16:00 ET, Mon–Fri.
// Holidays are not modeled — the next trading day will simply be the next weekday.
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const DAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Build a "wall-clock" reading of `now` in America/New_York. We then synthesize
// a UTC epoch from those wall components so that subtracting two such epochs
// gives the real elapsed milliseconds (both are biased by the same offset).
function readET(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const y = +parts.year, mo = +parts.month, d = +parts.day;
  const h = (+parts.hour) % 24, mi = +parts.minute, s = +parts.second;
  return { y, mo, d, h, mi, s, weekday: parts.weekday };
}

// Convert an ET wall-clock (y, mo, d, h, mi) → real UTC epoch ms.
// DST-correct: we guess, measure the ET offset at that guess, and adjust.
// The guess is at most ~1 day off the true instant, so a single iteration is
// enough except on DST-transition days where 2 iterations always converge.
function etWallToEpoch(y, mo, d, h, mi) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let i = 0; i < 3; i += 1) {
    const et = readET(new Date(guess));
    const guessAsET = Date.UTC(et.y, et.mo - 1, et.d, et.h, et.mi, et.s);
    const offset = guessAsET - guess;
    if (offset === 0) break;
    guess = Date.UTC(y, mo - 1, d, h, mi, 0) - offset;
  }
  return guess;
}

function marketStatus(now = new Date()) {
  const et = readET(now);
  const dow = DAY_MAP[et.weekday];
  const minutes = et.h * 60 + et.mi;
  const isWeekday = dow >= 1 && dow <= 5;
  const isOpen = isWeekday && minutes >= OPEN_MIN && minutes < CLOSE_MIN;

  let label, targetEpoch;
  if (isOpen) {
    label = 'closes';
    targetEpoch = etWallToEpoch(et.y, et.mo, et.d, 16, 0);
  } else {
    label = 'opens';
    let dayOffset;
    if (isWeekday && minutes < OPEN_MIN) {
      dayOffset = 0; // pre-market today
    } else {
      dayOffset = 1;
      let testDow = (dow + 1) % 7;
      while (testDow === 0 || testDow === 6) {
        dayOffset += 1;
        testDow = (testDow + 1) % 7;
      }
    }
    // Advance ET calendar day by dayOffset using a UTC-based shift, then
    // re-read ET to get the correct calendar date for that future day.
    const future = new Date(now.getTime() + dayOffset * 86400000);
    const futureET = readET(future);
    targetEpoch = etWallToEpoch(futureET.y, futureET.mo, futureET.d, 9, 30);
  }
  return { isOpen, label, ms: Math.max(0, targetEpoch - now.getTime()), et };
}

function formatHMS(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const LOCAL_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'Local'; }
})();
const LOCAL_FMT = new Intl.DateTimeFormat([], {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const LOCAL_TZ_SHORT = (() => {
  try {
    const parts = new Intl.DateTimeFormat([], { timeZoneName: 'short', hour: '2-digit' }).formatToParts(new Date());
    return parts.find(p => p.type === 'timeZoneName')?.value || '';
  } catch { return ''; }
})();

export default function MarketClock({ compact = false }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const { isOpen, label, ms } = marketStatus(now);
  const countdown = formatHMS(ms);
  const etTime = ET_FMT.format(now);
  const localTime = LOCAL_FMT.format(now);

  const dot = isOpen ? 'bg-[var(--green)]' : 'bg-[var(--text-dim)]';
  const statusText = isOpen ? 'Market Open' : 'Market Closed';

  if (compact) {
    return (
      <div className="flex items-center gap-2 text-[11px]">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot} ${isOpen ? 'animate-pulse' : ''}`} />
        <span className="text-white/85 font-medium">{statusText}</span>
        <span className="text-[var(--text-dim)]">·</span>
        <span className="text-[var(--text-dim)]">{label} in</span>
        <span className="font-mono text-white/90">{countdown}</span>
      </div>
    );
  }

  return (
    <div className="rounded-3xl bg-white/[0.03] border border-white/5 p-4 sm:p-5 backdrop-blur-xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <span className={`inline-block w-2 h-2 rounded-full ${dot} ${isOpen ? 'animate-pulse' : ''}`} />
          <div>
            <div className="text-sm font-semibold tracking-tight">{statusText}</div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)]">
              NYSE · Nasdaq · 09:30–16:00 ET
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)]">
            Market {label} in
          </div>
          <div className="text-2xl font-semibold tracking-tight font-mono tabular-nums">
            {countdown}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-3">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] mb-0.5">
            US Market Time
          </div>
          <div className="text-lg font-semibold font-mono tabular-nums">{etTime}</div>
          <div className="text-[10px] text-[var(--text-dim)] mt-0.5">America/New_York · ET</div>
        </div>
        <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-3">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] mb-0.5">
            Your Local Time
          </div>
          <div className="text-lg font-semibold font-mono tabular-nums">{localTime}</div>
          <div className="text-[10px] text-[var(--text-dim)] mt-0.5">
            {LOCAL_TZ}{LOCAL_TZ_SHORT ? ` · ${LOCAL_TZ_SHORT}` : ''}
          </div>
        </div>
      </div>
    </div>
  );
}
