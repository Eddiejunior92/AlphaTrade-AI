// Pre-market research briefings.
// Generates ONE briefing per market per day:
//   • US  — 08:00 ET   (90min before NYSE open)   for the US watchlist
//   • ASX — 09:00 Sydney (1h before ASX open)     for the ASX watchlist
// Each briefing is stored separately in `premarket_briefings` (keyed by
// date+market), surfaced on the dashboard with a market badge, and injected
// into the LLM prompt for the first 60min (US) / 90min (ASX) after that
// market's open. The two markets are fully independent — failures or restarts
// on one side never block the other.

const axios = require('axios');
const db = require('./db');
const bus = require('./eventBus');
const marketRegistry = require('./marketRegistry');
const costTracker = require('./llmCostTracker');

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = process.env.GROK_PREMARKET_MODEL || 'grok-4-fast-non-reasoning';
const TIMEOUT_MS = 60000;

const _activeUsEnv  = parseInt(process.env.PREMARKET_ACTIVE_MIN);
const _activeAsxEnv = parseInt(process.env.PREMARKET_ASX_ACTIVE_MIN);

// Per-market session + briefing config. The `activeMinutes` window is how long
// after the open we still inject the briefing into LLM prompts.
const SESSIONS = {
  US: {
    tz: 'America/New_York',
    openH: 9,  openM: 30,
    closeH: 16, closeM: 0,
    briefH: 8, briefM: 0,
    activeMinutes: Number.isFinite(_activeUsEnv) && _activeUsEnv > 0 && _activeUsEnv <= 390 ? _activeUsEnv : 60,
    indices: 'futures (ES, NQ, RTY, YM), VIX, treasury yields, DXY, oil/gold',
    sectors: 'XLK, XLF, XLE, XLV, XLY, XLP, XLI, XLU',
    macroNotes: 'CPI, PPI, FOMC, jobs, retail sales',
    sessionLabel: 'U.S. cash session opens at 9:30 AM ET',
    currencyCode: 'USD',
    currencySymbol: '$',
    timezoneShort: 'ET',
  },
  ASX: {
    tz: 'Australia/Sydney',
    openH: 10, openM: 0,
    closeH: 16, closeM: 0,
    briefH: 9, briefM: 0,
    activeMinutes: Number.isFinite(_activeAsxEnv) && _activeAsxEnv > 0 && _activeAsxEnv <= 360 ? _activeAsxEnv : 90,
    indices: 'SPI 200 futures, ASX 200 (XJO), All Ordinaries (AORD), AUD/USD, iron ore (62% Fe), Brent, China A50, prior-day US close (S&P 500, Nasdaq, Russell)',
    sectors: 'Materials/XMJ, Financials/XFJ, Energy/XEJ, Healthcare/XHJ, REITs/XPJ, Tech/XIJ, Discretionary/XDJ, Staples/XSJ, Industrials/XNJ, Utilities/XUJ, Communications/XTJ',
    macroNotes: 'RBA cash-rate decisions/minutes, Australian CPI/employment/retail sales, China PMI/trade/property data, iron ore + commodity moves',
    sessionLabel: 'ASX cash session opens at 10:00 AM Sydney time (AEST/AEDT)',
    currencyCode: 'AUD',
    currencySymbol: 'A$',
    timezoneShort: 'Sydney',
  },
};

// Per-market state (schedule timer, in-flight guard, today's cached briefing).
const state = {
  US:  { handle: null, inflight: false, cache: { date: null, briefing: null } },
  ASX: { handle: null, inflight: false, cache: { date: null, briefing: null } },
};

function isMarket(m) { return m === 'US' || m === 'ASX'; }

async function ensureSchema() {
  // Original schema: UNIQUE(date). We split that into UNIQUE(date, market) so
  // both markets can coexist on the same calendar date without colliding.
  await db.query(`
    CREATE TABLE IF NOT EXISTS premarket_briefings (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`ALTER TABLE premarket_briefings ADD COLUMN IF NOT EXISTS market VARCHAR(8) NOT NULL DEFAULT 'US'`);
  // Drop the legacy UNIQUE(date) constraint if it survived from v1 of the table.
  await db.query(`ALTER TABLE premarket_briefings DROP CONSTRAINT IF EXISTS premarket_briefings_date_key`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS premarket_briefings_date_market_idx ON premarket_briefings(date, market)`);
}

