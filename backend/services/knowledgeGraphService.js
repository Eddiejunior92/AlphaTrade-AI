// Long-term company knowledge graph.
//
// A persistent per-symbol graph that captures the slow-moving context the
// agent shouldn't have to re-derive every cycle: sector dynamics, peer set,
// recent earnings outcomes + next-print date, valuation, macro backdrop, and
// a curated rolling timeline of major events (product launches, management
// changes, regulatory, M&A, big surprises).
//
// Refresh strategy:
//   • Daily batched refresh (every 24h) for the entire US + ASX universe.
//   • Event-triggered refresh: when sentimentService observes a strong news
//     score (|score| ≥ 0.5), the affected symbol is flagged stale; the next
//     pass picks it up well before the 24h window.
//   • Per-symbol staleness check inside refresh: skip if updated < 22h ago
//     and not flagged stale. Flag is cleared on successful refresh.
//
// Data sources (no new external APIs):
//   • marketRegistry  — name / sector / industry / description (curated)
//   • sectors.js      — peer set within the same sector
//   • fundamentalsService.getCached() — earnings surprise, next date, growth
//                                        PE, sector strength, macro context
//   • sentimentService.getCached()    — recent narrative + insights + sources
//   • Optional one-shot LLM call (Grok mini) once per refresh per symbol to
//     extract a structured event timeline from the news narrative. Fully
//     best-effort; the graph is still built without it.
//
// Safety: read-only with respect to trading. The prompt block is purely
// informational. Quorum, confidence gates, sizing math, and circuit breaker
// are unaffected. All public methods swallow errors and return null on
// failure rather than throwing.

const axios = require('axios');
const db = require('./db');
const marketRegistry = require('./marketRegistry');
const fundamentalsService = require('./fundamentalsService');
const sentimentService = require('./sentimentService');
const { getWatchlist } = require('../strategies');

// Combined US + ASX universe — sourced from the same accessors agent.js uses.
function getAllSymbols() {
  const us = getWatchlist();
  const asx = marketRegistry.getAsxWatchlist();
  return [...new Set([...us, ...asx])];
}

const REFRESH_TTL_HOURS = 22;       // soft daily refresh
const EVENT_TIMELINE_MAX = 6;       // bounded growth — last 6 events
const EARNINGS_HISTORY_MAX = 6;     // bounded growth — last 6 quarters
const SUMMARY_CHAR_BUDGET = 1400;   // hard cap on prompt block size
const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const LLM_TIMEOUT_MS = 25_000;
const LLM_MODEL = process.env.KG_LLM_MODEL || 'grok-2-mini';

let _refreshLock = false;

