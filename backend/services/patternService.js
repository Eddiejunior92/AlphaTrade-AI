// Pure-JS technical pattern analysis for the longer-hold (swing) strategy.
// Operates on a series of OHLC bars and returns a structured object describing
// trend strength, swing points, support/resistance, and breakout state. The
// LLM ensemble consumes this as one of several inputs — it does NOT make
// trading decisions on its own.

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Slope (per bar) of a linear regression over the last N closes, normalized to
// percent of the mean price so it's comparable across symbols.
function slopePctPerBar(closes, period) {
  if (closes.length < period) return 0;
  const y = closes.slice(-period);
  const n = y.length;
  const xMean = (n - 1) / 2;
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - xMean) * (y[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return yMean === 0 ? 0 : (slope / yMean) * 100;
}

// Find local pivots: a high is a pivot if it's the max in a +/- `lookaround`
// window; same for lows. Returns arrays of {idx, price}.
function findPivots(bars, lookaround = 3) {
  const highs = [], lows = [];
  for (let i = lookaround; i < bars.length - lookaround; i += 1) {
    let isHigh = true, isLow = true;
    for (let j = i - lookaround; j <= i + lookaround; j += 1) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, price: bars[i].h });
    if (isLow)  lows.push({  idx: i, price: bars[i].l });
  }
  return { highs, lows };
}

// Cluster nearby pivot prices into S/R levels. Two prices are in the same
// cluster if within `tolerancePct` of each other.
function clusterLevels(pivots, tolerancePct = 0.0075) {
  if (!pivots.length) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = current[current.length - 1].price;
    if (Math.abs(sorted[i].price - last) / last <= tolerancePct) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);
  return clusters
    .map(c => ({
      price: +(c.reduce((a, b) => a + b.price, 0) / c.length).toFixed(2),
      touches: c.length,
      lastIdx: Math.max(...c.map(p => p.idx)),
    }))
    .sort((a, b) => b.touches - a.touches);
}

function describeTrend(slopePct) {
  const abs = Math.abs(slopePct);
  if (abs < 0.05) return 'sideways';
  const dir = slopePct > 0 ? 'up' : 'down';
  if (abs < 0.15) return `weak ${dir}trend`;
  if (abs < 0.4)  return `moderate ${dir}trend`;
  return `strong ${dir}trend`;
}

// Main entry: returns a compact object the LLM can read directly.
function analyzePatterns(bars) {
  if (!Array.isArray(bars) || bars.length < 20) {
    return { ok: false, reason: 'Insufficient bars for pattern analysis (need ≥20)' };
  }

  const closes = bars.map(b => b.c);
  const last = closes[closes.length - 1];

  // Trend strength via 20-bar regression slope
  const slope20 = slopePctPerBar(closes, 20);
  const trend = describeTrend(slope20);

  // Moving averages
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, Math.min(50, closes.length));
  const above20 = sma20 != null && last > sma20;
  const above50 = sma50 != null && last > sma50;

  // Pivots → higher highs / higher lows analysis on the most recent 4 swing pts
  const { highs, lows } = findPivots(bars, 3);
  const recentHighs = highs.slice(-4);
  const recentLows = lows.slice(-4);
  const higherHighs = recentHighs.length >= 2 &&
    recentHighs.every((p, i, a) => i === 0 || p.price > a[i - 1].price);
  const higherLows = recentLows.length >= 2 &&
    recentLows.every((p, i, a) => i === 0 || p.price > a[i - 1].price);
  const lowerHighs = recentHighs.length >= 2 &&
    recentHighs.every((p, i, a) => i === 0 || p.price < a[i - 1].price);
  const lowerLows = recentLows.length >= 2 &&
    recentLows.every((p, i, a) => i === 0 || p.price < a[i - 1].price);

  // Support / resistance — strongest 3 of each from clustered pivots
  const supports    = clusterLevels(lows, 0.0075).slice(0, 3);
  const resistances = clusterLevels(highs, 0.0075).slice(0, 3);

  // Breakout: close > prior 20-bar high (excluding latest bar) by ≥ 0.25%
  const lookN = Math.min(20, bars.length - 1);
  const priorHigh = Math.max(...bars.slice(-lookN - 1, -1).map(b => b.h));
  const priorLow  = Math.min(...bars.slice(-lookN - 1, -1).map(b => b.l));
  let breakout = 'none';
  if (last > priorHigh * 1.0025) breakout = 'bullish breakout above 20-bar high';
  else if (last < priorLow * 0.9975) breakout = 'bearish breakdown below 20-bar low';

  // Distance to nearest support/resistance for risk framing.
  // NOTE: `supports`/`resistances` above are ranked by touch-count (strength),
  // which is NOT the same as nearest-by-distance. Pick the nearest level on
  // each side independently from ALL clustered levels.
  const allSupports    = clusterLevels(lows,  0.0075);
  const allResistances = clusterLevels(highs, 0.0075);
  const nearestSupport = allSupports
    .filter(s => s.price < last)
    .sort((a, b) => b.price - a.price)[0] || null;       // highest price still < last
  const nearestResistance = allResistances
    .filter(r => r.price > last)
    .sort((a, b) => a.price - b.price)[0] || null;       // lowest price still > last
  const supportDistPct = nearestSupport
    ? +(((last - nearestSupport.price) / last) * 100).toFixed(2) : null;
  const resistanceDistPct = nearestResistance
    ? +(((nearestResistance.price - last) / last) * 100).toFixed(2) : null;

  return {
    ok: true,
    trend,
    slopePctPerBar: +slope20.toFixed(3),
    sma20: sma20 ? +sma20.toFixed(2) : null,
    sma50: sma50 ? +sma50.toFixed(2) : null,
    aboveSma20: above20,
    aboveSma50: above50,
    structure: {
      higherHighs, higherLows, lowerHighs, lowerLows,
      recentHighs: recentHighs.map(p => +p.price.toFixed(2)),
      recentLows: recentLows.map(p => +p.price.toFixed(2)),
    },
    supports: supports.map(s => ({ price: s.price, touches: s.touches })),
    resistances: resistances.map(r => ({ price: r.price, touches: r.touches })),
    nearestSupport: nearestSupport ? { price: nearestSupport.price, distPct: supportDistPct } : null,
    nearestResistance: nearestResistance ? { price: nearestResistance.price, distPct: resistanceDistPct } : null,
    breakout,
  };
}

module.exports = { analyzePatterns };
