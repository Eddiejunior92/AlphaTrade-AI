// Advanced options flow + implied-volatility analysis layer.
//
// What it does
// ------------
// For every US watchlist symbol it pulls the live options chain from Alpaca's
// snapshot endpoint, parses the OCC contract symbols into strike/expiry/type,
// and computes a compact set of decision-grade metrics:
//
//   • Put/Call volume + OI ratios               (sentiment proxy)
//   • Average ATM implied volatility             (baseline IV reading)
//   • IV skew = OTM-put IV − OTM-call IV         (downside-fear premium)
//   • IV rank (0–100) over rolling 252 trading-day window
//                                                 (where today's IV sits in its
//                                                  1-year range — 100 = highest
//                                                  IV in a year, 0 = lowest)
//   • Unusual-activity contracts:
//       - vol/OI ratio ≥ 2.0 AND vol ≥ 100      (sweep proxy)
//       - vol ≥ 1000 on a single contract        (block proxy)
//
// Strictly informational. Renders into a 1–4 line prompt block consumed by
// every LLM in the ensemble. Quorum, confidence gate, sizing, breaker, and
// kill switch are NOT modified by this layer.
//
// Storage
//   iv_history(symbol, as_of_date, iv_avg)  PK(symbol, as_of_date)
//     One row per symbol per trading day; used to compute IV rank.
//
// Caching
//   30-min TTL per symbol in-memory. Per-symbol in-flight dedup.
//
// API: GET /api/options-flow/:symbol  (read-only introspection)

const axios = require('axios');
const db = require('./db');

const ALPACA_DATA = 'https://data.alpaca.markets';
const TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 12000;
const MAX_CONTRACTS = 200;          // hard cap on contracts kept per symbol
const NEAR_MONEY_PCT = 0.15;        // keep strikes within ±15% of spot
const MAX_DAYS_TO_EXPIRY = 60;
const IV_RANK_WINDOW_DAYS = 252;
const UNUSUAL_VOL_OI_RATIO = 2.0;
const UNUSUAL_VOL_FLOOR = 100;
const BLOCK_VOL_FLOOR = 1000;

const _cache = new Map();   // symbol → { ts, data }
const _inflight = new Map();

function getKeys() {
  return {
    apiKey:    process.env.ALPACA_LIVE_API_KEY    || process.env.ALPACA_API_KEY    || '',
    secretKey: process.env.ALPACA_LIVE_SECRET_KEY || process.env.ALPACA_SECRET_KEY || '',
  };
}
function isConfigured() { const k = getKeys(); return !!(k.apiKey && k.secretKey); }