// Curated company metadata for the full US (30) + ASX (27) universe.
// marketRegistry only carries market/currency/broker, so we keep the
// long-term "what does this company do" facts here. Sector strings line up
// with the canonical S&P / GICS-ish labels used elsewhere so peer-grouping
// across the two markets stays sensible (e.g. JPM ↔ MQG).
const COMPANY_INFO = {
  // --- US mega-cap tech ---
  AAPL:  { name: 'Apple Inc.',                sector: 'Technology', industry: 'Consumer Electronics',     description: 'iPhone, Mac, Wearables, Services; world-leading consumer hardware + services flywheel.' },
  NVDA:  { name: 'NVIDIA Corp.',              sector: 'Technology', industry: 'Semiconductors',           description: 'GPU + datacenter accelerator leader; dominant in AI training/inference silicon.' },
  MSFT:  { name: 'Microsoft Corp.',           sector: 'Technology', industry: 'Software',                 description: 'Azure cloud, Office/M365, Windows, Activision gaming; deeply embedded enterprise stack.' },
  AMZN:  { name: 'Amazon.com Inc.',           sector: 'Consumer Discretionary', industry: 'E-commerce / Cloud', description: 'AWS cloud, online retail, Prime, advertising, logistics.' },
  META:  { name: 'Meta Platforms Inc.',       sector: 'Communication Services', industry: 'Social Media / Ads', description: 'Facebook, Instagram, WhatsApp, Reality Labs; ad-funded social + AI infra build-out.' },
  GOOGL: { name: 'Alphabet Inc.',             sector: 'Communication Services', industry: 'Search / Ads / Cloud', description: 'Google Search, YouTube, Android, Google Cloud, Waymo.' },
  TSLA:  { name: 'Tesla Inc.',                sector: 'Consumer Discretionary', industry: 'EV / Energy', description: 'Battery EVs, energy storage, FSD/robotaxi optionality.' },
  AMD:   { name: 'Advanced Micro Devices',    sector: 'Technology', industry: 'Semiconductors',           description: 'CPU + GPU + datacenter accelerators; #2 to NVDA in AI training silicon.' },
  AVGO:  { name: 'Broadcom Inc.',             sector: 'Technology', industry: 'Semiconductors',           description: 'Networking / custom-AI ASIC silicon + VMware enterprise software.' },
  NFLX:  { name: 'Netflix Inc.',              sector: 'Communication Services', industry: 'Streaming Media', description: 'Global streaming subscription leader; ad-tier monetization underway.' },
  // --- US financials / payments ---
  JPM:   { name: 'JPMorgan Chase & Co.',      sector: 'Financials', industry: 'Money Center Banks',       description: 'Largest US bank by assets; investment banking, consumer banking, AWM.' },
  BAC:   { name: 'Bank of America Corp.',     sector: 'Financials', industry: 'Money Center Banks',       description: 'Big-four US bank; rate-sensitive earnings via large deposit base.' },
  GS:    { name: 'Goldman Sachs Group',       sector: 'Financials', industry: 'Investment Banking',       description: 'IBD + global markets + asset management; cyclical to capital-markets activity.' },
  V:     { name: 'Visa Inc.',                 sector: 'Financials', industry: 'Payment Networks',         description: 'Global payment rails; cross-border volume = high-margin earnings driver.' },
  // --- US consumer ---
  COST:  { name: 'Costco Wholesale',          sector: 'Consumer Staples', industry: 'Membership Warehouse', description: 'Membership-fee economics; defensive comp-sales engine.' },
  WMT:   { name: 'Walmart Inc.',              sector: 'Consumer Staples', industry: 'Discount Retail',    description: 'Global discount retail + fast-growing online + Walmart+ ads/membership.' },
  HD:    { name: 'Home Depot',                sector: 'Consumer Discretionary', industry: 'Home Improvement Retail', description: 'Home-improvement big-box; cyclical to housing turnover + remodels.' },
  MCD:   { name: 'McDonald\'s Corp.',         sector: 'Consumer Discretionary', industry: 'Restaurants',  description: 'Global QSR franchise; defensive cash-flow profile.' },
  // --- US healthcare ---
  JNJ:   { name: 'Johnson & Johnson',         sector: 'Healthcare', industry: 'Pharmaceuticals / MedTech', description: 'Innovative pharma + medtech (post-Kenvue spin); defensive growth.' },
  PFE:   { name: 'Pfizer Inc.',               sector: 'Healthcare', industry: 'Pharmaceuticals',          description: 'Big pharma; post-COVID re-base + oncology pipeline (Seagen).' },
  LLY:   { name: 'Eli Lilly & Co.',           sector: 'Healthcare', industry: 'Pharmaceuticals',          description: 'GLP-1 obesity/diabetes leadership (Mounjaro/Zepbound) + neuroscience.' },
  UNH:   { name: 'UnitedHealth Group',        sector: 'Healthcare', industry: 'Managed Care',             description: 'Largest US health insurer + Optum services / OptumRx.' },
  // --- US energy ---
  XOM:   { name: 'Exxon Mobil Corp.',         sector: 'Energy', industry: 'Integrated Oil & Gas',         description: 'Integrated oil major; Permian + Guyana growth + LNG.' },
  CVX:   { name: 'Chevron Corp.',             sector: 'Energy', industry: 'Integrated Oil & Gas',         description: 'Integrated oil major; Permian + Tengiz + LNG portfolio.' },
  // --- US semis ---
  INTC:  { name: 'Intel Corp.',               sector: 'Technology', industry: 'Semiconductors',           description: 'CPU + foundry turnaround; capital-intensive IDM rebuild.' },
  MU:    { name: 'Micron Technology',         sector: 'Technology', industry: 'Semiconductors / Memory',  description: 'DRAM + NAND memory; cyclical to AI HBM + PC/handset demand.' },
  QCOM:  { name: 'Qualcomm Inc.',             sector: 'Technology', industry: 'Semiconductors / Mobile',  description: 'Mobile SoC + licensing; auto + IoT diversification.' },
  TSM:   { name: 'Taiwan Semiconductor',      sector: 'Technology', industry: 'Semiconductor Foundry',    description: 'Dominant leading-edge foundry; AI/HPC node leadership.' },
  // --- US ETFs (macro anchors) ---
  SPY:   { name: 'SPDR S&P 500 ETF',          sector: 'ETF', industry: 'Broad Market ETF',                description: 'Tracks the S&P 500; macro tape proxy.' },
  QQQ:   { name: 'Invesco QQQ Trust',         sector: 'ETF', industry: 'Tech-Heavy ETF',                  description: 'Tracks the Nasdaq-100; tech-tilted macro proxy.' },

  // --- ASX big-four banks ---
  CBA:   { name: 'Commonwealth Bank of Australia', sector: 'Financials', industry: 'Money Center Banks', description: 'Largest ASX bank by mcap; dominant Australian retail banking + mortgages.' },
  WBC:   { name: 'Westpac Banking Corp.',     sector: 'Financials', industry: 'Money Center Banks',       description: 'Big-four Australian bank; mortgage-heavy book.' },
  NAB:   { name: 'National Australia Bank',   sector: 'Financials', industry: 'Money Center Banks',       description: 'Big-four bank; #1 in Australian SME/business banking.' },
  ANZ:   { name: 'ANZ Banking Group',         sector: 'Financials', industry: 'Money Center Banks',       description: 'Big-four bank with regional Asia-Pac institutional franchise.' },
  MQG:   { name: 'Macquarie Group',           sector: 'Financials', industry: 'Investment Banking',       description: 'Global investment bank + asset management + commodities; cyclical.' },
  // --- ASX miners ---
  BHP:   { name: 'BHP Group',                 sector: 'Materials', industry: 'Diversified Mining',        description: 'World\'s largest diversified miner; iron ore + copper + potash.' },
  RIO:   { name: 'Rio Tinto',                 sector: 'Materials', industry: 'Diversified Mining',        description: 'Iron ore (Pilbara) + copper + aluminium; high-margin commodity exposure.' },
  FMG:   { name: 'Fortescue Metals Group',    sector: 'Materials', industry: 'Iron Ore',                  description: 'Pure-play Pilbara iron ore + green hydrogen optionality (FFI).' },
  S32:   { name: 'South32',                   sector: 'Materials', industry: 'Diversified Mining',        description: 'Diversified miner spun from BHP — alumina, manganese, base metals.' },
  PLS:   { name: 'Pilbara Minerals',          sector: 'Materials', industry: 'Lithium Mining',            description: 'Pure-play hard-rock lithium spodumene producer.' },
  MIN:   { name: 'Mineral Resources',         sector: 'Materials', industry: 'Lithium / Iron Ore / Services', description: 'Lithium + iron ore + mining services; high operating leverage.' },
  JHX:   { name: 'James Hardie Industries',   sector: 'Materials', industry: 'Building Products',         description: 'Global fibre-cement leader; cyclical to US housing.' },
  // --- ASX healthcare ---
  CSL:   { name: 'CSL Limited',               sector: 'Healthcare', industry: 'Biotech / Plasma',         description: 'Global #1 in plasma-derived therapies; vaccines + Vifor renal/iron.' },
  RMD:   { name: 'ResMed Inc.',               sector: 'Healthcare', industry: 'Medical Devices',          description: 'Sleep-apnea CPAP devices + digital health; GLP-1 fears overdone narrative.' },
  COH:   { name: 'Cochlear Limited',          sector: 'Healthcare', industry: 'Medical Devices',          description: 'Global leader in cochlear implants for hearing loss.' },
  // --- ASX tech / online ---
  REA:   { name: 'REA Group',                 sector: 'Communication Services', industry: 'Online Real Estate', description: 'Operates realestate.com.au; dominant Aus property listings.' },
  XRO:   { name: 'Xero Limited',              sector: 'Technology', industry: 'SaaS / Accounting',        description: 'Global SMB cloud accounting; ANZ + UK leadership, North America build.' },
  CPU:   { name: 'Computershare',             sector: 'Financials', industry: 'Financial Services Tech',  description: 'Global share-registry + corporate trust; rate-sensitive margin income.' },
  // --- ASX consumer ---
  WOW:   { name: 'Woolworths Group',          sector: 'Consumer Staples', industry: 'Supermarkets',       description: 'Largest Australian supermarket chain; defensive comp-sales engine.' },
  WES:   { name: 'Wesfarmers',                sector: 'Consumer Staples', industry: 'Conglomerate Retail', description: 'Bunnings (home improvement) + Kmart + chemicals + lithium (Mt Holland).' },
  ALL:   { name: 'Aristocrat Leisure',        sector: 'Consumer Discretionary', industry: 'Gaming',       description: 'Global gaming machine leader + mobile/social games (Pixel United).' },
  // --- ASX industrials / logistics ---
  TCL:   { name: 'Transurban Group',          sector: 'Industrials', industry: 'Toll Roads',              description: 'Toll-road owner/operator across AU + North America; CPI-linked tolls.' },
  BXB:   { name: 'Brambles Limited',          sector: 'Industrials', industry: 'Logistics / Pooling',     description: 'CHEP pallet pooling — global B2B reusable supply-chain assets.' },
  GMG:   { name: 'Goodman Group',             sector: 'Real Estate', industry: 'Industrial REIT',         description: 'Industrial / logistics REIT; data-centre development pipeline now a key driver.' },
  // --- ASX energy ---
  STO:   { name: 'Santos Limited',            sector: 'Energy', industry: 'Oil & Gas',                    description: 'Australian oil & gas producer; LNG (PNG/GLNG) + domestic gas.' },
  ORG:   { name: 'Origin Energy',             sector: 'Utilities', industry: 'Integrated Utility',        description: 'Integrated power/gas retailer + APLNG stake; energy-transition exposure.' },
  WDS:   { name: 'Woodside Energy',           sector: 'Energy', industry: 'LNG / Oil & Gas',              description: 'Australia\'s largest independent oil & gas company; LNG-led portfolio.' },
};

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS company_knowledge (
      symbol           TEXT PRIMARY KEY,
      market           TEXT,
      sector           TEXT,
      data             JSONB NOT NULL DEFAULT '{}'::jsonb,
      summary          TEXT,
      stale_flag       BOOLEAN NOT NULL DEFAULT FALSE,
      stale_reason     TEXT,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      next_refresh_at  TIMESTAMPTZ
    )
  `);
}

// ---------------------------------------------------------------------------
// Sector peer lookup. Pulls live company metadata out of marketRegistry/
// sectors so we don't duplicate the universe definition here.
function getSectorPeers(symbol, sector) {
  if (!sector) return [];
  const out = [];
  for (const sym of getAllSymbols()) {
    if (sym === symbol) continue;
    const ci = COMPANY_INFO[sym];
    if (ci?.sector === sector) out.push(sym);
    if (out.length >= 6) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build the deterministic core of the graph from sources we already have.
// This always succeeds (every field is optional) — the LLM event extraction
// is layered on top in a second step.
function buildCoreGraph(symbol) {
  const sym = String(symbol).toUpperCase();
  const market = marketRegistry.getSymbolInfo(sym) || {};
  const company = COMPANY_INFO[sym] || {};
  const fund = fundamentalsService.getCached(sym) || null;
  const senti = sentimentService.getCached(sym) || null;

  const sector = company.sector || fund?.sector || null;
  const peers = getSectorPeers(sym, sector);

  // Earnings history is appended to ON each refresh from the
  // fundamentals "recent surprise" reading — see appendEarningsObservation
  // below. Core build only seeds the most-recent observation if available.
  const earnings = fund?.earnings_recent_surprise_pct != null ? [{
    observed_at: fund.fetchedAt || new Date().toISOString(),
    surprise_pct: fund.earnings_recent_surprise_pct,
    eps_growth_yoy_pct: fund.eps_growth_yoy_pct,
    revenue_growth_yoy_pct: fund.revenue_growth_yoy_pct,
  }] : [];

  return {
    company: {
      name: company.name || sym,
      sector, industry: company.industry || null,
      market: market.market || 'US', currency: market.currency || 'USD',
      description: company.description || null,
    },
    sector_dynamics: {
      sector, peers,
      strength_30d_pct: fund?.sector_strength_30d_pct ?? null,
      strength_label: fund?.sector_strength_label || 'unknown',
    },
    earnings_history: earnings,
    next_earnings: fund?.earnings_next_date || null,
    valuation: { pe_ratio: fund?.pe_ratio ?? null, label: fund?.valuation_label || 'unknown' },
    macro_context: fund?.macro_context || null,
    major_events: [],     // populated by LLM extraction step (best-effort)
    competitive_landscape: peers.length
      ? `Direct peers in ${sector || 'sector'}: ${peers.slice(0, 4).join(', ')}.`
      : null,
    recent_narrative: senti?.summary || null,
    recent_insights: Array.isArray(senti?.insights) ? senti.insights.slice(0, 3) : [],
  };
}

// ---------------------------------------------------------------------------
// Append the latest earnings observation to history if it differs from the
// most recent stored one. Bounded growth — keeps last EARNINGS_HISTORY_MAX.
function appendEarningsObservation(prevHistory, fund) {
  const list = Array.isArray(prevHistory) ? [...prevHistory] : [];
  if (!fund || fund.earnings_recent_surprise_pct == null) return list;
  const latest = {
    observed_at: fund.fetchedAt || new Date().toISOString(),
    surprise_pct: fund.earnings_recent_surprise_pct,
    eps_growth_yoy_pct: fund.eps_growth_yoy_pct,
    revenue_growth_yoy_pct: fund.revenue_growth_yoy_pct,
  };
  const last = list[list.length - 1];
  // Dedupe — only push if a numeric value actually changed since last seen.
  const same = last && last.surprise_pct === latest.surprise_pct
    && last.eps_growth_yoy_pct === latest.eps_growth_yoy_pct
    && last.revenue_growth_yoy_pct === latest.revenue_growth_yoy_pct;
  if (!same) list.push(latest);
  return list.slice(-EARNINGS_HISTORY_MAX);
}

// ---------------------------------------------------------------------------
// Optional LLM event extraction. Asks Grok mini to distill a small structured
// list of the most material events from the current sentiment narrative +
// insights. Fully best-effort: returns [] on any failure.
async function extractEventsViaLLM(symbol, core) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return [];
  const sourceText = [
    core.recent_narrative,
    ...(core.recent_insights || []),
    core.macro_context,
  ].filter(Boolean).join(' | ');
  if (!sourceText) return [];
  const prompt = `You are a financial-research assistant. From the snippets below about ${symbol} (${core.company.name}) plus your own knowledge of the company, extract up to 5 of the most MATERIAL recent events from the past ~12 months that a swing trader would care about. Categories: earnings_surprise, product_launch, management_change, regulatory, M&A, guidance_change, macro_shock.