// ---- Time helpers (DST-safe via Intl) -------------------------------------

function todayInTz(tz) {
  // YYYY-MM-DD in the given IANA timezone.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function readTz(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  let h = +parts.hour; if (h === 24) h = 0;
  return { y: +parts.year, m: +parts.month, d: +parts.day, h, mi: +parts.minute };
}

// Convert a wall-clock instant in `tz` to a real UTC epoch ms. Iteratively
// converges on the right offset, so DST transitions in either zone just work.
function tzWallToUtcMs(tz, y, m, d, hour, minute) {
  let guess = Date.UTC(y, m - 1, d, hour, minute);
  for (let i = 0; i < 3; i++) {
    const r = readTz(new Date(guess), tz);
    const got  = Date.UTC(r.y, r.m - 1, r.d, r.h, r.mi);
    const want = Date.UTC(y, m - 1, d, hour, minute);
    const diff = want - got;
    if (diff === 0) return guess;
    guess += diff;
  }
  return guess;
}

function msUntilNextInTz(tz, hour, minute) {
  const now = Date.now();
  for (let off = 0; off < 3; off++) {
    const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
      .format(new Date(now + off * 86400000));
    const [y, m, d] = dateStr.split('-').map(Number);
    const target = tzWallToUtcMs(tz, y, m, d, hour, minute);
    if (target > now) return target - now;
  }
  return 24 * 3600 * 1000;
}

// Minutes elapsed since the most recent local open in `tz`. Returns a negative
// number before the open, and a number > session length after the close. Used
// to gate prompt-injection to the first N minutes after the open.
function minutesSinceOpenInTz(tz, openH, openM) {
  const r = readTz(new Date(), tz);
  return (r.h - openH) * 60 + (r.mi - openM);
}

// ---- Prompt builder (market-specific) -------------------------------------

function buildPrompt(market, watchlist) {
  const cfg = SESSIONS[market];
  const symbols = watchlist.join(', ');
  const isAsx = market === 'ASX';
  const overnightLine = isAsx
    ? 'Pay particular attention to the OVERNIGHT US close (S&P 500, Nasdaq, Russell 2000) and how it should bias the ASX open — risk-on tech rallies tend to lift Aussie tech (XIJ); commodity selloffs hit Materials/XMJ and Energy/XEJ; bank-sector moves in the US transmit to XFJ.'
    : '';
  const symbolKey = isAsx ? 'ASX-listed ticker (no .AX suffix)' : 'US ticker';
  const priceUnitsLine = isAsx
    ? `Numbers in keyLevels should be plausible AUD price levels (no currency symbol in the JSON), or null if unknown.`
    : `Numbers in keyLevels should be plausible USD price levels in the same units as the stock's recent close, or null if unknown.`;
  return `You are a pre-market research analyst for an autonomous trading desk operating on the ${isAsx ? 'Australian Securities Exchange (ASX)' : 'U.S. equity markets'}. ${cfg.sessionLabel}. Produce a structured morning briefing for the ${isAsx ? 'ASX ' : ''}watchlist: ${symbols}.

Use the LATEST overnight + this-morning information you can find: earnings releases, guidance, analyst upgrades/downgrades and price-target changes, M&A or regulatory headlines, ${cfg.indices}, sector indices (${cfg.sectors}), economic data on the calendar today (${cfg.macroNotes}), and any unusual options or block-trade activity flagged by reputable sources. ${overnightLine}

Be concise, calibrated, and explicit when something is uncertain. All prices in ${cfg.currencyCode}.

Respond with ONLY valid JSON (no markdown, no prose):
{
  "headline": "<one sentence — overall market thesis for the ${isAsx ? 'ASX ' : ''}open>",
  "marketBias": "bullish|bearish|neutral|mixed",
  "indexFutures": ${isAsx
    ? '{"SPI200":"<+/-x.xx%>", "AORD":"<+/-x.xx%>", "AUDUSD":"<level or change>", "US_overnight":"<S&P close +/-x.xx%>"}'
    : '{"ES":"<+/-x.xx%>", "NQ":"<+/-x.xx%>", "RTY":"<+/-x.xx%>", "VIX":"<level or change>"}'},
  "macroEvents": ["<event 1 — short, with time if known${isAsx ? ' (Sydney time)' : ' (ET)'}>", "<event 2>"],
  "sectorPulse": [
    {"sector":"<e.g. ${isAsx ? 'Materials/XMJ' : 'Tech/XLK'}>", "stance":"strong|neutral|weak", "note":"<why, short>"}
  ],
  "topSetups": [
    {
      "symbol":"<${symbolKey} from watchlist>",
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
  "warnings": ["<broad warning the agent should respect today, e.g. '${isAsx ? 'RBA at 14:30 Sydney — expect AUD volatility' : 'FOMC at 14:00 ET — expect volatility'}'>"]${isAsx ? `,
  "overnightUsImpact": "<one short sentence on how the prior US close should bias today's ASX open>"` : ''}
}

Aim for 4–8 entries in topSetups (best risk-reward only). perSymbol must include EVERY watchlist symbol (${watchlist.length} entries). ${priceUnitsLine} If a section has nothing material, return an empty array.`;
}

