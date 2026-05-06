// Earnings-transcript summary layer.
//
// What it does
// ------------
// For each US watchlist symbol, asks Grok (free-tier, our primary
// real-time-knowledge model) to produce a compact 4-6 bullet structured
// summary of the most recent quarterly earnings call:
//   • management tone (defensive / confident / cautious / mixed)
//   • forward guidance — raised, reaffirmed, lowered, or withdrawn
//   • capex / buyback / dividend signals
//   • sector / macro commentary leaked by the CEO/CFO
//   • Q&A surprises or new disclosures
//
// Strictly informational — fed into the LLM prompt as one extra context
// block. Never votes, never sizes, never gates. Quorum, the 75-85% gate,
// the loss budget, the drawdown breaker, kill switch, and trailing stops
// remain the sole arbiters of execution.
//
// Storage
//   earnings_transcript_cache(symbol, as_of_date, payload, fetched_at)
//     PK(symbol). One row per symbol; refreshed quarterly or when the
//     fundamentals service flags an upcoming earnings date within 5 days.
//
// Refresh policy
//   • TTL 30 days (transcripts don't change after the call).
//   • Force-refresh if `fundamentalsService` reports a new
//     earnings_recent_surprise_pct (proxy for "new quarter just printed").
//   • Per-symbol in-flight dedup so concurrent agent + UI calls coalesce.

const axios = require('axios');
const db = require('./db');
const costTracker = require('./llmCostTracker');
const marketRegistry = require('./marketRegistry');

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const TIMEOUT_MS = 18000;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;            // 30 days
const NEAR_EARNINGS_REFRESH_DAYS = 5;
const MODEL = process.env.GROK_TRANSCRIPT_MODEL || 'grok-4-fast-non-reasoning';

const _mem = new Map();          // symbol → { ts, data }
const _inflight = new Map();

function _xaiKey() { return process.env.XAI_API_KEY || ''; }
function _isConfigured() { return !!_xaiKey(); }

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS earnings_transcript_cache (
      symbol       TEXT PRIMARY KEY,
      as_of_date   DATE NOT NULL,
      payload      JSONB NOT NULL,
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function _safeParseJson(txt) {
  if (!txt) return null;
  // Strip ```json fences if Grok wrapped it.
  const cleaned = String(txt).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {
    // Try to find the first JSON object substring.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (_) { return null; }
  }
}

async function _callGrok(symbol) {
  const apiKey = _xaiKey();
  if (!apiKey) throw new Error('xai-key-missing');
  const sys = `You are a senior equity research analyst. Summarize the MOST RECENT
quarterly earnings call for the requested ticker into a structured JSON. Be
specific and factual; if you don't know the latest call, say so via "tone":
"unknown". Never invent numbers. Output ONLY valid JSON, no prose.`;
  const user = `Ticker: ${symbol}

Return JSON with this exact shape:
{
  "callDate": "YYYY-MM-DD or null",
  "tone": "confident | cautious | defensive | mixed | unknown",
  "guidance": "raised | reaffirmed | lowered | withdrawn | none | unknown",
  "guidanceDetail": "<one short sentence on what changed>",
  "keyMetrics": ["<bullet 1>", "<bullet 2>", "<bullet 3>"],
  "capitalReturn": "<buyback / dividend / capex commentary in one short sentence, or 'none'>",
  "macroCommentary": "<sector or macro color from management, or 'none'>",
  "surprises": ["<Q&A surprise 1>", "<surprise 2>"],
  "forwardCatalysts": ["<near-term catalyst 1>", "<catalyst 2>"]
}

Keep every string ≤ 120 chars. 2-4 items per array max.`;
  const res = await axios.post(XAI_URL, {
    model: MODEL,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: 700,
    response_format: { type: 'json_object' },
  }, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: TIMEOUT_MS });
  const market = marketRegistry.getSymbolInfo(symbol)?.market || 'US';
  costTracker.recordUsage({ service: 'earnings', market, modelId: MODEL, response: res?.data });
  const txt = res?.data?.choices?.[0]?.message?.content || '';
  const parsed = _safeParseJson(txt);
  if (!parsed || typeof parsed !== 'object') throw new Error('parse-failed');
  return parsed;
}

async function _loadFromDb(symbol) {
  try {
    const { rows } = await db.query(
      `SELECT payload, EXTRACT(EPOCH FROM fetched_at)*1000 AS fetched_ms
       FROM earnings_transcript_cache WHERE symbol = $1`, [symbol]);
    if (!rows[0]) return null;
    return { ts: Number(rows[0].fetched_ms), data: rows[0].payload };
  } catch (_) { return null; }
}

