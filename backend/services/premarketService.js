// Pre-market research briefing.
// Runs once per day around 8:00 AM ET (90min before open) — uses Grok with live
// web search context to scan the entire 15-symbol watchlist for overnight news,
// earnings, analyst actions, sector pulse, macro events, unusual options. The
// resulting briefing is stored in Postgres and surfaced (a) on the Home tab and
// (b) injected into the LLM prompt for the first 60 minutes after the open so
// the ensemble starts the day with context, not a cold read.

const axios = require('axios');
const db = require('./db');
const bus = require('./eventBus');

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = process.env.GROK_PREMARKET_MODEL || 'grok-4-fast-non-reasoning';
const TIMEOUT_MS = 60000;
// Briefing is "active" (injected into prompts) for this many minutes after open.
const _activeMinEnv = parseInt(process.env.PREMARKET_ACTIVE_MIN);
const ACTIVE_MINUTES_AFTER_OPEN = Number.isFinite(_activeMinEnv) && _activeMinEnv > 0 && _activeMinEnv <= 390
  ? _activeMinEnv : 60;

let scheduleHandle = null;
let runInProgress = false;
// Per-process cache of today's briefing — avoids re-querying Postgres for every
// (symbol × strategy) call inside a cycle. Invalidated on date rollover or on
// a fresh runDailyBriefing(). { date: YYYY-MM-DD, briefing: {...} | null }
let briefingCache = { date: null, briefing: null };

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS premarket_briefings (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function todayET() {
  // Returns YYYY-MM-DD in America/New_York
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date()); // en-CA gives YYYY-MM-DD
}

function buildPrompt(watchlist) {
  const symbols = watchlist.join(', ');
  return `You are a pre-market research analyst for an autonomous trading desk. The U.S. cash session opens at 9:30 AM ET. Produce a structured morning briefing for the watchlist: ${symbols}.

Use the LATEST overnight + this-morning information you can find: earnings releases, guidance, analyst upgrades/downgrades and price-target changes, M&A or regulatory headlines, futures (ES, NQ, RTY, YM), sector ETF moves (XLK, XLF, XLE, XLV, XLY, XLP, XLI, XLU), VIX, treasury yields, oil/gold, FX (DXY), economic data on the calendar today (CPI, PPI, FOMC, jobs, retail sales, etc.), and any unusual options activity rumors flagged by reputable sources.

Be concise, calibrated, and explicit when something is uncertain.

Respond with ONLY valid JSON (no markdown, no prose):
{
  "headline": "<one sentence — overall market thesis for the open>",
  "marketBias": "bullish|bearish|neutral|mixed",
  "indexFutures": {"ES":"<+/-x.xx%>", "NQ":"<+/-x.xx%>", "RTY":"<+/-x.xx%>", "VIX":"<level or change>"},
  "macroEvents": ["<event 1 — short, with time if known>", "<event 2>"],
  "sectorPulse": [
    {"sector":"<e.g. Tech/XLK>", "stance":"strong|neutral|weak", "note":"<why, short>"}
  ],
  "topSetups": [
    {
      "symbol":"<ticker from watchlist>",
      "bias":"BUY|SELL|WATCH",
      "thesis":"<one short sentence>",
      "catalyst":"<earnings beat | upgrade | guidance raise | breakdown | etc>",
      "keyLevels":{"support":<number or null>,"resistance":<number or null>,"trigger":<number or null>},
      "riskFlag":"<earnings today | gap risk | low liquidity | etc, or empty>"
    }
  ],
  "perSymbol": [
    {
      "symbol":"<ticker>",
      "newsScore": <-1 to +1>,
      "summary":"<one short sentence — dominant narrative>",
      "earningsToday": <true|false>
    }
  ],
  "warnings": ["<broad warning the agent should respect today, e.g. 'FOMC at 14:00 ET — expect volatility'>"]
}

Aim for 4–8 entries in topSetups (best risk-reward only). perSymbol must include EVERY watchlist symbol (15 entries). Numbers in keyLevels should be plausible price levels in the same units as the stock's recent close, or null if unknown. If a section has nothing material, return an empty array.`;
}

function clamp(v, lo, hi) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return +Math.max(lo, Math.min(hi, n)).toFixed(2);
}

