// Options unusual-activity scanner — uses Grok (already paid for) to surface
// reports of unusual options flow on watchlist symbols. TTL-cached per symbol.
// Strictly informational; rendered as one extra prompt line.
const axios = require('axios');
const costTracker = require('./llmCostTracker');
const marketRegistry = require('./marketRegistry');

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = process.env.GROK_OPTIONS_MODEL || 'grok-4-fast-non-reasoning';
// 60 min default (was 30) — Grok narrative on unusual options flow doesn't
// change minute-to-minute; longer TTL halves Grok cost on this channel.
const TTL_MS = parseInt(process.env.OPTIONS_ACTIVITY_TTL_MIN || '60') * 60 * 1000;
const TIMEOUT_MS = 12000;

const cache = new Map();    // symbol → { ts, data }
const inflight = new Map();

function defaultPayload(symbol, reason) {
  return { symbol, hasUnusualActivity: false, direction: 'neutral', summary: reason || 'unavailable', stale: true };
}

function sanitize(obj, symbol) {
  if (!obj || typeof obj !== 'object') return defaultPayload(symbol, 'malformed');
  const dir = String(obj.direction || 'neutral').toLowerCase();
  return {
    symbol,
    hasUnusualActivity: !!obj.has_unusual_activity,
    direction: ['bullish', 'bearish', 'neutral', 'mixed'].includes(dir) ? dir : 'neutral',
    summary: String(obj.summary || '').slice(0, 240),
    examples: Array.isArray(obj.examples) ? obj.examples.slice(0, 3).map(s => String(s).slice(0, 160)) : [],
  };
}

async function fetchOne(symbol) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return defaultPayload(symbol, 'no Grok key');
  const prompt = `Search recent (last 24h) options-flow news, unusual-activity reports, and social discussion for ticker ${symbol}.
Return a STRICT JSON object only (no markdown, no prose) with keys:
  "has_unusual_activity": boolean (true ONLY if multiple credible sources or scanners flag unusual call/put volume, large block trades, or notable IV moves in the last 24h),
  "direction": "bullish" | "bearish" | "neutral" | "mixed",
  "summary": 1 short sentence,
  "examples": up to 3 short bullets describing the most notable flow.
If nothing notable found, return has_unusual_activity=false with summary="no notable options activity".`;
  try {
    const res = await axios.post(XAI_URL, {
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 240,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS,
    });
    const market = marketRegistry.getSymbolInfo(symbol)?.market || 'US';
    costTracker.recordUsage({ service: 'options', market, modelId: MODEL, response: res.data });
    const text = res.data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return defaultPayload(symbol, 'parse error'); }
    return sanitize(parsed, symbol);
  } catch (e) {
    return defaultPayload(symbol, `error: ${e.message.slice(0, 80)}`);
  }
}

async function getCached(symbol) {
  const c = cache.get(symbol);
  if (c && Date.now() - c.ts < TTL_MS) return c.data;
  return null;
}

async function refresh(symbol) {
  if (inflight.has(symbol)) return inflight.get(symbol);
  const p = (async () => {
    const data = await fetchOne(symbol);
    cache.set(symbol, { ts: Date.now(), data });
    return data;
  })();
  inflight.set(symbol, p);
  try { return await p; } finally { inflight.delete(symbol); }
}

async function getOrRefresh(symbol) {
  const c = await getCached(symbol);
  if (c) return c;
  return refresh(symbol);
}

async function refreshBatch(symbols) {
  const out = {};
  for (const s of symbols) {
    try { out[s] = await refresh(s); } catch (e) { out[s] = defaultPayload(s, e.message); }
  }
  return out;
}

function renderForPrompt(data) {
  if (!data || !data.hasUnusualActivity) return null;
  return `Options activity (${data.direction}): ${data.summary}` +
    (data.examples?.length ? ` Examples: ${data.examples.join(' | ')}` : '');
}

module.exports = { getOrRefresh, getCached, refresh, refreshBatch, renderForPrompt };