// ---- Sanitizer (shared across markets) ------------------------------------

function clamp(v, lo, hi) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return +Math.max(lo, Math.min(hi, n)).toFixed(2);
}

function sanitize(obj, watchlist, market) {
  if (!obj || typeof obj !== 'object') return null;
  const arr = (x) => Array.isArray(x) ? x : [];
  const str = (s, max = 240) => String(s || '').slice(0, max);
  const wlSet = new Set(watchlist.map(s => s.toUpperCase()));

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
  })).filter(s => wlSet.has(s.symbol));

  const cleanPerSymbol = arr(obj.perSymbol).map(s => ({
    symbol: str(s.symbol, 8).toUpperCase(),
    newsScore: clamp(s.newsScore, -1, 1) ?? 0,
    summary: str(s.summary, 200),
    earningsToday: !!s.earningsToday,
  })).filter(s => wlSet.has(s.symbol));

  const out = {
    headline: str(obj.headline, 240),
    marketBias: ['bullish', 'bearish', 'neutral', 'mixed'].includes(String(obj.marketBias).toLowerCase())
      ? String(obj.marketBias).toLowerCase() : 'mixed',
    indexFutures: typeof obj.indexFutures === 'object' && obj.indexFutures ? obj.indexFutures : {},
    macroEvents: arr(obj.macroEvents).slice(0, 8).map(e => str(e, 160)),
    sectorPulse: arr(obj.sectorPulse).slice(0, 12).map(s => ({
      sector: str(s.sector, 40),
      stance: ['strong', 'neutral', 'weak'].includes(String(s.stance).toLowerCase()) ? String(s.stance).toLowerCase() : 'neutral',
      note: str(s.note, 160),
    })),
    topSetups: cleanSetups,
    perSymbol: cleanPerSymbol,
    warnings: arr(obj.warnings).slice(0, 5).map(w => str(w, 200)),
  };
  // ASX-only field — preserved verbatim if present, omitted otherwise.
  if (market === 'ASX' && obj.overnightUsImpact) {
    out.overnightUsImpact = str(obj.overnightUsImpact, 240);
  }
  return out;
}

// ---- Grok call ------------------------------------------------------------

async function fetchFreshBriefing(market, watchlist) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return { ok: false, reason: 'XAI_API_KEY not configured' };
  try {
    const res = await axios.post(
      XAI_URL,
      {
        model: MODEL,
        messages: [{ role: 'user', content: buildPrompt(market, watchlist) }],
        max_tokens: 3500,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS }
    );
    costTracker.recordUsage({ service: 'premarket', market: market || 'SHARED', modelId: MODEL, response: res.data });
    const text = res.data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    const clean = sanitize(parsed, watchlist, market);
    if (!clean) return { ok: false, reason: 'Malformed Grok response' };
    return { ok: true, ...clean };
  } catch (e) {
    return { ok: false, reason: e.response?.data?.error?.message || e.message };
  }
}

// ---- Run / read -----------------------------------------------------------

