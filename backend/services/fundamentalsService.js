// Grok-powered fundamentals + sector + macro context for swing analysis.
// Cached per symbol with a long TTL (6h) since fundamentals don't change
// intra-day. Used ONLY by the longer-hold (swing) strategy — the day
// strategy never calls into here.
const axios = require('axios');

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = process.env.GROK_FUNDAMENTALS_MODEL || 'grok-4-fast-non-reasoning';
const TTL_MS = parseInt(process.env.FUNDAMENTALS_TTL_SECONDS || '21600') * 1000; // 6h
const TIMEOUT_MS = 15000;
const MAX_CACHE = parseInt(process.env.FUNDAMENTALS_CACHE_MAX || '64');

const cache = new Map();   // symbol → { ts, data }
const inflight = new Map(); // symbol → Promise

function touchCache(sym, entry) {
  if (cache.has(sym)) cache.delete(sym);
  cache.set(sym, entry);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function defaultPayload(symbol, reason) {
  return {
    symbol,
    sector: null,
    pe_ratio: null,
    eps_growth_yoy_pct: null,
    revenue_growth_yoy_pct: null,
    earnings_next_date: null,
    earnings_recent_surprise_pct: null,
    valuation_label: 'unknown',          // cheap | fair | rich | unknown
    sector_strength_30d_pct: null,
    sector_strength_label: 'unknown',     // strong | weak | flat | unknown
    macro_context: reason || 'Fundamentals temporarily unavailable.',
    cached: false,
    fetchedAt: new Date().toISOString(),
    stale: true,
  };
}

function sanitize(obj, symbol) {
  if (!obj || typeof obj !== 'object') return defaultPayload(symbol, 'Malformed response');
  const numOrNull = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? +n.toFixed(2) : null;
  };
  const labelOrUnknown = (v, allowed) => {
    const s = String(v || '').toLowerCase();
    return allowed.includes(s) ? s : 'unknown';
  };
  return {
    symbol,
    sector: obj.sector ? String(obj.sector).slice(0, 80) : null,
    pe_ratio: numOrNull(obj.pe_ratio),
    eps_growth_yoy_pct: numOrNull(obj.eps_growth_yoy_pct),
    revenue_growth_yoy_pct: numOrNull(obj.revenue_growth_yoy_pct),
    earnings_next_date: obj.earnings_next_date ? String(obj.earnings_next_date).slice(0, 24) : null,
    earnings_recent_surprise_pct: numOrNull(obj.earnings_recent_surprise_pct),
    valuation_label: labelOrUnknown(obj.valuation_label, ['cheap', 'fair', 'rich', 'unknown']),
    sector_strength_30d_pct: numOrNull(obj.sector_strength_30d_pct),
    sector_strength_label: labelOrUnknown(obj.sector_strength_label, ['strong', 'weak', 'flat', 'unknown']),
    macro_context: obj.macro_context ? String(obj.macro_context).slice(0, 320) : '',
    cached: false,
    fetchedAt: new Date().toISOString(),
    stale: false,
  };
}

const PROMPT = (symbol) => `You are a financial-research assistant. Return ONLY a single JSON object (no markdown, no prose) summarizing the most recent fundamental + sector + macro context for ${symbol} useful to a swing trader. Use your best knowledge as of today; if a value is unknown say null.

Required schema:
{
  "sector": "<GICS sector name, e.g. Information Technology>",
  "pe_ratio": <number trailing P/E or null>,
  "eps_growth_yoy_pct": <number, latest reported quarter YoY EPS growth %, or null>,
  "revenue_growth_yoy_pct": <number, latest reported quarter YoY revenue growth %, or null>,
  "earnings_next_date": "<YYYY-MM-DD or null if unknown>",
  "earnings_recent_surprise_pct": <number, last EPS beat/miss vs estimate %, or null>,
  "valuation_label": "cheap" | "fair" | "rich" | "unknown",
  "sector_strength_30d_pct": <number, the symbol's sector ETF % move over the last 30 trading days, or null>,
  "sector_strength_label": "strong" | "weak" | "flat" | "unknown",
  "macro_context": "<one or two sentences on rates / inflation / risk-on or risk-off backdrop relevant to this name>"
}`;

async function fetchFromGrok(symbol) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return defaultPayload(symbol, 'XAI_API_KEY not configured');
  try {
    const res = await axios.post(
      XAI_URL,
      {
        model: MODEL,
        messages: [{ role: 'user', content: PROMPT(symbol) }],
        max_tokens: 500,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS },
    );
    const text = res.data?.choices?.[0]?.message?.content || '';
    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch { /* try to extract a JSON object */ const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
    return sanitize(parsed, symbol);
  } catch (e) {
    console.error(`[Fundamentals:${symbol}] error:`, e.response?.data?.error?.message || e.message);
    return defaultPayload(symbol, 'Fetch failed');
  }
}

async function getFundamentals(symbol, { force = false } = {}) {
  const sym = String(symbol).toUpperCase();
  const cached = cache.get(sym);
  if (!force && cached && Date.now() - cached.ts < TTL_MS) {
    return { ...cached.data, cached: true };
  }
  if (inflight.has(sym)) return inflight.get(sym);
  const p = (async () => {
    try {
      const data = await fetchFromGrok(sym);
      touchCache(sym, { ts: Date.now(), data });
      return data;
    } finally { inflight.delete(sym); }
  })();
  inflight.set(sym, p);
  return p;
}

let batchLock = false;
async function getFundamentalsBatch(symbols, { concurrency = 3 } = {}) {
  if (batchLock) return {};
  batchLock = true;
  try {
    const out = {};
    const queue = [...symbols];
    async function worker() {
      while (queue.length) {
        const s = queue.shift();
        try { out[s] = await getFundamentals(s); }
        catch (e) { out[s] = defaultPayload(s, `Batch error: ${e.message}`); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
    return out;
  } finally { batchLock = false; }
}

function getCached(symbol) {
  const entry = cache.get(String(symbol).toUpperCase());
  if (!entry) return null;
  return { ...entry.data, cached: true, ageMs: Date.now() - entry.ts };
}

// Snapshot of the entire in-memory fundamentals cache. Used by /api/companies
// to render the Companies tab without forcing any upstream API calls.
function getCachedAll() {
  const out = {};
  for (const [sym, entry] of cache.entries()) {
    out[sym] = { ...entry.data, cached: true, ageMs: Date.now() - entry.ts };
  }
  return out;
}

module.exports = { getFundamentals, getFundamentalsBatch, getCached, getCachedAll };