async function _saveToDb(symbol, data) {
  try {
    await db.query(`
      INSERT INTO earnings_transcript_cache (symbol, as_of_date, payload, fetched_at)
      VALUES ($1, CURRENT_DATE, $2::jsonb, now())
      ON CONFLICT (symbol) DO UPDATE
        SET payload = EXCLUDED.payload, as_of_date = EXCLUDED.as_of_date, fetched_at = now()
    `, [symbol, JSON.stringify(data)]);
  } catch (e) { console.warn('[EarningsTranscript] save failed:', e.message); }
}

// Public: get-or-refresh per symbol.
//
// Refresh triggers (any of):
//   • No cache row at all
//   • Cache row older than TTL_MS (30 days)
//   • opts.nearEarningsDays present and < NEAR_EARNINGS_REFRESH_DAYS (caller
//     passes this in when fundamentalsService says earnings is imminent)
//
// Best-effort: any failure path returns the most recent (possibly stale)
// cache row, or null. NEVER throws to the caller.
async function getOrRefresh(symbol, opts = {}) {
  const now = Date.now();
  const memHit = _mem.get(symbol);
  if (memHit && now - memHit.ts < 60 * 1000) return memHit.data;   // 60s in-process
  if (_inflight.has(symbol)) return _inflight.get(symbol);

  const p = (async () => {
    await ensureSchema().catch(() => {});
    const dbHit = await _loadFromDb(symbol);
    const ageMs = dbHit ? now - dbHit.ts : Infinity;
    const nearEarnings = Number.isFinite(opts.nearEarningsDays) && opts.nearEarningsDays >= 0
      && opts.nearEarningsDays < NEAR_EARNINGS_REFRESH_DAYS;
    const stale = ageMs >= TTL_MS;
    if (dbHit && !stale && !nearEarnings) {
      _mem.set(symbol, { ts: now, data: dbHit.data });
      return dbHit.data;
    }
    if (!_isConfigured()) {
      // No XAI key → return whatever cache we have (even stale) rather than null.
      if (dbHit) { _mem.set(symbol, { ts: now, data: dbHit.data }); return dbHit.data; }
      return null;
    }
    try {
      const fresh = await _callGrok(symbol);
      const enriched = { ...fresh, _refreshedAt: new Date().toISOString() };
      await _saveToDb(symbol, enriched);
      _mem.set(symbol, { ts: now, data: enriched });
      return enriched;
    } catch (e) {
      console.warn(`[EarningsTranscript] refresh ${symbol} failed:`, e.message);
      if (dbHit) { _mem.set(symbol, { ts: now, data: dbHit.data }); return dbHit.data; }
      return null;
    }
  })();
  _inflight.set(symbol, p);
  try { return await p; } finally { _inflight.delete(symbol); }
}

function getCached(symbol) {
  const m = _mem.get(symbol);
  return m ? m.data : null;
}

function renderForPrompt(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.tone === 'unknown' && (!d.keyMetrics || !d.keyMetrics.length)) return null;
  const lines = [];
  const hdr = `Earnings transcript (last call ${d.callDate || 'date n/a'}):`;
  lines.push(hdr);
  lines.push(`  Tone: ${d.tone || 'unknown'} · Guidance: ${d.guidance || 'unknown'}${d.guidanceDetail ? ` — ${d.guidanceDetail}` : ''}`);
  if (Array.isArray(d.keyMetrics) && d.keyMetrics.length) {
    lines.push('  Key metrics:');
    for (const m of d.keyMetrics.slice(0, 4)) lines.push(`    • ${m}`);
  }
  if (d.capitalReturn && d.capitalReturn !== 'none') lines.push(`  Capital return: ${d.capitalReturn}`);
  if (d.macroCommentary && d.macroCommentary !== 'none') lines.push(`  Macro/sector color: ${d.macroCommentary}`);
  if (Array.isArray(d.surprises) && d.surprises.length) {
    lines.push('  Surprises / new disclosures:');
    for (const s of d.surprises.slice(0, 3)) lines.push(`    • ${s}`);
  }
  if (Array.isArray(d.forwardCatalysts) && d.forwardCatalysts.length) {
    lines.push('  Forward catalysts:');
    for (const c of d.forwardCatalysts.slice(0, 3)) lines.push(`    • ${c}`);
  }
  return lines.join('\n');
}

// Batch refresher used by the boot scheduler. Sequential with a small delay
// so we don't burst the XAI rate limit.
async function refreshBatch(symbols, opts = {}) {
  const out = {};
  for (const s of symbols) {
    try { out[s] = await getOrRefresh(s, opts); }
    catch (e) { out[s] = null; }
    await new Promise(r => setTimeout(r, 250));
  }
  return out;
}

module.exports = { ensureSchema, getOrRefresh, getCached, renderForPrompt, refreshBatch, isConfigured: _isConfigured };