// Parse an OCC option symbol into its components.
// Format: <ROOT><YYMMDD><C|P><STRIKE*1000 zero-padded to 8 digits>
//   e.g. AAPL241220C00200000  →  { root:'AAPL', expiry:'2024-12-20',
//                                  type:'call', strike:200 }
// Returns null on any parse failure (defensive — never throws).
function parseOcc(sym) {
  try {
    const m = String(sym).match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!m) return null;
    const [, root, ymd, cp, strikeRaw] = m;
    const yy = +ymd.slice(0, 2), mm = +ymd.slice(2, 4), dd = +ymd.slice(4, 6);
    const year = yy >= 70 ? 1900 + yy : 2000 + yy;
    const expiry = new Date(Date.UTC(year, mm - 1, dd));
    const strike = parseInt(strikeRaw, 10) / 1000;
    if (!Number.isFinite(strike) || strike <= 0) return null;
    return { root, expiry, expiryStr: expiry.toISOString().slice(0, 10),
             type: cp === 'C' ? 'call' : 'put', strike };
  } catch (_) { return null; }
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// Fetch one page of the snapshot for a symbol. Alpaca returns up to ~100
// contracts per page; we follow next_page_token until done OR until we hit
// MAX_CONTRACTS contracts that are near-money + near-expiry. The early-stop
// is critical — major names (AAPL, SPY) have thousands of contracts.
async function fetchSnapshots(symbol, spot) {
  const { apiKey, secretKey } = getKeys();
  if (!apiKey || !secretKey) throw new Error('alpaca-keys-missing');
  const headers = { 'APCA-API-KEY-ID': apiKey, 'APCA-API-SECRET-KEY': secretKey };
  const today = new Date();
  const minStrike = spot * (1 - NEAR_MONEY_PCT);
  const maxStrike = spot * (1 + NEAR_MONEY_PCT);

  const kept = [];
  let pageToken = null;
  let pages = 0;
  do {
    const params = { feed: 'indicative', limit: 100 };
    if (pageToken) params.page_token = pageToken;
    const res = await axios.get(
      `${ALPACA_DATA}/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`,
      { headers, params, timeout: TIMEOUT_MS }
    );
    const snaps = res.data?.snapshots || {};
    for (const [occ, snap] of Object.entries(snaps)) {
      const meta = parseOcc(occ);
      if (!meta) continue;
      if (meta.strike < minStrike || meta.strike > maxStrike) continue;
      const dte = daysBetween(today, meta.expiry);
      if (dte < 0 || dte > MAX_DAYS_TO_EXPIRY) continue;
      const iv = Number(snap?.impliedVolatility ?? snap?.implied_volatility);
      const oi = Number(snap?.openInterest ?? snap?.open_interest ?? 0);
      // Volume — Alpaca surfaces it on either dailyBar or latestTrade depending
      // on contract liquidity; take whichever we get and treat missing as 0.
      const vol = Number(snap?.dailyBar?.v ?? snap?.daily_bar?.v ?? snap?.latestTrade?.s ?? 0);
      kept.push({ occ, ...meta, dte,
                  iv: Number.isFinite(iv) ? iv : null,
                  oi: Number.isFinite(oi) ? oi : 0,
                  vol: Number.isFinite(vol) ? vol : 0 });
      if (kept.length >= MAX_CONTRACTS) break;
    }
    // Stop paginating once we've filled the contract budget — must be checked
    // BEFORE reading next_page_token, otherwise the early-stop is silently
    // overwritten and we keep walking the chain.
    if (kept.length >= MAX_CONTRACTS) break;
    pageToken = res.data?.next_page_token || null;
    pages += 1;
    if (pages >= 8) break; // hard ceiling
  } while (pageToken);
  return kept;
}

