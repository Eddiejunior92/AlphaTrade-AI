// Grok-powered news sentiment for watchlist symbols.
// Cached per-symbol with TTL to keep token spend modest and latency low.
const axios = require('axios');

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = process.env.GROK_SENTIMENT_MODEL || 'grok-4-fast-non-reasoning';
const TTL_MS = parseInt(process.env.SENTIMENT_TTL_SECONDS || '600') * 1000; // 10 min default — keep tighter so each vote sees recent news + social
const TIMEOUT_MS = 12000;
const MAX_CACHE = parseInt(process.env.SENTIMENT_CACHE_MAX || '64'); // hard cap entries

// LRU cache (symbol → { ts, data }) — Map iteration order = insertion order, so
// touching = delete+re-set keeps recently-used items at the tail; evict from head.
const cache = new Map();
// In-flight promise dedupe: if a fetch is already underway for symbol, reuse it.
const inflight = new Map(); // symbol → Promise<data>
let batchLock = false;

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
    score: 0,            // -1 .. +1
    label: 'neutral',
    summary: reason || 'No recent news available.',
    insights: [],
    sources: [],
    cached: false,
    fetchedAt: new Date().toISOString(),
    stale: true,
  };
}

function classify(score) {
  if (score >= 0.4) return 'bullish';
  if (score >= 0.15) return 'mildly bullish';
  if (score <= -0.4) return 'bearish';
  if (score <= -0.15) return 'mildly bearish';
  return 'neutral';
}

function clamp(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return +Math.max(-1, Math.min(1, n)).toFixed(2);
}

function sanitize(obj, symbol) {
  if (!obj || typeof obj !== 'object') return defaultPayload(symbol, 'Malformed response');
  // Combined score (back-compat). New: separate news_score + social_score.
  const newsScore   = clamp(obj.news_score);
  const socialScore = clamp(obj.social_score);
  let score = clamp(obj.score);
  if (score == null) {
    if (newsScore != null && socialScore != null) score = +((newsScore * 0.6 + socialScore * 0.4)).toFixed(2);
    else score = newsScore != null ? newsScore : (socialScore != null ? socialScore : 0);
  }
  const insights = Array.isArray(obj.insights) ? obj.insights.slice(0, 3).map(s => String(s).slice(0, 160)) : [];
  const sources = Array.isArray(obj.sources) ? obj.sources.slice(0, 3).map(s => String(s).slice(0, 80)) : [];
  const social_summary = String(obj.social_summary || '').slice(0, 200);
  return {
    symbol,
    score,
    label: classify(score),
    news_score: newsScore,
    social_score: socialScore,
    summary: String(obj.summary || '').slice(0, 280),
    social_summary,
    insights,
    sources,
    cached: false,
    fetchedAt: new Date().toISOString(),
    stale: false,
  };
}

function buildPrompt(symbol) {
  return `You are a real-time sentiment analyst for an automated trading system. Analyze the LATEST (last 6-24h) signals for ticker ${symbol} across TWO independent channels:
  1) NEWS — wires, earnings, guidance, analyst actions, regulatory, macro headlines that mention ${symbol}.
  2) SOCIAL — X/Twitter cashtag $${symbol}, retail-investor forums, prominent finance accounts. Look for unusual chatter volume, options unusual-activity rumors, hype, or piling-on negativity.

Score each channel independently. Be calibrated: routine days are 0 to ±0.2; reserve ±0.5+ for clearly material catalysts.

Respond with ONLY valid JSON (no markdown, no prose):
{
  "news_score": <-1 to +1>,
  "social_score": <-1 to +1>,
  "score": <-1 to +1, your blended view weighting news a bit heavier>,
  "summary": "<one short sentence — the dominant news narrative>",
  "social_summary": "<one short sentence — the dominant social narrative, or 'no notable chatter'>",
  "insights": ["<key insight 1 — short>", "<key insight 2>", "<key insight 3>"],
  "sources": ["<source 1>", "<source 2>"]
}

If you genuinely have no real recent information, return all scores at 0 with summary "no notable recent news".`;
}

async function fetchFresh(symbol) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return defaultPayload(symbol, 'XAI_API_KEY not configured');
  try {
    const res = await axios.post(
      XAI_URL,
      {
        model: MODEL,
        messages: [{ role: 'user', content: buildPrompt(symbol) }],
        max_tokens: 400,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS }
    );
    const text = res.data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      // Strip code-fence/markdown if Grok ignored response_format hint.
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    return sanitize(parsed, symbol);
  } catch (e) {
    console.error(`[Sentiment:${symbol}]`, e.response?.data?.error?.message || e.message);
    return defaultPayload(symbol, `Fetch failed: ${e.message}`);
  }
}

async function getSentiment(symbol, { force = false } = {}) {
  const sym = String(symbol).toUpperCase();
  const cached = cache.get(sym);
  if (!force && cached && Date.now() - cached.ts < TTL_MS) {
    // Touch for LRU recency.
    touchCache(sym, cached);
    return { ...cached.data, cached: true };
  }
  // In-flight dedupe: if another caller is already fetching this symbol,
  // await their promise instead of issuing a duplicate Grok request.
  if (inflight.has(sym)) return inflight.get(sym);

  const p = (async () => {
    try {
      const data = await fetchFresh(sym);
      touchCache(sym, { ts: Date.now(), data });
      return data;
    } finally {
      inflight.delete(sym);
    }
  })();
  inflight.set(sym, p);
  return p;
}

// Pre-fetch many symbols in parallel with bounded concurrency (avoid Grok
// rate-limit). Guarded by a global lock so a slow batch never overlaps with
// the next cycle's batch — at most one refresh runs at a time.
async function getSentimentBatch(symbols, { concurrency = 4 } = {}) {
  if (batchLock) return {};
  batchLock = true;
  try {
    const out = {};
    const queue = [...symbols];
    async function worker() {
      while (queue.length) {
        const s = queue.shift();
        try { out[s] = await getSentiment(s); }
        catch (e) { out[s] = defaultPayload(s, `Batch error: ${e.message}`); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
    return out;
  } finally {
    batchLock = false;
  }
}

function getCached(symbol) {
  const c = cache.get(String(symbol).toUpperCase());
  return c ? { ...c.data, cached: true, ageMs: Date.now() - c.ts } : null;
}

function getAllCached() {
  const out = {};
  for (const [sym, { ts, data }] of cache.entries()) {
    out[sym] = { ...data, cached: true, ageMs: Date.now() - ts };
  }
  return out;
}

function clearCache() { cache.clear(); }

module.exports = { getSentiment, getSentimentBatch, getCached, getAllCached, clearCache, classify };
