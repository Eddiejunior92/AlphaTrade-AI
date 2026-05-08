// Multi-AI ensemble news sentiment for watchlist symbols.
//
// For each symbol we fan out to three independent LLMs in parallel:
//   • Grok 4 Fast       (xAI direct)        — real-time news + social channel specialist
//   • Claude 3.7 Sonnet (OpenRouter)        — careful narrative reasoning
//   • GPT-4o            (OpenRouter)        — generalist cross-check
//
// Each model returns a JSON payload (news_score, social_score, score, summary,
// social_summary, insights[], sources[]). We then blend numeric scores
// (mean of all responding providers) and merge text fields into a single
// robust output that downstream consumers see exactly as before — same shape,
// same caching, same TTL — plus an extra `providers` array listing which
// models actually contributed.
const axios = require('axios');
const costTracker = require('./llmCostTracker');
const marketRegistry = require('./marketRegistry');

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// 30 min default (was 15) — sentiment is the #1 LLM cost driver
// ($33/day across markets at 15min TTL). News doesn't move that fast;
// the cycle still gets a fresh pull whenever the cached entry expires.
// Combined with the price-stable extension below, repeated calls during
// quiet markets return cached payloads up to 60 min after fetch.
const TTL_MS = parseInt(process.env.SENTIMENT_TTL_SECONDS || '1800') * 1000;
// Price-stable cache extension: if the symbol's price has moved less than
// PRICE_STABLE_BPS basis points since the cached entry was written, treat
// the entry as fresh up to PRICE_STABLE_TTL_MULT × TTL_MS. Idea: if nothing
// is moving, the news/social view almost certainly hasn't shifted either.
// Caller passes { currentPrice } into getSentiment / getSentimentBatch.
// Default 10 bps (0.1%) and 2× extension — conservative.
const PRICE_STABLE_BPS = parseFloat(process.env.SENTIMENT_PRICE_STABLE_BPS || '10');
const PRICE_STABLE_TTL_MULT = parseFloat(process.env.SENTIMENT_PRICE_STABLE_TTL_MULT || '2');
const TIMEOUT_MS = 15000;
// Cap is sized for the full US (30) + ASX (27) universe with headroom; bumped
// from 64 → 128 when the watchlist expanded so no entry gets evicted under
// normal operation.
const MAX_CACHE = parseInt(process.env.SENTIMENT_CACHE_MAX || '128');
// Minimum providers that must respond with valid JSON for us to publish a
// "fresh" blended payload. With 3 providers, requiring 1 keeps us resilient
// to a single upstream outage but flags single-source results as such.
// Clamped to [1, PROVIDERS.length] at module init so a misconfigured env var
// (e.g. "0", empty, or "abc") can never silently bypass the insufficient-
// provider guard and publish a fake "fresh" payload during a full outage.
const _rawMin = parseInt(process.env.SENTIMENT_MIN_PROVIDERS || '1');

// Three-model ensemble. `id` shows up in the blended payload's `providers`
// array; `provider` selects the HTTP transport (xai vs openrouter).
// NOTE: declared before MIN_PROVIDERS clamp so we can use PROVIDERS.length.
const PROVIDERS = [
  {
    id: 'grok',
    label: 'Grok 4 Fast',
    provider: 'xai',
    model: process.env.GROK_SENTIMENT_MODEL || 'grok-4-fast-non-reasoning',
  },
  {
    id: 'claude',
    label: 'Claude 3.7 Sonnet',
    provider: 'openrouter',
    model: 'anthropic/claude-3.7-sonnet',
  },
  {
    id: 'gpt4o',
    label: 'GPT-4o',
    provider: 'openrouter',
    model: 'openai/gpt-4o',
  },
];

// Clamp into [1, PROVIDERS.length]. NaN / 0 / negative all collapse to 1 so
// the insufficient-provider guard in blendProviderResults() can never be
// silently bypassed by a misconfigured env var.
const MIN_PROVIDERS = Number.isFinite(_rawMin)
  ? Math.max(1, Math.min(PROVIDERS.length, _rawMin))
  : 1;

// LRU cache (symbol → { ts, data }) — Map iteration order = insertion order, so
// touching = delete+re-set keeps recently-used items at the tail; evict from head.
const cache = new Map();
// In-flight promise dedupe: if a fetch is already underway for symbol, reuse it.
const inflight = new Map(); // symbol → Promise<data>
// Shared in-flight batch promise. When multiple callers (agent cycle, server
// boot/interval refresh, /api/markets lazy backfill) ask for a batch at the
// same time, the second caller awaits the first instead of getting an empty
// result back. The promise resolves to the merged result map.
let batchInflight = null;