// Compute headline metrics from the kept contract list.
function analyzeContracts(contracts, spot) {
  if (!contracts.length) {
    return { ok: false, reason: 'no-contracts',
             pcVolRatio: null, pcOiRatio: null, ivAvg: null, ivSkew: null, unusual: [] };
  }
  let callVol = 0, putVol = 0, callOi = 0, putOi = 0;
  for (const c of contracts) {
    if (c.type === 'call') { callVol += c.vol; callOi += c.oi; }
    else                   { putVol  += c.vol; putOi  += c.oi; }
  }
  // PCR — null when denominator is zero so callers can render "n/a" cleanly.
  const pcVolRatio = callVol > 0 ? +(putVol / callVol).toFixed(2) : null;
  const pcOiRatio  = callOi > 0  ? +(putOi  / callOi ).toFixed(2) : null;

  // ATM IV — average IV of the contracts whose strike is within 2.5% of spot,
  // weighted equally between calls + puts to dampen single-side outliers.
  const atmBand = spot * 0.025;
  const atm = contracts.filter(c => Math.abs(c.strike - spot) <= atmBand && c.iv != null);
  const ivAvg = atm.length
    ? +(atm.reduce((s, c) => s + c.iv, 0) / atm.length).toFixed(4)
    : null;

  // Skew — OTM put IV − OTM call IV at ~5% out of the money on the nearest
  // expiry. Positive skew = puts richer than calls = downside fear.
  const nearestExp = contracts.reduce((min, c) => c.dte < min ? c.dte : min, Infinity);
  const targetPutStrike  = spot * 0.95;
  const targetCallStrike = spot * 1.05;
  const nearestPut  = contracts
    .filter(c => c.type === 'put'  && c.dte === nearestExp && c.iv != null)
    .reduce((best, c) => !best || Math.abs(c.strike - targetPutStrike)  < Math.abs(best.strike - targetPutStrike)  ? c : best, null);
  const nearestCall = contracts
    .filter(c => c.type === 'call' && c.dte === nearestExp && c.iv != null)
    .reduce((best, c) => !best || Math.abs(c.strike - targetCallStrike) < Math.abs(best.strike - targetCallStrike) ? c : best, null);
  const ivSkew = (nearestPut && nearestCall) ? +(nearestPut.iv - nearestCall.iv).toFixed(4) : null;

  // Unusual flow detection — sweep proxy (vol/OI ≥ 2 AND vol ≥ 100) and
  // block proxy (vol ≥ 1000). Cap at 5 to keep the prompt tight.
  const unusual = contracts
    .map(c => {
      const ratio = c.oi > 0 ? +(c.vol / c.oi).toFixed(2) : null;
      const isSweep = ratio != null && ratio >= UNUSUAL_VOL_OI_RATIO && c.vol >= UNUSUAL_VOL_FLOOR;
      const isBlock = c.vol >= BLOCK_VOL_FLOOR;
      if (!isSweep && !isBlock) return null;
      return { occ: c.occ, type: c.type, strike: c.strike, expiry: c.expiryStr,
               vol: c.vol, oi: c.oi, volOiRatio: ratio,
               kind: isBlock ? 'block' : 'sweep' };
    })
    .filter(Boolean)
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 5);

  // ---- Data Depth additions ----------------------------------------------
  // IV term structure — bin contracts by DTE buckets, compute avg ATM IV per
  // bucket. Slope = back-month IV − front-month IV. Positive (contango) is
  // normal; sharply negative (backwardation) signals near-term fear / event.
  const dteBuckets = { front: { lo: 0,  hi: 7,  ivs: [] },   // 0-7 d
                       mid:   { lo: 8,  hi: 30, ivs: [] },   // 8-30 d
                       back:  { lo: 31, hi: 60, ivs: [] } }; // 31-60 d
  for (const c of contracts) {
    if (c.iv == null || Math.abs(c.strike - spot) > spot * 0.025) continue;
    for (const b of Object.values(dteBuckets)) {
      if (c.dte >= b.lo && c.dte <= b.hi) { b.ivs.push(c.iv); break; }
    }
  }
  const bucketAvg = b => b.ivs.length ? +(b.ivs.reduce((s, x) => s + x, 0) / b.ivs.length).toFixed(4) : null;
  const ivFront = bucketAvg(dteBuckets.front);
  const ivMid   = bucketAvg(dteBuckets.mid);
  const ivBack  = bucketAvg(dteBuckets.back);
  // Term-structure slope: back − front; null when either end missing.
  const ivTermSlope = (ivFront != null && ivBack != null)
    ? +(ivBack - ivFront).toFixed(4)
    : null;
  const ivTermLabel = ivTermSlope == null ? 'n/a'
    : ivTermSlope <= -0.02 ? 'backwardation (near-term fear/event)'
    : ivTermSlope <= 0.005 ? 'flat'
    : ivTermSlope >= 0.04 ? 'steep contango (calm front)'
    : 'normal contango';

  // Gamma exposure proxy — Σ (sign × OI × strike-proximity weight). Sign
  // = +1 for calls (dealers typically short), -1 for puts. Proximity weight
  // = max(0, 1 - |strike-spot|/(0.10*spot)) so only ±10%-of-spot strikes
  // matter. Positive ⇒ dealers net-long gamma ⇒ they sell rallies / buy
  // dips ⇒ chop/pinning likely. Negative ⇒ short gamma ⇒ they amplify
  // moves ⇒ trend-day risk. Pure proxy — no Greeks pulled.
  let gex = 0;
  for (const c of contracts) {
    const prox = Math.max(0, 1 - Math.abs(c.strike - spot) / (spot * 0.10));
    if (prox <= 0) continue;
    const sign = c.type === 'call' ? +1 : -1;
    gex += sign * c.oi * prox;
  }
  const gammaExposureProxy = +gex.toFixed(0);
  const gexLabel = Math.abs(gammaExposureProxy) < 1000 ? 'flat'
                 : gammaExposureProxy > 0  ? (gammaExposureProxy > 10000 ? 'strong long-gamma (pin/chop bias)' : 'long-gamma (mild pinning)')
                                           : (gammaExposureProxy < -10000 ? 'strong short-gamma (trend-day risk)' : 'short-gamma (move-amplifying)');

  return { ok: true, contracts: contracts.length,
           callVol, putVol, callOi, putOi,
           pcVolRatio, pcOiRatio, ivAvg, ivSkew, unusual,
           ivFront, ivMid, ivBack, ivTermSlope, ivTermLabel,
           gammaExposureProxy, gexLabel };
}