Return ONLY a JSON object {"events": [...]} where each event is:
{ "date": "<YYYY-MM or YYYY-MM-DD>", "type": "<one of the categories>", "summary": "<≤140 chars, factual, no hype>" }

If you cannot identify any material events, return {"events": []}.

Snippets: ${sourceText}`;
  try {
    const res = await axios.post(XAI_URL, {
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500, temperature: 0.1,
      response_format: { type: 'json_object' },
    }, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: LLM_TIMEOUT_MS,
    });
    const text = res.data?.choices?.[0]?.message?.content || '';
    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    return events
      .filter(e => e && typeof e === 'object' && e.summary)
      .slice(0, EVENT_TIMELINE_MAX)
      .map(e => ({
        date: String(e.date || '').slice(0, 10) || null,
        type: String(e.type || 'event').slice(0, 32),
        summary: String(e.summary).slice(0, 200),
      }));
  } catch (e) {
    console.warn(`[KG:${symbol}] LLM event extraction failed (best-effort):`, e.response?.data?.error?.message || e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Render a compact prompt block. Bounded line count + char budget so the
// LLM prompt budget per cycle stays predictable. Returns '' (empty) when no
// material content — caller decides whether to include or skip.
function renderSummary(graph) {
  if (!graph) return '';
  const lines = [];
  const c = graph.company || {};
  lines.push(`KNOWLEDGE GRAPH — ${c.name || ''} (${c.sector || '—'}/${c.industry || '—'})`);
  if (c.description) lines.push(`• Profile: ${c.description}`);

  const sd = graph.sector_dynamics || {};
  if (sd.peers && sd.peers.length) {
    const strBit = (sd.strength_30d_pct != null)
      ? ` | sector 30d ${sd.strength_30d_pct >= 0 ? '+' : ''}${sd.strength_30d_pct}% (${sd.strength_label || 'unknown'})`
      : '';
    lines.push(`• Sector peers: ${sd.peers.slice(0, 4).join(', ')}${strBit}`);
  }

  if (graph.next_earnings) lines.push(`• Next earnings: ${graph.next_earnings}`);
  const eh = (graph.earnings_history || []).slice(-3);
  if (eh.length) {
    const bits = eh.map(e => {
      const surp = e.surprise_pct != null ? `${e.surprise_pct >= 0 ? '+' : ''}${e.surprise_pct}%` : 'n/a';
      const eps  = e.eps_growth_yoy_pct != null ? `EPS YoY ${e.eps_growth_yoy_pct >= 0 ? '+' : ''}${e.eps_growth_yoy_pct}%` : '';
      return `${(e.observed_at || '').slice(0, 10)} surp ${surp}${eps ? ', ' + eps : ''}`;
    });
    lines.push(`• Earnings track: ${bits.join(' | ')}`);
  }

  const v = graph.valuation || {};
  if (v.pe_ratio != null || v.label) {
    lines.push(`• Valuation: PE ${v.pe_ratio ?? 'n/a'} (${v.label || 'unknown'})`);
  }
  if (graph.macro_context) lines.push(`• Macro backdrop: ${String(graph.macro_context).slice(0, 240)}`);

  const ev = (graph.major_events || []).slice(-EVENT_TIMELINE_MAX);
  if (ev.length) {
    lines.push(`• Major events:`);
    for (const e of ev) lines.push(`   – [${e.date || '?'}] ${e.type}: ${e.summary}`);
  }
  // Hard char cap so this block can never blow the LLM prompt budget.
  let out = lines.join('\n');
  if (out.length > SUMMARY_CHAR_BUDGET) out = out.slice(0, SUMMARY_CHAR_BUDGET - 3) + '...';
  return out;
}

// ---------------------------------------------------------------------------
// Persist the core graph (no LLM I/O). Race-safe vs concurrent markStale:
// only clears the stale flag when the row's updated_at is older than the
// refresh-start timestamp we recorded BEFORE we began work, so a markStale
// fired mid-refresh is preserved for the next pass.
async function persistCore(sym, core, refreshStartedAt) {
  const summary = renderSummary(core);
  const nextRefresh = new Date(Date.now() + REFRESH_TTL_HOURS * 3600_000);
  await db.query(`
    INSERT INTO company_knowledge (symbol, market, sector, data, summary, stale_flag, stale_reason, updated_at, next_refresh_at)
    VALUES ($1, $2, $3, $4, $5, FALSE, NULL, NOW(), $6)
    ON CONFLICT (symbol) DO UPDATE SET
      market = EXCLUDED.market,
      sector = EXCLUDED.sector,
      data = EXCLUDED.data,
      summary = EXCLUDED.summary,
      updated_at = NOW(),
      next_refresh_at = EXCLUDED.next_refresh_at,
      -- Preserve a stale flag set DURING the refresh (after refreshStartedAt)
      stale_flag = CASE
        WHEN company_knowledge.stale_flag = TRUE
          AND company_knowledge.updated_at > $7
        THEN TRUE ELSE FALSE END,
      stale_reason = CASE
        WHEN company_knowledge.stale_flag = TRUE
          AND company_knowledge.updated_at > $7
        THEN company_knowledge.stale_reason ELSE NULL END
  `, [sym, core.company.market, core.company.sector, core, summary, nextRefresh, refreshStartedAt]);
}

// Refresh a single symbol. Two-phase to keep prompt-block availability
// decoupled from LLM latency:
//   Phase 1 — synchronous: build core graph from local caches, append
//     earnings observation, persist + render summary. Returns success here
//     even if LLM enrichment later fails or times out.
//   Phase 2 — best-effort async: ask Grok-mini to distill major events, then
//     re-persist with the merged event timeline. Failures are swallowed.
// Returns { ok, status, reason? } so the caller (refreshAll) can report
// accurate counts instead of silently treating null as success.
async function refreshSymbol(symbol, { force = false, skipLlm = false } = {}) {
  const sym = String(symbol).toUpperCase();
  try {
    await ensureSchema();
    const { rows } = await db.query(`SELECT * FROM company_knowledge WHERE symbol = $1`, [sym]);
    const prev = rows[0] || null;

    if (!force && prev && prev.next_refresh_at && !prev.stale_flag) {
      if (new Date(prev.next_refresh_at) > new Date()) {
        return { ok: true, status: 'cached' };
      }
    }

    const refreshStartedAt = new Date();
    const core = buildCoreGraph(sym);
    const fund = fundamentalsService.getCached(sym) || null;
    const prevData = prev?.data || {};

    // Carry forward bounded history.
    core.earnings_history = appendEarningsObservation(prevData.earnings_history || [], fund);
    core.major_events = (prevData.major_events || []).slice(-EVENT_TIMELINE_MAX);

    // Phase 1 — persist immediately so /api/knowledge + agent prompts have
    // a fresh summary even if the LLM is slow or down.
    await persistCore(sym, core, refreshStartedAt);

    // Phase 2 — best-effort LLM enrichment. Re-persist when it returns.
    if (!skipLlm) {
      try {
        const fresh = await extractEventsViaLLM(sym, core);
        if (fresh.length) {
          const combined = [...(prevData.major_events || []), ...fresh];
          const seen = new Set();
          core.major_events = combined.reverse().filter(e => {
            const k = `${e.date || ''}|${e.summary}`;
            if (seen.has(k)) return false;
            seen.add(k); return true;
          }).reverse().slice(-EVENT_TIMELINE_MAX);
          await persistCore(sym, core, refreshStartedAt);
        }
      } catch (e) {
        console.warn(`[KG:${sym}] enrichment skipped:`, e.message);
      }
    }
    return { ok: true, status: 'refreshed' };
  } catch (e) {
    console.error(`[KG:${sym}] refresh failed (swallowed):`, e.message);
    return { ok: false, status: 'error', reason: e.message };
  }
}

// ---------------------------------------------------------------------------
// Daily batched refresh across the full US + ASX watchlist. Bounded
// concurrency so we don't fan-out 57 LLM calls in one burst.
async function refreshAll({ concurrency = 2, force = false } = {}) {
  if (_refreshLock) {
    return { ok: 0, err: 0, total: 0, skipped: true, reason: 'in-progress' };
  }
  _refreshLock = true;
  try {
    await ensureSchema();
    const symbols = getAllSymbols();
    let ok = 0, err = 0, cached = 0;
    const queue = [...symbols];
    async function worker() {
      while (queue.length) {
        const s = queue.shift();
        try {
          const r = await refreshSymbol(s, { force });
          if (!r || r.ok === false) err++;
          else if (r.status === 'cached') cached++;
          else ok++;
        } catch (_) { err++; }
        await new Promise(r => setTimeout(r, 250));   // pace LLM endpoint
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log(`[KG] refresh complete — refreshed=${ok} cached=${cached} errs=${err} of ${symbols.length}`);
    return { ok, cached, err, total: symbols.length };
  } finally { _refreshLock = false; }
}

// ---------------------------------------------------------------------------
// Mark a symbol stale so the next refresh pass picks it up out of band. Used
// by sentimentService when a strong news shock is detected.
async function markStale(symbol, reason = 'event-trigger') {
  try {
    await ensureSchema();
    const sym = String(symbol).toUpperCase();
    // Upsert so a stale flag isn't lost when the row hasn't been seeded yet
    // (e.g. event arrives before the boot warm-up reaches this symbol).
    await db.query(`
      INSERT INTO company_knowledge (symbol, market, sector, data, summary, stale_flag, stale_reason, updated_at, next_refresh_at)
      VALUES ($1, NULL, NULL, '{}'::jsonb, NULL, TRUE, $2, NOW(), NOW())
      ON CONFLICT (symbol) DO UPDATE SET
        stale_flag = TRUE,
        stale_reason = EXCLUDED.stale_reason,
        next_refresh_at = NOW(),
        updated_at = NOW()
    `, [sym, String(reason).slice(0, 120)]);
  } catch (_) { /* swallow */ }
}

// ---------------------------------------------------------------------------
// Read paths — instant, DB-backed. No LLM I/O.
async function getPromptBlock(symbol) {
  try {
    const { rows } = await db.query(
      `SELECT summary FROM company_knowledge WHERE symbol = $1`,
      [String(symbol).toUpperCase()],
    );
    return rows[0]?.summary || null;
  } catch { return null; }
}

async function getGraph(symbol) {
  try {
    const { rows } = await db.query(
      `SELECT symbol, market, sector, data, summary, updated_at, next_refresh_at, stale_flag
       FROM company_knowledge WHERE symbol = $1`,
      [String(symbol).toUpperCase()],
    );
    return rows[0] || null;
  } catch { return null; }
}

async function listAll() {
  try {
    await ensureSchema();
    const { rows } = await db.query(
      `SELECT symbol, market, sector, updated_at, next_refresh_at, stale_flag
       FROM company_knowledge ORDER BY symbol`,
    );
    return rows;
  } catch { return []; }
}

module.exports = {
  ensureSchema, refreshSymbol, refreshAll, markStale,
  getPromptBlock, getGraph, listAll,
  REFRESH_TTL_HOURS,
};