function touchCache(sym, entry) {
  if (cache.has(sym)) cache.delete(sym);
  cache.set(sym, entry);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  // Strong-news event trigger for the long-term knowledge graph. When the
  // blended sentiment score is decisively bullish or bearish, mark the
  // symbol stale so the KG picks it up on the next refresh pass instead of
  // waiting up to 22h. Lazy-required to avoid a circular import at boot.
  try {
    const score = Number(entry?.data?.score);
    if (Number.isFinite(score) && Math.abs(score) >= 0.5) {
      const kg = require('./knowledgeGraphService');
      kg.markStale(sym, `sentiment ${score >= 0 ? '+' : ''}${score.toFixed(2)}`).catch(() => {});
    }
  } catch (_) { /* swallow — never break sentiment writes */ }
}

function defaultPayload(symbol, reason) {
  return {
    symbol,
    score: 0,
    label: 'neutral',
    news_score: 0,
    social_score: 0,
    summary: reason || 'No recent news available.',
    social_summary: '',
    insights: [],
    sources: [],
    providers: [],
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

// Per-provider response → normalised, score-only object. We delay text
// merging until blendProviderResults() so we keep each provider's full text.
function parseProviderJson(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const newsScore = clamp(obj.news_score);
  const socialScore = clamp(obj.social_score);
  let score = clamp(obj.score);
  if (score == null) {
    if (newsScore != null && socialScore != null) {
      score = +((newsScore * 0.6 + socialScore * 0.4)).toFixed(2);
    } else {
      score = newsScore != null ? newsScore : (socialScore != null ? socialScore : 0);
    }
  }
  return {
    news_score: newsScore,
    social_score: socialScore,
    score,
    summary: String(obj.summary || '').slice(0, 280),
    social_summary: String(obj.social_summary || '').slice(0, 200),
    insights: Array.isArray(obj.insights) ? obj.insights.slice(0, 3).map(s => String(s).slice(0, 160)) : [],
    sources: Array.isArray(obj.sources) ? obj.sources.slice(0, 3).map(s => String(s).slice(0, 80)) : [],
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

// Robust JSON extraction — prefer response_format JSON, fall back to regex if
// a provider returned markdown-wrapped output.
function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function callXai(provider, prompt, market) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return { id: provider.id, ok: false, reason: 'XAI_API_KEY missing' };
  try {
    const res = await axios.post(
      XAI_URL,
      {
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS }
    );
    costTracker.recordUsage({ service: 'sentiment', market: market || 'SHARED', modelId: provider.model, response: res.data });
    const text = res.data?.choices?.[0]?.message?.content || '';
    const parsed = parseProviderJson(extractJson(text));
    if (!parsed) return { id: provider.id, ok: false, reason: 'malformed JSON' };
    return { id: provider.id, label: provider.label, ok: true, ...parsed };
  } catch (e) {
    return { id: provider.id, ok: false, reason: e.response?.data?.error?.message || e.message };
  }
}

async function callOpenRouter(provider, prompt, market) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { id: provider.id, ok: false, reason: 'OPENROUTER_API_KEY missing' };
  try {
    const res = await axios.post(
      OPENROUTER_URL,
      {
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://alphatrade.replit.app',
          'X-Title': 'AlphaTrade AI',
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_MS,
      }
    );
    costTracker.recordUsage({ service: 'sentiment', market: market || 'SHARED', modelId: provider.model, response: res.data });
    const text = res.data?.choices?.[0]?.message?.content || '';
    const parsed = parseProviderJson(extractJson(text));
    if (!parsed) return { id: provider.id, ok: false, reason: 'malformed JSON' };
    return { id: provider.id, label: provider.label, ok: true, ...parsed };
  } catch (e) {
    return { id: provider.id, ok: false, reason: e.response?.data?.error?.message || e.message };
  }
}

function callProvider(provider, prompt, market) {
  if (provider.provider === 'xai') return callXai(provider, prompt, market);
  if (provider.provider === 'openrouter') return callOpenRouter(provider, prompt, market);
  return Promise.resolve({ id: provider.id, ok: false, reason: 'unknown provider' });
}

// Mean of defined values (skip nulls). Returns null if no values supplied.
function mean(values) {
  const ns = values.filter(v => Number.isFinite(v));
  if (!ns.length) return null;
  return +(ns.reduce((a, b) => a + b, 0) / ns.length).toFixed(2);
}

// Pick the longest non-empty string — keeps the most informative summary
// rather than averaging text. Trims at 280 chars.
function bestText(strings, max = 280) {
  const candidates = strings.filter(s => s && s.trim() && !/^no\s+(notable|recent)/i.test(s.trim()));
  if (!candidates.length) {
    const any = strings.find(s => s && s.trim());
    return any ? any.slice(0, max) : '';
  }
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0].slice(0, max);
}

// Dedupe an array of short strings (case-insensitive), preserve insertion order.
function dedupe(strings, max) {
  const seen = new Set();
  const out = [];
  for (const s of strings) {
    if (!s) continue;
    const k = s.toLowerCase().trim();
    if (k && !seen.has(k)) { seen.add(k); out.push(s); }
    if (out.length >= max) break;
  }
  return out;
}

// Combine the per-provider parsed results into one blended payload.
// Numeric scores: arithmetic mean across responding providers.
// Text:           pick the longest non-trivial summary/social_summary.
// Lists:          concat + dedupe (insights up to 3, sources up to 5).
function blendProviderResults(symbol, providerResults) {
  const ok = providerResults.filter(r => r.ok);
  if (ok.length < MIN_PROVIDERS) {
    const reasons = providerResults.map(r => `${r.id}:${r.reason || 'no data'}`).join(', ');
    // Degraded payload still carries provider-count metadata so the UI /
    // telemetry can distinguish "all 3 providers down" from "no data yet".
    return {
      ...defaultPayload(symbol, `Ensemble unavailable (${reasons})`),
      providers: [],
      providersValid: 0,
      providersTotal: PROVIDERS.length,
    };
  }

  const blendedNews   = mean(ok.map(r => r.news_score));
  const blendedSocial = mean(ok.map(r => r.social_score));
  let blendedScore    = mean(ok.map(r => r.score));
  if (blendedScore == null) {
    if (blendedNews != null && blendedSocial != null) {
      blendedScore = +((blendedNews * 0.6 + blendedSocial * 0.4)).toFixed(2);
    } else {
      blendedScore = blendedNews != null ? blendedNews : (blendedSocial != null ? blendedSocial : 0);
    }
  }

  const summary        = bestText(ok.map(r => r.summary));
  const social_summary = bestText(ok.map(r => r.social_summary), 200);
  const insights       = dedupe(ok.flatMap(r => r.insights || []), 3);
  const sources        = dedupe(ok.flatMap(r => r.sources || []), 5);

  return {
    symbol,
    score: blendedScore,
    label: classify(blendedScore),
    news_score: blendedNews,
    social_score: blendedSocial,
    summary: summary || 'no notable recent news',
    social_summary,
    insights,
    sources,
    // Per-model breakdown so the UI / debugging can show which providers
    // contributed and what each one independently said.
    providers: ok.map(r => ({
      id: r.id,
      label: r.label,
      score: r.score,
      news_score: r.news_score,
      social_score: r.social_score,
      summary: r.summary,
    })),
    providersValid: ok.length,
    providersTotal: PROVIDERS.length,
    cached: false,
    fetchedAt: new Date().toISOString(),
    stale: false,
  };
}

// Per-symbol per-UTC-day hard cap on LLM sentiment fetches. Ensures we
// never spend more than (PROVIDERS.length × MAX_DAILY_CALLS_PER_SYMBOL)
// LLM calls on any single symbol's sentiment in a 24-hour window. The
// TTL+price-stable cache covers the in-day cadence; this is the safety
// net against unexpected high-frequency calls (e.g. a buggy refresher
// loop or a watchlist that suddenly grew). Falls open on DB error so
// sentiment can never be wedged by an infrastructure hiccup.
const MAX_DAILY_CALLS_PER_SYMBOL = parseInt(process.env.SENTIMENT_MAX_DAILY_CALLS_PER_SYMBOL || '1');
let _db = null;
function _getDb() { if (_db === null) { try { _db = require('./db'); } catch (_) { _db = false; } } return _db || null; }
async function _getDailyCallCount(symbol) {
  const db = _getDb(); if (!db) return 0;
  try {
    const r = await db.query(`
      SELECT n_calls FROM sentiment_daily_calls
      WHERE symbol = $1 AND utc_date = CURRENT_DATE
    `, [symbol]);
    return r.rows[0]?.n_calls || 0;
  } catch (_) { return 0; }
}
async function _incrementDailyCallCount(symbol) {
  const db = _getDb(); if (!db) return;
  try {
    await db.query(`
      INSERT INTO sentiment_daily_calls (symbol, utc_date, n_calls, last_at)
      VALUES ($1, CURRENT_DATE, 1, NOW())
      ON CONFLICT (symbol, utc_date) DO UPDATE SET
        n_calls = sentiment_daily_calls.n_calls + 1, last_at = NOW()
    `, [symbol]);
  } catch (_) { /* swallow */ }
}

async function fetchFresh(symbol) {
  // Per-day cap check — if we've already done MAX_DAILY_CALLS_PER_SYMBOL
  // ensemble calls today for this symbol, return whatever's cached (stale
  // OR fresh) instead of issuing another one. Cost-control hard cap.
  const dailyCount = await _getDailyCallCount(symbol);
  if (dailyCount >= MAX_DAILY_CALLS_PER_SYMBOL) {
    const cached = cache.get(symbol);
    if (cached) return { ...cached.data, cached: true, dailyCapHit: true, ageMs: Date.now() - cached.ts };
    // Nothing cached AND cap hit — degrade to neutral default with a tag.
    return { ...defaultPayload(symbol, `Daily LLM cap reached (${dailyCount}/${MAX_DAILY_CALLS_PER_SYMBOL})`), dailyCapHit: true };
  }
  const prompt = buildPrompt(symbol);
  const market = marketRegistry.getSymbolInfo(symbol)?.market || 'US';
  // Fan out to all providers in parallel; allSettled so one slow/failed
  // upstream never drags down the others.
  const settled = await Promise.allSettled(PROVIDERS.map(p => callProvider(p, prompt, market)));
  const results = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { id: PROVIDERS[i].id, ok: false, reason: s.reason?.message || 'rejected' }
  );
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    console.warn(`[Sentiment:${symbol}] ${failed.length}/${PROVIDERS.length} providers failed: ` +
      failed.map(r => `${r.id}=${r.reason}`).join('; '));
  }
  const blended = blendProviderResults(symbol, results);
  // Increment per-day counter only when at least one provider responded
  // — otherwise we shouldn't burn the cap on a no-op outage.
  if (results.some(r => r.ok)) await _incrementDailyCallCount(symbol);
  return blended;
}

