// =============================================================================
// 20-YEAR HISTORICAL INTELLIGENCE LAYER
// =============================================================================
//
// Runs ONCE PER DAY (early morning, before US market open) for the entire
// watchlist. For every symbol it:
//
//   • pulls up to 20 YEARS of daily bars (Alpaca IEX, paginated)
//   • pulls the last ~90 days of 1-hour bars (intraday tendencies)
//   • computes long-term character: CAGR, trend regime, 200D/52W structure,
//     drawdown behaviour, post-event drift after >2% gaps
//   • computes seasonality: monthly bias (which months tend to be up/down),
//     day-of-week bias, hour-of-day bias from recent intraday data
//   • computes the current volatility regime vs 20-year baseline
//   • compares the recent 90-day character to the long-term character
//
// Results are cached in PostgreSQL keyed by symbol+date. The agent injects the
// most relevant insights into every LLM prompt — with extra emphasis during the
// first 60-90 minutes after open (when fresh intraday data is still thin and
// historical priors carry the most signal).
//
// IMPORTANT: This layer is purely informational. It NEVER alters quorum, the
// confidence gate, sizing, stops, the circuit breaker, or any other safety
// rule. It is one more structured input the 4-LLM ensemble can weigh.
// =============================================================================

const alpacaService = require('./alpacaService');
const db = require('./db');
const { getWatchlist } = require('../strategies');

const MS_DAY = 86400 * 1000;
const DAILY_LOOKBACK_DAYS = 20 * 365 + 5;     // 20Y + leap pad
const HOURLY_LOOKBACK_DAYS = 90;