function sanitize(obj, watchlist) {
  if (!obj || typeof obj !== 'object') return null;
  const arr = (x) => Array.isArray(x) ? x : [];
  const str = (s, max = 240) => String(s || '').slice(0, max);

  const cleanSetups = arr(obj.topSetups).slice(0, 12).map(s => ({
    symbol: str(s.symbol, 8).toUpperCase(),
    bias: ['BUY', 'SELL', 'WATCH'].includes(String(s.bias).toUpperCase()) ? String(s.bias).toUpperCase() : 'WATCH',
    thesis: str(s.thesis, 220),
    catalyst: str(s.catalyst, 120),
    keyLevels: {
      support: s.keyLevels && Number.isFinite(parseFloat(s.keyLevels.support)) ? +parseFloat(s.keyLevels.support).toFixed(2) : null,
      resistance: s.keyLevels && Number.isFinite(parseFloat(s.keyLevels.resistance)) ? +parseFloat(s.keyLevels.resistance).toFixed(2) : null,
      trigger: s.keyLevels && Number.isFinite(parseFloat(s.keyLevels.trigger)) ? +parseFloat(s.keyLevels.trigger).toFixed(2) : null,
    },
    riskFlag: str(s.riskFlag, 100),
  })).filter(s => watchlist.includes(s.symbol));

  const cleanPerSymbol = arr(obj.perSymbol).map(s => ({
    symbol: str(s.symbol, 8).toUpperCase(),
    newsScore: clamp(s.newsScore, -1, 1) ?? 0,
    summary: str(s.summary, 200),
    earningsToday: !!s.earningsToday,
  })).filter(s => watchlist.includes(s.symbol));

  return {
    headline: str(obj.headline, 240),
    marketBias: ['bullish', 'bearish', 'neutral', 'mixed'].includes(String(obj.marketBias).toLowerCase())
      ? String(obj.marketBias).toLowerCase() : 'mixed',
    indexFutures: typeof obj.indexFutures === 'object' && obj.indexFutures ? obj.indexFutures : {},
    macroEvents: arr(obj.macroEvents).slice(0, 8).map(e => str(e, 160)),
    sectorPulse: arr(obj.sectorPulse).slice(0, 10).map(s => ({
      sector: str(s.sector, 40),
      stance: ['strong', 'neutral', 'weak'].includes(String(s.stance).toLowerCase()) ? String(s.stance).toLowerCase() : 'neutral',
      note: str(s.note, 160),
    })),
    topSetups: cleanSetups,
    perSymbol: cleanPerSymbol,
    warnings: arr(obj.warnings).slice(0, 5).map(w => str(w, 200)),
  };
}

async function fetchFreshBriefing(watchlist) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return { ok: false, reason: 'XAI_API_KEY not configured' };
  try {
    const res = await axios.post(
      XAI_URL,
      {
        model: MODEL,
        messages: [{ role: 'user', content: buildPrompt(watchlist) }],
        max_tokens: 3500,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS }
    );
    const text = res.data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    const clean = sanitize(parsed, watchlist);
    if (!clean) return { ok: false, reason: 'Malformed Grok response' };
    return { ok: true, ...clean };
  } catch (e) {
    return { ok: false, reason: e.response?.data?.error?.message || e.message };
  }
}

async function runDailyBriefing(watchlist) {
  if (runInProgress) return { ok: false, reason: 'Already running' };
  runInProgress = true;
  try {
    console.log(`[Premarket] Generating briefing for ${watchlist.length} symbols...`);
    const briefing = await fetchFreshBriefing(watchlist);
    if (!briefing.ok) {
      console.error('[Premarket] Failed:', briefing.reason);
      // Still record the failure so the UI can show it.
      await db.recordAudit({
        event_type: 'PREMARKET_BRIEFING_FAILED',
        payload: { reason: briefing.reason },
      });
      return briefing;
    }
    const date = todayET();
    const payload = { ...briefing, generatedAt: new Date().toISOString(), watchlist };
    await db.query(
      `INSERT INTO premarket_briefings (date, payload) VALUES ($1, $2)
       ON CONFLICT (date) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()`,
      [date, JSON.stringify(payload)]
    );
    await db.recordAudit({
      event_type: 'PREMARKET_BRIEFING',
      payload: {
        date, headline: briefing.headline, marketBias: briefing.marketBias,
        topSetupsCount: briefing.topSetups.length, warnings: briefing.warnings,
      },
    });
    bus.emit('premarket', payload);
    // Refresh in-memory cache so the next cycle picks it up without a DB round-trip.
    briefingCache = { date, briefing: { date, ...payload } };
    console.log(`[Premarket] Briefing stored for ${date} — ${briefing.topSetups.length} top setups, bias=${briefing.marketBias}`);
    return { ok: true, ...payload };
  } finally {
    runInProgress = false;
  }
}

async function getLatestBriefing() {
  const { rows } = await db.query(
    `SELECT date, payload, created_at FROM premarket_briefings ORDER BY date DESC LIMIT 1`
  );
  if (!rows[0]) return null;
  return { date: rows[0].date, createdAt: rows[0].created_at, ...rows[0].payload };
}

// Cached variant for hot paths (per-symbol prompt injection). Hits Postgres
// only on date rollover or first call after a process boot.
async function getLatestBriefingCached() {
  const today = todayET();
  if (briefingCache.date === today && briefingCache.briefing) return briefingCache.briefing;
  const fresh = await getLatestBriefing();
  briefingCache = { date: today, briefing: fresh };
  return fresh;
}