// IV-history persistence + rank computation. Best-effort — failures swallow.
async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS iv_history (
      symbol      TEXT NOT NULL,
      as_of_date  DATE NOT NULL,
      iv_avg      DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (symbol, as_of_date)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS iv_history_symbol_date_idx ON iv_history (symbol, as_of_date DESC)`);
  // Data Depth: rolling P/C-vol-ratio history for percentile ranking.
  await db.query(`
    CREATE TABLE IF NOT EXISTS pcr_history (
      symbol      TEXT NOT NULL,
      as_of_date  DATE NOT NULL,
      pcr_vol     DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (symbol, as_of_date)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS pcr_history_symbol_date_idx ON pcr_history (symbol, as_of_date DESC)`);
}

async function persistPcr(symbol, pcrVol) {
  if (pcrVol == null) return;
  await db.query(`
    INSERT INTO pcr_history (symbol, as_of_date, pcr_vol)
    VALUES ($1, CURRENT_DATE, $2::float8)
    ON CONFLICT (symbol, as_of_date) DO UPDATE SET pcr_vol = EXCLUDED.pcr_vol
  `, [symbol, pcrVol]);
}

// 60-trading-day rolling percentile rank. 100 = today's PCR is the highest
// in the window (extreme bearish positioning), 0 = lowest (extreme bullish).
async function computePcrRank(symbol, pcrToday) {
  if (pcrToday == null) return { pcrRank: null, samples: 0 };
  const { rows } = await db.query(`
    SELECT MIN(pcr_vol)::float8 AS lo, MAX(pcr_vol)::float8 AS hi, COUNT(*)::int AS n
    FROM (
      SELECT pcr_vol FROM pcr_history WHERE symbol = $1
      ORDER BY as_of_date DESC LIMIT 60
    ) recent
  `, [symbol]);
  const r = rows[0];
  if (!r || !r.n || r.n < 5 || r.hi == null || r.lo == null || r.hi - r.lo < 1e-6) {
    return { pcrRank: null, samples: r?.n || 0 };
  }
  const rank = ((pcrToday - r.lo) / (r.hi - r.lo)) * 100;
  return { pcrRank: +Math.max(0, Math.min(100, rank)).toFixed(1), samples: r.n };
}

async function persistIv(symbol, ivAvg) {
  if (ivAvg == null) return;
  try {
    await db.query(`
      INSERT INTO iv_history (symbol, as_of_date, iv_avg)
      VALUES ($1, CURRENT_DATE, $2::float8)
      ON CONFLICT (symbol, as_of_date) DO UPDATE SET iv_avg = EXCLUDED.iv_avg
    `, [symbol, ivAvg]);
  } catch (e) { console.warn('[OptFlow] persistIv failed:', e.message); }
}

async function computeIvRank(symbol, ivAvg) {
  if (ivAvg == null) return { ivRank: null, samples: 0 };
  try {
    // True rolling 252 *trading-day* window — take the most recent 252 stored
    // observations regardless of calendar gaps (weekends, holidays). Filtering
    // by CURRENT_DATE - 252 would only ever yield ~180 sessions.
    const { rows } = await db.query(`
      SELECT MIN(iv_avg)::float8 AS lo, MAX(iv_avg)::float8 AS hi, COUNT(*)::int AS n
      FROM (
        SELECT iv_avg FROM iv_history WHERE symbol = $1
        ORDER BY as_of_date DESC LIMIT $2
      ) recent
    `, [symbol, IV_RANK_WINDOW_DAYS]);
    const r = rows[0];
    if (!r || !r.n || r.n < 5 || r.hi == null || r.lo == null || r.hi - r.lo < 1e-6) {
      return { ivRank: null, samples: r?.n || 0 };
    }
    const rank = ((ivAvg - r.lo) / (r.hi - r.lo)) * 100;
    return { ivRank: +Math.max(0, Math.min(100, rank)).toFixed(1), samples: r.n };
  } catch (e) {
    console.warn('[OptFlow] computeIvRank failed:', e.message);
    return { ivRank: null, samples: 0 };
  }
}

// Public: get-or-refresh per symbol with TTL cache + in-flight dedup.
async function getOrRefresh(symbol, spotPrice) {
  const cached = _cache.get(symbol);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;
  if (_inflight.has(symbol)) return _inflight.get(symbol);
  const p = (async () => {
    const data = await refresh(symbol, spotPrice).catch(e => ({
      symbol, ok: false, reason: e.message?.slice(0, 120) || 'error',
    }));
    return data;
  })();
  _inflight.set(symbol, p);
  try { return await p; } finally { _inflight.delete(symbol); }
}

async function refresh(symbol, spotPrice) {
  if (!isConfigured()) return { symbol, ok: false, reason: 'no-keys' };
  const spot = Number(spotPrice);
  if (!Number.isFinite(spot) || spot <= 0) return { symbol, ok: false, reason: 'no-spot' };
  const contracts = await fetchSnapshots(symbol, spot);
  const m = analyzeContracts(contracts, spot);
  let ivRank = null, samples = 0;
  if (m.ivAvg != null) {
    await ensureSchema();
    await persistIv(symbol, m.ivAvg);
    ({ ivRank, samples } = await computeIvRank(symbol, m.ivAvg));
  }
  // Persist + rank the put/call vol ratio over a rolling 60-day window so we
  // can flag *historical* extremes (today's PCR vs its own recent range)
  // rather than just absolute thresholds. Best-effort, swallow on failure.
  let pcrRank = null, pcrSamples = 0;
  if (m.pcVolRatio != null) {
    try {
      await persistPcr(symbol, m.pcVolRatio);
      ({ pcrRank, samples: pcrSamples } = await computePcrRank(symbol, m.pcVolRatio));
    } catch (_) {}
  }
  const data = { symbol, ok: m.ok, ts: Date.now(), spot,
                 contracts: m.contracts || 0,
                 callVol: m.callVol, putVol: m.putVol,
                 callOi: m.callOi, putOi: m.putOi,
                 pcVolRatio: m.pcVolRatio, pcOiRatio: m.pcOiRatio,
                 ivAvg: m.ivAvg, ivRank, ivRankSamples: samples,
                 ivSkew: m.ivSkew, unusual: m.unusual || [],
                 ivFront: m.ivFront, ivMid: m.ivMid, ivBack: m.ivBack,
                 ivTermSlope: m.ivTermSlope, ivTermLabel: m.ivTermLabel,
                 gammaExposureProxy: m.gammaExposureProxy, gexLabel: m.gexLabel,
                 pcrRank, pcrSamples };
  _cache.set(symbol, { ts: Date.now(), data });
  return data;
}

async function refreshBatch(symbols, spotLookup = {}) {
  const out = {};
  for (const s of symbols) {
    const spot = spotLookup[s];
    try { out[s] = await refresh(s, spot); }
    catch (e) { out[s] = { symbol: s, ok: false, reason: e.message?.slice(0, 120) }; }
  }
  return out;
}

// TTL-enforced read. Returns null on miss OR when the entry is older than
// TTL_MS — that way a refresh outage can't keep stale data flowing into LLM
// prompts indefinitely. Callers wanting raw cached data (e.g. introspection
// endpoints showing "last known") can use getCachedRaw.
function getCached(symbol) {
  const c = _cache.get(symbol);
  if (!c) return null;
  if (Date.now() - c.ts >= TTL_MS) return null;
  return c.data;
}
function getCachedRaw(symbol) {
  const c = _cache.get(symbol);
  return c ? { ...c.data, _ageMs: Date.now() - c.ts, _stale: Date.now() - c.ts >= TTL_MS } : null;
}

// Compact 1–4 line prompt block. Returns null when nothing meaningful to say.
// Designed to fit naturally alongside the existing optionsActivity (Grok) line.
function renderForPrompt(d) {
  if (!d || !d.ok) return null;
  const parts = [];
  const pcr = d.pcVolRatio != null
    ? `${d.pcVolRatio} vol` + (d.pcOiRatio != null ? ` / ${d.pcOiRatio} OI` : '')
    : 'n/a';
  const ivBits = [];
  if (d.ivAvg != null) ivBits.push(`ATM IV ${(d.ivAvg * 100).toFixed(1)}%`);
  if (d.ivRank != null) ivBits.push(`IVR ${d.ivRank.toFixed(0)}`);
  if (d.ivSkew != null) ivBits.push(`skew ${(d.ivSkew * 100).toFixed(1)}pp`);
  parts.push(`Options chain (${d.contracts} contracts): P/C ${pcr}` +
             (ivBits.length ? ` · ${ivBits.join(' · ')}` : ''));
  // Sentiment hint — informational, never directs the vote.
  if (d.pcVolRatio != null) {
    if (d.pcVolRatio >= 1.5)      parts.push('  Heavy put flow (P/C ≥ 1.5) — bearish hedging or downside speculation.');
    else if (d.pcVolRatio <= 0.5) parts.push('  Heavy call flow (P/C ≤ 0.5) — bullish positioning.');
  }
  if (d.ivRank != null) {
    if (d.ivRank >= 80)      parts.push('  IV rank ≥ 80 — options very rich vs 1y range; expect mean-reversion in vol.');
    else if (d.ivRank <= 20) parts.push('  IV rank ≤ 20 — options cheap vs 1y range; cheap protection / breakout setups.');
  }
  if (d.ivSkew != null && d.ivSkew >= 0.05) {
    parts.push('  Steep put skew — market pricing in tail-risk on the downside.');
  }
  if (d.unusual?.length) {
    const top = d.unusual.slice(0, 3).map(u =>
      `${u.kind} ${u.type} ${u.strike} exp ${u.expiry} (vol ${u.vol}${u.volOiRatio != null ? `, ${u.volOiRatio}× OI` : ''})`);
    parts.push(`  Unusual activity: ${top.join(' | ')}`);
  }
  // Data Depth: term structure + gamma exposure + PCR rank lines.
  const termBits = [];
  if (d.ivFront != null) termBits.push(`front ${(d.ivFront * 100).toFixed(1)}%`);
  if (d.ivMid   != null) termBits.push(`mid ${(d.ivMid * 100).toFixed(1)}%`);
  if (d.ivBack  != null) termBits.push(`back ${(d.ivBack * 100).toFixed(1)}%`);
  if (termBits.length && d.ivTermSlope != null) {
    parts.push(`  IV term structure: ${termBits.join(' / ')} → slope ${(d.ivTermSlope * 100).toFixed(1)}pp (${d.ivTermLabel}).`);
  }
  if (d.gammaExposureProxy != null && Math.abs(d.gammaExposureProxy) >= 1000) {
    parts.push(`  Dealer gamma proxy: ${d.gammaExposureProxy >= 0 ? '+' : ''}${d.gammaExposureProxy.toLocaleString()} (${d.gexLabel}).`);
  }
  if (d.pcrRank != null) {
    let pcrTag = '';
    if (d.pcrRank >= 90)      pcrTag = ' — 60-day extreme bearish positioning (potential contrarian setup)';
    else if (d.pcrRank <= 10) pcrTag = ' — 60-day extreme bullish positioning (frothiness warning)';
    parts.push(`  P/C rank: ${d.pcrRank.toFixed(0)}/100 over 60 sessions${pcrTag}.`);
  }
  return parts.join('\n');
}

module.exports = {
  ensureSchema, getOrRefresh, getCached, getCachedRaw, refresh, refreshBatch,
  renderForPrompt, computeIvRank, parseOcc, isConfigured,
};