async function runDailyBriefing(market, watchlist) {
  if (!isMarket(market)) return { ok: false, reason: `Unknown market ${market}` };
  if (!Array.isArray(watchlist) || !watchlist.length) {
    return { ok: false, reason: `${market} watchlist is empty` };
  }
  const s = state[market];
  if (s.inflight) return { ok: false, reason: 'Already running' };
  s.inflight = true;
  try {
    console.log(`[Premarket:${market}] Generating briefing for ${watchlist.length} symbols...`);
    const briefing = await fetchFreshBriefing(market, watchlist);
    if (!briefing.ok) {
      console.error(`[Premarket:${market}] Failed:`, briefing.reason);
      await db.recordAudit({
        event_type: 'PREMARKET_BRIEFING_FAILED',
        payload: { market, reason: briefing.reason },
      });
      return briefing;
    }
    const cfg = SESSIONS[market];
    const date = todayInTz(cfg.tz);
    const payload = { ...briefing, market, generatedAt: new Date().toISOString(), watchlist };
    await db.query(
      `INSERT INTO premarket_briefings (date, market, payload) VALUES ($1, $2, $3)
       ON CONFLICT (date, market) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()`,
      [date, market, JSON.stringify(payload)]
    );
    await db.recordAudit({
      event_type: 'PREMARKET_BRIEFING',
      payload: {
        market, date, headline: briefing.headline, marketBias: briefing.marketBias,
        topSetupsCount: briefing.topSetups.length, warnings: briefing.warnings,
      },
    });
    bus.emit('premarket', { market, ...payload });
    s.cache = { date, briefing: { date, ...payload } };
    console.log(`[Premarket:${market}] Stored for ${date} — ${briefing.topSetups.length} top setups, bias=${briefing.marketBias}`);
    return { ok: true, ...payload };
  } finally {
    s.inflight = false;
  }
}

async function getLatestBriefing(market = 'US') {
  if (!isMarket(market)) return null;
  const { rows } = await db.query(
    `SELECT date, payload, created_at FROM premarket_briefings
     WHERE market = $1 ORDER BY date DESC LIMIT 1`,
    [market]
  );
  if (!rows[0]) return null;
  return { date: rows[0].date, market, createdAt: rows[0].created_at, ...rows[0].payload };
}

async function getLatestBriefingCached(market) {
  if (!isMarket(market)) return null;
  const cfg = SESSIONS[market];
  const today = todayInTz(cfg.tz);
  const s = state[market];
  if (s.cache.date === today && s.cache.briefing) return s.cache.briefing;
  const fresh = await getLatestBriefing(market);
  s.cache = { date: today, briefing: fresh };
  return fresh;
}

