// Portfolio optimization — computes a pairwise correlation matrix from cached
// daily-bar history and surfaces a "would adding this position concentrate risk?"
// signal. Outputs: (a) prompt block for the LLM ensemble, (b) sizing multiplier
// in [0.5, 1.0] applied AFTER quorum/gate (it can ONLY shrink size, never grow).
const alpaca = require('./alpacaService');

const LOOKBACK_DAYS = 60;
const HIGH_CORR = 0.70;
const TTL_MS = 6 * 60 * 60 * 1000;  // refresh ≤ 6h

const _cache = new Map();   // symbol → { ts, returns: number[] }

async function getDailyReturns(symbol) {
  const cached = _cache.get(symbol);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.returns;
  try {
    const bars = await alpaca.getBars(symbol, '1Day', LOOKBACK_DAYS + 5);
    if (!Array.isArray(bars) || bars.length < 10) return null;
    const returns = [];
    for (let i = 1; i < bars.length; i++) {
      const p0 = parseFloat(bars[i - 1].c);
      const p1 = parseFloat(bars[i].c);
      if (p0 > 0 && p1 > 0) returns.push((p1 - p0) / p0);
    }
    _cache.set(symbol, { ts: Date.now(), returns });
    return returns;
  } catch {
    return null;
  }
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const ax = a.slice(-n), bx = b.slice(-n);
  const ma = ax.reduce((s, v) => s + v, 0) / n;
  const mb = bx.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = ax[i] - ma, xb = bx[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

async function buildMatrix(symbols) {
  const seriesEntries = await Promise.all(symbols.map(async s => [s, await getDailyReturns(s)]));
  const series = new Map(seriesEntries.filter(([, v]) => v));
  const validSyms = [...series.keys()];
  const matrix = {};
  let avg = 0, count = 0, maxPair = null;
  for (let i = 0; i < validSyms.length; i++) {
    matrix[validSyms[i]] = {};
    for (let j = 0; j < validSyms.length; j++) {
      if (i === j) { matrix[validSyms[i]][validSyms[j]] = 1; continue; }
      const r = pearson(series.get(validSyms[i]), series.get(validSyms[j])) ?? 0;
      matrix[validSyms[i]][validSyms[j]] = +r.toFixed(3);
      if (j > i) {
        avg += r; count += 1;
        if (!maxPair || Math.abs(r) > Math.abs(maxPair.r)) {
          maxPair = { a: validSyms[i], b: validSyms[j], r: +r.toFixed(3) };
        }
      }
    }
  }
  return { matrix, avgCorr: count ? +(avg / count).toFixed(3) : 0, maxPair, symbols: validSyms };
}

// Evaluate adding `candidate` to current `holdings`. Returns sizing multiplier
// in [0.5, 1.0] plus warnings. NEVER blocks (returns mult > 0).
async function evaluateAddition({ candidate, holdings }) {
  const heldSyms = (holdings || []).map(h => h.symbol).filter(s => s && s !== candidate);
  if (heldSyms.length === 0) return { sizeMult: 1.0, warnings: [], avgCorrAfter: 0 };
  const { matrix, avgCorr } = await buildMatrix([...heldSyms, candidate]);
  if (!matrix[candidate]) return { sizeMult: 1.0, warnings: [], avgCorrAfter: avgCorr };

  // Average correlation of CANDIDATE vs each existing holding.
  const corrs = heldSyms.map(s => matrix[candidate]?.[s]).filter(v => Number.isFinite(v));
  const candAvg = corrs.length ? corrs.reduce((s, v) => s + Math.abs(v), 0) / corrs.length : 0;

  let mult = 1.0;
  const warnings = [];
  if (candAvg >= HIGH_CORR) {
    mult = 0.6;
    warnings.push(`High correlation: ${candidate} avg |corr| ${candAvg.toFixed(2)} vs current book.`);
  } else if (candAvg >= 0.5) {
    mult = 0.8;
    warnings.push(`Elevated correlation: ${candidate} avg |corr| ${candAvg.toFixed(2)} vs current book.`);
  }
  // Concentration: if the candidate is the 5th+ holding and avg corr already hot.
  if (heldSyms.length >= 4 && avgCorr >= 0.6) {
    mult = Math.min(mult, 0.7);
    warnings.push(`Book already crowded: ${heldSyms.length} positions with avg corr ${avgCorr.toFixed(2)}.`);
  }

  return { sizeMult: +mult.toFixed(2), warnings, avgCorrAfter: avgCorr, candidateAvgCorr: +candAvg.toFixed(2) };
}

async function getPromptBlock({ candidate, holdings }) {
  if (!candidate || !holdings?.length) return null;
  try {
    const r = await evaluateAddition({ candidate, holdings });
    if (!r.warnings.length && r.candidateAvgCorr < 0.4) return null;
    return `Portfolio risk: candidate ${candidate} avg |corr| with ${holdings.length} existing holdings = ${r.candidateAvgCorr ?? 0}; book avg ${r.avgCorrAfter}. ${r.warnings.join(' ')}`;
  } catch { return null; }
}

async function getPortfolioSnapshot(symbols) {
  if (!symbols?.length) return { symbols: [], avgCorr: 0, maxPair: null };
  return buildMatrix(symbols);
}

module.exports = { evaluateAddition, getPromptBlock, getPortfolioSnapshot };