async function getSentiment(symbol, { force = false, currentPrice = null } = {}) {
  const sym = String(symbol).toUpperCase();
  const cached = cache.get(sym);
  if (!force && cached) {
    const age = Date.now() - cached.ts;
    // Standard TTL hit — always reuse.
    if (age < TTL_MS) {
      touchCache(sym, cached);
      return { ...cached.data, cached: true };
    }
    // Price-stable extension: if we have both a cached price and a current
    // price, and price has moved less than PRICE_STABLE_BPS, extend cache
    // life up to PRICE_STABLE_TTL_MULT × TTL_MS. Cuts sentiment calls
    // during quiet/sideways markets without sacrificing freshness during
    // moves. NEVER applies if price is missing — fail-open to refresh.
    if (
      Number.isFinite(currentPrice) &&
      Number.isFinite(cached.price) &&
      cached.price > 0 &&
      age < TTL_MS * PRICE_STABLE_TTL_MULT
    ) {
      const movedBps = Math.abs((currentPrice - cached.price) / cached.price) * 10000;
      if (movedBps < PRICE_STABLE_BPS) {
        touchCache(sym, cached);
        return { ...cached.data, cached: true, priceStableSkip: true };
      }
    }
  }
  if (inflight.has(sym)) return inflight.get(sym);

  const p = (async () => {
    try {
      const data = await fetchFresh(sym);
      touchCache(sym, {
        ts: Date.now(),
        data,
        price: Number.isFinite(currentPrice) ? currentPrice : null,
      });
      return data;
    } finally {
      inflight.delete(sym);
    }
  })();
  inflight.set(sym, p);
  return p;
}

// Pre-fetch many symbols in parallel with bounded concurrency. Per-symbol
// getSentiment() already does inflight-dedupe; the batch-level promise here
// coalesces multiple overlapping callers (agent cycle + boot refresh +
// /api/markets backfill) so the second caller awaits the first instead of
// getting an empty {} back.
async function getSentimentBatch(symbols, { concurrency = 3, prices = null } = {}) {
  if (batchInflight) return batchInflight;
  const run = (async () => {
    const out = {};
    const queue = [...symbols];
    async function worker() {
      while (queue.length) {
        const s = queue.shift();
        const currentPrice = prices && Number.isFinite(prices[s]) ? prices[s] : null;
        try { out[s] = await getSentiment(s, { currentPrice }); }
        catch (e) { out[s] = defaultPayload(s, `Batch error: ${e.message}`); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
    return out;
  })();
  batchInflight = run.finally(() => { batchInflight = null; });
  return batchInflight;
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

function getProviders() {
  return PROVIDERS.map(p => ({ id: p.id, label: p.label, provider: p.provider, model: p.model }));
}

module.exports = { getSentiment, getSentimentBatch, getCached, getAllCached, clearCache, classify, getProviders, PROVIDERS };