// Returns a compact prompt-injection block IF we have today's briefing AND we're
// inside the active window (first 60 min after open). Otherwise returns null and
// the LLM prompt is unchanged. Must never throw.
async function getActiveBriefingContext(symbol, marketState) {
  try {
    if (!marketState?.open || !marketState?.nextClose) return null;
    const briefing = await getLatestBriefingCached();
    if (!briefing || briefing.date !== todayET()) return null;
    // Only inject during the first ACTIVE_MINUTES_AFTER_OPEN minutes after 9:30 ET.
    const nyHM = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
    const [hh, mm] = nyHM.split(':').map(n => parseInt(n));
    const minutesIntoSession = (hh - 9) * 60 + (mm - 30);
    if (minutesIntoSession < 0 || minutesIntoSession >= ACTIVE_MINUTES_AFTER_OPEN) return null;

    const sym = String(symbol).toUpperCase();
    const setup = briefing.topSetups?.find(s => s.symbol === sym);
    const per = briefing.perSymbol?.find(s => s.symbol === sym);
    if (!setup && !per && !briefing.warnings?.length) return null;

    const lines = [`Pre-market briefing (${briefing.date} — ${minutesIntoSession}min into session, bias: ${briefing.marketBias}):`];
    if (briefing.headline) lines.push(`  Thesis: ${briefing.headline}`);
    if (per) {
      const earn = per.earningsToday ? ' [EARNINGS TODAY]' : '';
      lines.push(`  ${sym} pre-market take${earn}: news=${per.newsScore >= 0 ? '+' : ''}${per.newsScore} — ${per.summary}`);
    }
    if (setup) {
      const lvl = setup.keyLevels || {};
      const lvlBits = [];
      if (lvl.trigger != null) lvlBits.push(`trigger $${lvl.trigger}`);
      if (lvl.support != null) lvlBits.push(`support $${lvl.support}`);
      if (lvl.resistance != null) lvlBits.push(`resistance $${lvl.resistance}`);
      lines.push(`  Pre-market setup: ${setup.bias} — ${setup.thesis} (catalyst: ${setup.catalyst || 'n/a'})${lvlBits.length ? ' · ' + lvlBits.join(', ') : ''}${setup.riskFlag ? ' · ⚠ ' + setup.riskFlag : ''}`);
    }
    if (briefing.warnings?.length) {
      lines.push(`  Session warnings: ${briefing.warnings.join(' · ')}`);
    }
    return lines.join('\n');
  } catch (_) {
    return null;
  }
}

// Resolve the UTC instant for a given ET wall-clock time on a specific NY
// calendar date. DST-safe: iteratively corrects the offset by comparing what
// NY thinks of our guess to what we asked for. Converges in ≤2 iterations.
function etWallToUtcMs(nyY, nyM, nyD, hour, minute) {
  let guess = Date.UTC(nyY, nyM - 1, nyD, hour, minute);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(guess));
    const get = (t) => parseInt(parts.find(p => p.type === t).value);
    let h = get('hour'); if (h === 24) h = 0; // some Intl impls emit "24"
    const gotUtc = Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute'));
    const wantUtc = Date.UTC(nyY, nyM - 1, nyD, hour, minute);
    const diff = wantUtc - gotUtc;
    if (diff === 0) return guess;
    guess += diff;
  }
  return guess;
}

// Compute ms until the next HH:MM in America/New_York — DST-safe.
function msUntilNextET(hour = 8, minute = 0) {
  const now = Date.now();
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const nyDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
      .format(new Date(now + dayOffset * 86400000));
    const [y, m, d] = nyDateStr.split('-').map(n => parseInt(n));
    const target = etWallToUtcMs(y, m, d, hour, minute);
    if (target > now) return target - now;
  }
  return 24 * 3600 * 1000; // fallback
}

function schedule(getWatchlist) {
  if (scheduleHandle) clearTimeout(scheduleHandle);
  const ms = msUntilNextET(8, 0);
  console.log(`[Premarket] Next briefing scheduled in ${(ms / 3600000).toFixed(2)}h (08:00 ET)`);
  scheduleHandle = setTimeout(async () => {
    try { await runDailyBriefing(getWatchlist()); } catch (e) { console.error('[Premarket] scheduled run error:', e.message); }
    schedule(getWatchlist);
  }, ms);
}

// On boot, generate a briefing if none exists for today (catches restarts after
// the 8:00 mark and the very-first run of the system).
async function bootstrapIfMissing(getWatchlist) {
  try {
    const latest = await getLatestBriefing();
    if (latest && latest.date === todayET()) {
      console.log(`[Premarket] Today's briefing already on file (${latest.date})`);
      return;
    }
    // Async, non-blocking — server boot doesn't wait on Grok.
    runDailyBriefing(getWatchlist()).catch(e => console.error('[Premarket] bootstrap error:', e.message));
  } catch (e) {
    console.error('[Premarket] bootstrap check failed:', e.message);
  }
}

module.exports = {
  ensureSchema,
  runDailyBriefing,
  getLatestBriefing,
  getActiveBriefingContext,
  schedule,
  bootstrapIfMissing,
};