// --- Tiny stat helpers -------------------------------------------------------
function mean(a)        { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function pct(a, b)      { return b ? ((a - b) / b) * 100 : 0; }
function sma(arr, n)    {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

// Annualised realised volatility (%) from the last `lookback` daily closes.
function realizedVol(closes, lookback) {
  const slice = closes.slice(-Math.min(lookback || closes.length, closes.length));
  if (slice.length < 5) return null;
  const rets = [];
  for (let i = 1; i < slice.length; i++) rets.push(Math.log(slice[i] / slice[i - 1]));
  const m = mean(rets);
  const v = mean(rets.map(r => (r - m) ** 2));
  return Math.sqrt(v) * Math.sqrt(252) * 100;
}

// --- Seasonality -------------------------------------------------------------

// Monthly: aggregate per-month return (last_close / first_open - 1) across years.
function monthlySeasonality(dailyBars) {
  const byMonth = Array.from({ length: 12 }, () => []);
  const groups = new Map();
  for (const b of dailyBars) {
    const d = new Date(b.t);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  for (const [key, bars] of groups) {
    if (bars.length < 5) continue;
    const m = parseInt(key.split('-')[1], 10);
    byMonth[m].push(pct(bars[bars.length - 1].c, bars[0].o));
  }
  return byMonth.map((arr, m) => ({
    month: m + 1,
    avgPct: +mean(arr).toFixed(2),
    posRate: arr.length ? +(arr.filter(x => x > 0).length / arr.length * 100).toFixed(0) : 0,
    sample: arr.length,
  }));
}

// Day-of-week: per-session close-to-close return on each weekday (Mon..Fri).
function weekdayTendency(dailyBars) {
  const byDow = Array.from({ length: 7 }, () => []);
  for (let i = 1; i < dailyBars.length; i++) {
    const d = new Date(dailyBars[i].t);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    byDow[dow].push(pct(dailyBars[i].c, dailyBars[i - 1].c));
  }
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return [1, 2, 3, 4, 5].map(d => ({
    dow: d,
    name: names[d],
    avgPct: +mean(byDow[d]).toFixed(3),
    posRate: byDow[d].length ? +(byDow[d].filter(x => x > 0).length / byDow[d].length * 100).toFixed(0) : 0,
    sample: byDow[d].length,
  }));
}

// Hour-of-day: per-1H bar return bucketed by ET hour (9..15).
function hourOfDayTendency(hourlyBars) {
  const byHour = new Map();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false,
  });
  for (const b of hourlyBars) {
    const etHour = parseInt(fmt.format(new Date(b.t)), 10);
    if (Number.isNaN(etHour)) continue;
    const ret = pct(b.c, b.o);
    if (!byHour.has(etHour)) byHour.set(etHour, []);
    byHour.get(etHour).push(ret);
  }
  const out = [];
  for (let h = 9; h <= 15; h++) {
    const arr = byHour.get(h) || [];
    out.push({
      hourET: h,
      avgPct: +mean(arr).toFixed(3),
      posRate: arr.length ? +(arr.filter(x => x > 0).length / arr.length * 100).toFixed(0) : 0,
      sample: arr.length,
    });
  }
  return out;
}

// --- Long-term structure -----------------------------------------------------

function computeTrendRegime(dailyBars) {
  if (dailyBars.length < 50) return { regime: 'unknown', reason: 'insufficient history' };
  const closes = dailyBars.map(b => b.c);
  const last = closes[closes.length - 1];
  const sma200 = sma(closes, Math.min(200, closes.length));
  const sma50  = sma(closes, Math.min(50,  closes.length));
  const oneYearAgo = closes[Math.max(0, closes.length - 252)];
  const yearChange = pct(last, oneYearAgo);

  let regime;
  if (sma200 && last > sma200 * 1.05 && yearChange >  5) regime = 'bull';
  else if (sma200 && last < sma200 * 0.95 && yearChange < -5) regime = 'bear';
  else regime = 'range';

  return {
    regime,
    last: +last.toFixed(2),
    sma50: sma50 ? +sma50.toFixed(2) : null,
    sma200: sma200 ? +sma200.toFixed(2) : null,
    distFromSma200Pct: sma200 ? +pct(last, sma200).toFixed(2) : null,
    oneYearChangePct: +yearChange.toFixed(2),
  };
}

function computeDrawdowns(dailyBars) {
  const closes = dailyBars.map(b => b.c);
  if (!closes.length) return null;
  let peak = closes[0];
  let maxDD = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (c - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  const last252 = closes.slice(-252);
  const fiftyTwoHigh = Math.max(...last252);
  const fiftyTwoLow  = Math.min(...last252);
  const last = closes[closes.length - 1];
  return {
    twentyYearMaxDDPct: +(maxDD * 100).toFixed(1),
    fiftyTwoHigh: +fiftyTwoHigh.toFixed(2),
    fiftyTwoLow:  +fiftyTwoLow.toFixed(2),
    distFrom52WHighPct: +pct(last, fiftyTwoHigh).toFixed(2),
    distFrom52WLowPct:  +pct(last, fiftyTwoLow).toFixed(2),
  };
}

function computeCagr(dailyBars) {
  if (dailyBars.length < 252) return null;
  const first = dailyBars[0].c;
  const last  = dailyBars[dailyBars.length - 1].c;
  const years = (new Date(dailyBars[dailyBars.length - 1].t) - new Date(dailyBars[0].t)) / (MS_DAY * 365.25);
  if (years < 1 || first <= 0) return null;
  return +(((last / first) ** (1 / years) - 1) * 100).toFixed(2);
}

// Behaviour after a >2% open gap (proxy for "post-event drift").
function postGapDrift(dailyBars) {
  const upGap = [], downGap = [];
  for (let i = 1; i < dailyBars.length - 3; i++) {
    const gap = pct(dailyBars[i].o, dailyBars[i - 1].c);
    if (Math.abs(gap) < 2) continue;
    const fwd3 = pct(dailyBars[i + 3].c, dailyBars[i].c);
    if (gap > 0) upGap.push(fwd3); else downGap.push(fwd3);
  }
  return {
    afterUpGap2pct:   { avg3dPct: +mean(upGap).toFixed(2),   sample: upGap.length },
    afterDownGap2pct: { avg3dPct: +mean(downGap).toFixed(2), sample: downGap.length },
  };
}

// --- Per-symbol compute ------------------------------------------------------

async function computeForSymbol(symbol) {
  const now = new Date();
  const startDaily  = new Date(now.getTime() - DAILY_LOOKBACK_DAYS  * MS_DAY);
  const startHourly = new Date(now.getTime() - HOURLY_LOOKBACK_DAYS * MS_DAY);

  // 20Y of daily bars + 90d of hourly bars. Alpaca caps at 10000 bars/page;
  // 20Y * ~252 = ~5040 bars, well under the cap.
  // CRITICAL: adjustment: 'all' = split + dividend adjusted. Without this,
  // splits look like catastrophic crashes and CAGR/regime/drawdown are wrong.
  // noMock: true — fail closed on Alpaca errors so we never cache synthetic
  // bars and pass them off as a 20-year analysis.
  let dailyBars, hourlyBars;
  try {
    [dailyBars, hourlyBars] = await Promise.all([
      alpacaService.getBars(symbol, '1Day',  10000, { start: startDaily.toISOString(),  paginate: true, adjustment: 'all', noMock: true }),
      alpacaService.getBars(symbol, '1Hour', 10000, { start: startHourly.toISOString(), paginate: true, adjustment: 'all', noMock: true }),
    ]);
  } catch (e) {
    return { symbol, ok: false, reason: `Alpaca fetch failed: ${e.message}` };
  }

  if (!dailyBars || !dailyBars.length) {
    return { symbol, ok: false, reason: 'No daily bars returned from Alpaca' };
  }

  const yearsAvail = +(((new Date(dailyBars[dailyBars.length - 1].t) - new Date(dailyBars[0].t)) / (MS_DAY * 365.25)).toFixed(1));
  const closes = dailyBars.map(b => b.c);

  return {
    symbol,
    ok: true,
    asOfDate: now.toISOString().slice(0, 10),
    sampleBars: { daily: dailyBars.length, hourly: hourlyBars.length, yearsAvailable: yearsAvail },
    cagrPct: computeCagr(dailyBars),
    trendRegime: computeTrendRegime(dailyBars),
    drawdowns: computeDrawdowns(dailyBars),
    volatility: {
      vol30dPct:  realizedVol(closes, 30)  != null ? +realizedVol(closes, 30).toFixed(1)  : null,
      vol1yPct:   realizedVol(closes, 252) != null ? +realizedVol(closes, 252).toFixed(1) : null,
      vol20yPct:  realizedVol(closes)      != null ? +realizedVol(closes).toFixed(1)      : null,
    },
    seasonality: {
      monthly: monthlySeasonality(dailyBars),
      weekday: weekdayTendency(dailyBars),
      hourly:  hourOfDayTendency(hourlyBars),
    },
    recent90d: {
      changePct: closes.length >= 63 ? +pct(closes[closes.length - 1], closes[closes.length - 63]).toFixed(2) : null,
      vol30dPct: realizedVol(closes, 30) != null ? +realizedVol(closes, 30).toFixed(1) : null,
    },
    postEventDrift: postGapDrift(dailyBars),
  };
}

// --- DB cache ----------------------------------------------------------------

async function saveIntelligence(symbol, payload) {
  await db.query(
    `INSERT INTO historical_intelligence (symbol, as_of_date, payload, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (symbol) DO UPDATE SET
       as_of_date = EXCLUDED.as_of_date,
       payload    = EXCLUDED.payload,
       updated_at = NOW()`,
    [symbol, payload.asOfDate, JSON.stringify(payload)]
  );
}

async function getCached(symbol) {
  try {
    const { rows } = await db.query(
      `SELECT symbol, as_of_date::text AS as_of_date, payload, updated_at
         FROM historical_intelligence WHERE symbol = $1`,
      [symbol]
    );
    return rows[0] || null;
  } catch (_) { return null; }
}

// --- Watchlist-wide daily run ------------------------------------------------

async function runDailyIntelligence({ force = false, concurrency = 3 } = {}) {
  const symbols = getWatchlist();
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[Intel] Daily run starting (${symbols.length} symbols, today=${today}, force=${force})`);

  // Skip symbols already cached for today unless force.
  const todo = [];
  const results = [];
  for (const sym of symbols) {
    const cached = await getCached(sym);
    if (!force && cached && cached.as_of_date === today) {
      results.push({ symbol: sym, cached: true });
    } else {
      todo.push(sym);
    }
  }

  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      try {
        const insight = await computeForSymbol(sym);
        if (insight.ok) {
          await saveIntelligence(sym, insight);
          results.push({ symbol: sym, ok: true, years: insight.sampleBars.yearsAvailable });
          console.log(`[Intel] ✓ ${sym} (${insight.sampleBars.yearsAvailable}Y, ${insight.sampleBars.daily} daily bars)`);
        } else {
          results.push({ symbol: sym, ok: false, reason: insight.reason });
          console.log(`[Intel] ✗ ${sym}: ${insight.reason}`);
        }
      } catch (e) {
        results.push({ symbol: sym, ok: false, reason: e.message });
        console.error(`[Intel] ✗ ${sym}:`, e.message);
      }
      // Light pacing — be polite to the data API.
      await new Promise(r => setTimeout(r, 200));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const summary = {
    date: today,
    symbols: symbols.length,
    computed: results.filter(r => r.ok).length,
    cached:   results.filter(r => r.cached).length,
    failed:   results.filter(r => r.ok === false).length,
  };
  await db.recordAudit({ event_type: 'INTELLIGENCE_REFRESHED', payload: summary });
  console.log(`[Intel] Daily run complete:`, summary);
  return results;
}

// --- Prompt rendering --------------------------------------------------------
// Returns a compact text block for LLM injection, or null if no cache yet.
// `withinFirst90Min` flips on an "early-session" emphasis line so all 4 models
// know to lean harder on these priors when intraday data is still thin.

async function getInsightsForPrompt(symbol, { withinFirst90Min = false, maxAgeDays = 7 } = {}) {
  const cached = await getCached(symbol);
  if (!cached) return null;
  const p = cached.payload || {};
  if (!p.ok) return null;
  // Stale guard: never inject ancient data silently. If the cache is older
  // than maxAgeDays we drop it (the daily refresh job will repopulate it).
  const ageDays = (Date.now() - new Date(cached.as_of_date).getTime()) / 86400000;
  if (ageDays > maxAgeDays) return null;
  const stale = ageDays > 1.5; // flag in the rendered block if >36h old

  const tr   = p.trendRegime  || {};
  const dd   = p.drawdowns    || {};
  const vol  = p.volatility   || {};
  const seas = p.seasonality  || {};
  const rec  = p.recent90d    || {};
  const drift = p.postEventDrift || {};

  // Today's calendar context in ET.
  const now = new Date();
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'long', weekday: 'long',
  }).formatToParts(now);
  const monthName   = etParts.find(p => p.type === 'month')?.value || '';
  const weekdayName = etParts.find(p => p.type === 'weekday')?.value || '';

  // Resolve numeric month/weekday in ET (1..12, 0..6).
  const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const monthIdx0   = etTime.getMonth();
  const weekdayIdx0 = etTime.getDay();

  const monthInfo   = (seas.monthly || [])[monthIdx0];
  const weekdayInfo = (seas.weekday || []).find(w => w.dow === weekdayIdx0);
  const hours = seas.hourly || [];
  const firstHr = hours.find(h => h.hourET === 9) || hours.find(h => h.hourET === 10);
  const lunch   = hours.find(h => h.hourET === 12);
  const lastHr  = hours.find(h => h.hourET === 15);

  const volRegime = (vol.vol30dPct != null && vol.vol20yPct != null)
    ? (vol.vol30dPct > vol.vol20yPct * 1.2 ? 'ELEVATED'
       : vol.vol30dPct < vol.vol20yPct * 0.8 ? 'COMPRESSED'
       : 'NORMAL')
    : 'unknown';

  const recentAlignment = (rec.changePct != null && p.cagrPct != null)
    ? (Math.sign(rec.changePct) === Math.sign(p.cagrPct) ? 'aligned with long-term character' : 'divergent from long-term character')
    : '—';

  const sgn = n => n == null ? 'n/a' : (n >= 0 ? `+${n}` : `${n}`);
  const lines = [];
  const staleTag = stale ? ' ⚠ STALE' : '';
  lines.push(`Historical context (${p.sampleBars.yearsAvailable}Y daily + ${p.sampleBars.hourly} hourly bars; refreshed ${cached.as_of_date}${staleTag}):`);
  lines.push(`  Long-term: ${p.cagrPct != null ? p.cagrPct + '% CAGR' : 'CAGR n/a'} · Regime: ${String(tr.regime || 'unknown').toUpperCase()} (price ${sgn(tr.distFromSma200Pct)}% vs 200D SMA, 1Y ${sgn(tr.oneYearChangePct)}%)`);
  lines.push(`  Volatility regime: ${volRegime} (30D ${vol.vol30dPct ?? 'n/a'}% vs 20Y avg ${vol.vol20yPct ?? 'n/a'}%)`);
  lines.push(`  Drawdowns: 20Y max ${dd.twentyYearMaxDDPct ?? 'n/a'}% · ${sgn(dd.distFrom52WHighPct)}% from 52W high ($${dd.fiftyTwoHigh ?? '?'}), ${sgn(dd.distFrom52WLowPct)}% from 52W low ($${dd.fiftyTwoLow ?? '?'})`);
  if (monthInfo)   lines.push(`  Seasonality — ${monthName}: avg ${sgn(monthInfo.avgPct)}% (${monthInfo.posRate}% positive, n=${monthInfo.sample} years)`);
  if (weekdayInfo) lines.push(`  Day-of-week — ${weekdayName}: avg ${sgn(weekdayInfo.avgPct)}%/session (${weekdayInfo.posRate}% positive, n=${weekdayInfo.sample})`);
  if (firstHr || lunch || lastHr) {
    const fmt = h => h ? `${h.hourET}:00 ET ${sgn(h.avgPct)}%/${h.posRate}% pos` : null;
    lines.push(`  Hour-of-day (last 90d): ${[fmt(firstHr), fmt(lunch), fmt(lastHr)].filter(Boolean).join(' · ')}`);
  }
  lines.push(`  Recent 90d: ${sgn(rec.changePct)}% drift (${recentAlignment})`);
  if ((drift.afterUpGap2pct?.sample || 0) > 5 || (drift.afterDownGap2pct?.sample || 0) > 5) {
    lines.push(`  Post-gap drift (>2% gap, next 3d avg): up-gap ${sgn(drift.afterUpGap2pct.avg3dPct)}% (n=${drift.afterUpGap2pct.sample}) · down-gap ${sgn(drift.afterDownGap2pct.avg3dPct)}% (n=${drift.afterDownGap2pct.sample})`);
  }
  if (withinFirst90Min) {
    lines.push(`  ⚡ EARLY SESSION (first 90 min after open): intraday data is still thin — weight hour-of-day bias, monthly seasonality, and regime more heavily.`);
  }
  return lines.join('\n');
}

module.exports = {
  runDailyIntelligence,
  getInsightsForPrompt,
  computeForSymbol,
  getCached,
  saveIntelligence,
};