// Returns a compact prompt-injection block IF we have today's briefing for the
// symbol's market AND we're inside the active window (US: first 60min after
// 09:30 ET, ASX: first 90min after 10:00 Sydney). Otherwise returns null and
// the LLM prompt is unchanged. Must never throw.
async function getActiveBriefingContext(symbol) {
  try {
    const info = marketRegistry.getSymbolInfo(symbol);
    const market = info.market;
    if (!isMarket(market)) return null;
    const cfg = SESSIONS[market];

    const briefing = await getLatestBriefingCached(market);
    if (!briefing || briefing.date !== todayInTz(cfg.tz)) return null;

    const minIn = minutesSinceOpenInTz(cfg.tz, cfg.openH, cfg.openM);
    if (minIn < 0 || minIn >= cfg.activeMinutes) return null;

    const sym = String(symbol).toUpperCase();
    const setup = briefing.topSetups?.find(s => s.symbol === sym);
    const per = briefing.perSymbol?.find(s => s.symbol === sym);
    if (!setup && !per && !briefing.warnings?.length && !briefing.overnightUsImpact) return null;

    const csym = cfg.currencySymbol;
    const lines = [`Pre-market briefing (${market} · ${briefing.date} — ${minIn}min into ${cfg.timezoneShort} session, bias: ${briefing.marketBias}):`];
    if (briefing.headline) lines.push(`  Thesis: ${briefing.headline}`);
    if (market === 'ASX' && briefing.overnightUsImpact) {
      lines.push(`  Overnight US impact: ${briefing.overnightUsImpact}`);
    }
    if (per) {
      const earn = per.earningsToday ? ' [EARNINGS TODAY]' : '';
      lines.push(`  ${sym} pre-market take${earn}: news=${per.newsScore >= 0 ? '+' : ''}${per.newsScore} — ${per.summary}`);
    }
    if (setup) {
      const lvl = setup.keyLevels || {};
      const lvlBits = [];
      if (lvl.trigger != null) lvlBits.push(`trigger ${csym}${lvl.trigger}`);
      if (lvl.support != null) lvlBits.push(`support ${csym}${lvl.support}`);
      if (lvl.resistance != null) lvlBits.push(`resistance ${csym}${lvl.resistance}`);
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

// ---- Schedulers -----------------------------------------------------------

function scheduleMarket(market, getWatchlistForMarket) {
  if (!isMarket(market)) return;
  const cfg = SESSIONS[market];
  const s = state[market];
  if (s.handle) clearTimeout(s.handle);
  const ms = msUntilNextInTz(cfg.tz, cfg.briefH, cfg.briefM);
  console.log(`[Premarket:${market}] Next briefing scheduled in ${(ms / 3600000).toFixed(2)}h (${String(cfg.briefH).padStart(2,'0')}:${String(cfg.briefM).padStart(2,'0')} ${cfg.timezoneShort})`);
  s.handle = setTimeout(async () => {
    try {
      const wl = getWatchlistForMarket();
      if (Array.isArray(wl) && wl.length) await runDailyBriefing(market, wl);
      else console.log(`[Premarket:${market}] Skipped — empty watchlist at scheduled time`);
    } catch (e) {
      console.error(`[Premarket:${market}] scheduled run error:`, e.message);
    }
    scheduleMarket(market, getWatchlistForMarket);
  }, ms);
}

// Backwards-compatible: `schedule(getUsWatchlist)` keeps the old US schedule;
// `scheduleAll({us, asx})` schedules both.
function schedule(getUsWatchlist) {
  scheduleMarket('US', getUsWatchlist);
}

function scheduleAll({ us, asx }) {
  if (us) scheduleMarket('US', us);
  // ASX scheduling is hard-gated by the master kill-switch (ASX_ENABLED env).
  // When disabled we never call scheduleMarket('ASX', …) — no setTimeout
  // armed, no daily "Next briefing scheduled" log noise, no risk of a stale
  // schedule firing if someone toggles the watchlist by hand.
  if (asx) {
    const { isAsxEnabled } = require('./marketRegistry');
    if (isAsxEnabled()) scheduleMarket('ASX', asx);
    else console.log('[Premarket:ASX] Skipped scheduling — ASX_ENABLED=false');
  }
}

async function bootstrapMarketIfMissing(market, getWatchlistForMarket) {
  if (!isMarket(market)) return;
  try {
    const cfg = SESSIONS[market];
    const latest = await getLatestBriefing(market);
    if (latest && latest.date === todayInTz(cfg.tz)) {
      console.log(`[Premarket:${market}] Today's briefing already on file (${latest.date})`);
      return;
    }
    const wl = getWatchlistForMarket();
    if (!Array.isArray(wl) || !wl.length) {
      console.log(`[Premarket:${market}] Bootstrap skipped — empty watchlist`);
      return;
    }
    runDailyBriefing(market, wl).catch(e => console.error(`[Premarket:${market}] bootstrap error:`, e.message));
  } catch (e) {
    console.error(`[Premarket:${market}] bootstrap check failed:`, e.message);
  }
}

function bootstrapIfMissing(getUsWatchlist) {
  return bootstrapMarketIfMissing('US', getUsWatchlist);
}

function bootstrapAll({ us, asx }) {
  if (us) bootstrapMarketIfMissing('US', us);
  // Same hard gate as scheduleAll — no boot-time Grok call for an ASX
  // briefing the dashboard wouldn't show anyway.
  if (asx) {
    const { isAsxEnabled } = require('./marketRegistry');
    if (isAsxEnabled()) bootstrapMarketIfMissing('ASX', asx);
  }
}

module.exports = {
  ensureSchema,
  runDailyBriefing,
  getLatestBriefing,
  getActiveBriefingContext,
  schedule,           // legacy single-market US scheduler
  scheduleAll,        // schedule both markets
  bootstrapIfMissing, // legacy single-market US bootstrap
  bootstrapAll,
  SESSIONS,
};
