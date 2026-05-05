// Order-flow proxy v3 — deeper microstructure read computed from the bars we
// already fetched (no extra API calls, no extra cost). Surfaces:
//   • Volume surge ratio (recent 5 vs prior 20 baseline) and signed direction
//   • VWAP and price deviation from VWAP (intraday institutional reference)
//   • Large-print bars in the recent window (>3× avg single-bar volume)
//   • Sustained pressure — consecutive same-direction bars with above-avg vol
//   • Close-vs-range pressure proxy (where each bar closed within its H-L)
//   • Cumulative delta (signed-volume sum) over the last 20 bars + slope
//     [v3 / Data Depth] — running buy minus sell volume; slope shows
//     whether smart-money is accumulating or distributing right now.
//   • Confirmed sweep detection — a large-print bar PLUS a same-direction
//     price extension > 0.3% within ±2 bars. Filters out lone block prints
//     that don't actually move the tape (true sweeps walk the book).
//   • VPIN-lite toxicity proxy — 5-bucket volume-bucketed |buy-sell| /
//     total over the last 20 bars; high values flag adverse-selection /
//     informed-trader regimes where vol bid is rising.
// All informational. The LLM ensemble consumes the prompt block; quorum and
// the 75-85% confidence gate remain the sole arbiters of execution.

function safeNum(x, fallback = 0) {
  const n = +x;
  return Number.isFinite(n) ? n : fallback;
}

function computeVwap(bars) {
  let pv = 0, vv = 0;
  for (const b of bars) {
    const h = safeNum(b.h), l = safeNum(b.l), c = safeNum(b.c), v = safeNum(b.v);
    if (v <= 0) continue;
    const typical = (h + l + c) / 3;
    pv += typical * v;
    vv += v;
  }
  if (vv <= 0) return null;
  return pv / vv;
}

// Pressure proxy: where the close sits inside the bar's high-low range,
// weighted by volume. Sums to a single signed score over the window.
// +1 means closes near highs on heavy volume (buying), -1 near lows (selling).
function pressureScore(bars) {
  let num = 0, den = 0;
  for (const b of bars) {
    const h = safeNum(b.h), l = safeNum(b.l), c = safeNum(b.c), v = safeNum(b.v);
    const range = h - l;
    if (range <= 0 || v <= 0) continue;
    const pos = (c - l) / range;       // 0 = bar low, 1 = bar high
    num += (pos - 0.5) * 2 * v;        // map to [-1, +1] then weight by vol
    den += v;
  }
  if (den <= 0) return 0;
  return +(num / den).toFixed(2);
}

function analyzeOrderFlow(bars) {
  if (!Array.isArray(bars) || bars.length < 25) {
    return { ok: false, reason: 'insufficient bars' };
  }
  const recent = bars.slice(-5);
  const baseline = bars.slice(-25, -5);
  const baseVolPerBar = baseline.reduce((s, b) => s + safeNum(b.v), 0) / Math.max(1, baseline.length);
  if (baseVolPerBar <= 0) return { ok: false, reason: 'no baseline volume' };

  // 1. Surge ratio + signed direction (legacy)
  let surgeVol = 0, signedMove = 0;
  for (const b of recent) {
    const v = safeNum(b.v);
    surgeVol += v;
    const o = safeNum(b.o), c = safeNum(b.c);
    if (o > 0) signedMove += ((c - o) / o) * v;
  }
  const surgeRatio = +(surgeVol / (baseVolPerBar * recent.length)).toFixed(2);
  const direction = signedMove > 0 ? 'buy_pressure' : signedMove < 0 ? 'sell_pressure' : 'neutral';
  let surgeLabel = 'normal';
  if (surgeRatio >= 3) surgeLabel = 'extreme_surge';
  else if (surgeRatio >= 2) surgeLabel = 'surge';
  else if (surgeRatio >= 1.5) surgeLabel = 'elevated';

  // 2. Large-print bars in the recent window — single bars with volume
  //    ≥ 3× the per-bar baseline. Often signals block prints / sweeps.
  const largePrints = recent
    .map((b, i) => ({ i, ratio: safeNum(b.v) / baseVolPerBar, side: safeNum(b.c) >= safeNum(b.o) ? 'up' : 'down' }))
    .filter(x => x.ratio >= 3);

  // 3. VWAP + price deviation from VWAP (whole-window)
  const vwap = computeVwap(bars);
  const last = safeNum(bars[bars.length - 1].c);
  const vwapDevPct = vwap ? +(((last - vwap) / vwap) * 100).toFixed(2) : null;
  let vwapState = 'n/a';
  if (vwap != null && vwapDevPct != null) {
    if (Math.abs(vwapDevPct) < 0.05) vwapState = 'at vwap';
    else if (vwapDevPct > 0.5) vwapState = 'extended above vwap';
    else if (vwapDevPct > 0) vwapState = 'above vwap';
    else if (vwapDevPct < -0.5) vwapState = 'extended below vwap';
    else vwapState = 'below vwap';
  }

  // 4. Sustained pressure — count of trailing consecutive bars on the same
  //    side with above-average volume (≥ 1.2× baseline). Indicates that the
  //    surge isn't a one-bar pop.
  let sustainedBars = 0, sustainedSide = null;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const b = recent[i];
    const v = safeNum(b.v);
    const side = safeNum(b.c) >= safeNum(b.o) ? 'up' : 'down';
    if (v < baseVolPerBar * 1.2) break;
    if (sustainedSide && side !== sustainedSide) break;
    sustainedSide = side;
    sustainedBars += 1;
  }

  // 5. Close-vs-range pressure score across the recent window.
  const press = pressureScore(recent);

  // 6. Cumulative delta (signed-volume sum) over the last 20 bars + slope.
  //    Sign per bar = sign(close - open); magnitude = bar volume. Slope is
  //    last-5 average delta vs prior-15 — positive = recent accumulation.
  //    Captures stealth accumulation/distribution that volume alone misses.
  const cdWindow = bars.slice(-20);
  const cdSeries = cdWindow.map(b => {
    const v = safeNum(b.v); const o = safeNum(b.o); const c = safeNum(b.c);
    if (v <= 0 || o <= 0) return 0;
    return c >= o ? v : -v;
  });
  const cumDelta = cdSeries.reduce((s, x) => s + x, 0);
  const recentCd = cdSeries.slice(-5).reduce((s, x) => s + x, 0) / 5;
  const priorCd  = cdSeries.slice(0, -5).reduce((s, x) => s + x, 0) / Math.max(1, cdSeries.length - 5);
  const cdSlope  = +(recentCd - priorCd).toFixed(0);
  const cdLabel  = cumDelta > 0 && cdSlope > 0 ? 'accumulating'
                 : cumDelta < 0 && cdSlope < 0 ? 'distributing'
                 : Math.abs(cdSlope) > Math.abs(cumDelta) * 0.5 ? 'reversing'
                 : 'balanced';

  // 7. Confirmed sweep detection — large print + same-direction price
  //    extension > 0.3% measured FROM THE PRINT BAR (open) to the close of
  //    bars +1..+2 ahead. Anchoring at the print bar (instead of the full
  //    ±2 span) avoids attributing pre-print drift to the sweep itself, so
  //    we only flag the cases where the large print actually walked the
  //    book. Real sweeps move the tape; lone block prints (paint-the-tape)
  //    don't and stay filtered out.
  const confirmedSweeps = [];
  for (const lp of largePrints) {
    const idxAbs = bars.length - recent.length + lp.i;
    const printBar = bars[idxAbs];
    if (!printBar) continue;
    const anchor = safeNum(printBar.o);
    if (anchor <= 0) continue;
    // Examine the print bar itself and the next 1-2 bars (forward extension).
    // We don't look backwards: those moves happened BEFORE the large print.
    let bestMovePct = 0;
    for (let k = 0; k <= 2; k++) {
      const j = idxAbs + k;
      if (j > bars.length - 1) break;
      const c = safeNum(bars[j].c);
      const m = ((c - anchor) / anchor) * 100;
      if (Math.abs(m) > Math.abs(bestMovePct)) bestMovePct = m;
    }
    const sameDir = (lp.side === 'up' && bestMovePct > 0.3) || (lp.side === 'down' && bestMovePct < -0.3);
    if (sameDir) {
      confirmedSweeps.push({ ratio: lp.ratio, side: lp.side, movePct: +bestMovePct.toFixed(2) });
    }
  }

  // 8. VPIN-lite toxicity proxy. Bucket the last 20 bars into 5 equal-bar
  //    buckets, compute net buy/sell imbalance per bucket as a fraction of
  //    bucket volume, and average. High values (≥ 0.45) ⇒ informed-trader
  //    regime / adverse selection / vol risk rising. Bounded [0, 1].
  const vpinBuckets = 5;
  const vpinBars = bars.slice(-20);
  const bucketSize = Math.floor(vpinBars.length / vpinBuckets);
  let vpinSum = 0, vpinN = 0;
  if (bucketSize >= 2) {
    for (let i = 0; i < vpinBuckets; i++) {
      const slice = vpinBars.slice(i * bucketSize, (i + 1) * bucketSize);
      let buy = 0, sell = 0;
      for (const b of slice) {
        const v = safeNum(b.v); const o = safeNum(b.o); const c = safeNum(b.c);
        if (v <= 0 || o <= 0) continue;
        if (c >= o) buy += v; else sell += v;
      }
      const tot = buy + sell;
      if (tot > 0) { vpinSum += Math.abs(buy - sell) / tot; vpinN += 1; }
    }
  }
  const vpin = vpinN > 0 ? +(vpinSum / vpinN).toFixed(2) : null;
  const vpinLabel = vpin == null ? 'n/a'
                  : vpin >= 0.6 ? 'high (toxic flow)'
                  : vpin >= 0.45 ? 'elevated (informed-trader bias)'
                  : vpin >= 0.25 ? 'normal'
                  : 'two-sided';

  // Compose a single-line description that nests well into the prompt.
  // We always emit something when ok=true so the LLM sees the VWAP context
  // even on quiet bars (helps with "is this a vwap reclaim?" reads).
  const parts = [];
  if (surgeLabel !== 'normal') {
    parts.push(`${surgeLabel.replace('_', ' ')} (${surgeRatio}× baseline vol, ${direction.replace('_', ' ')})`);
  } else {
    parts.push(`vol normal (${surgeRatio}× baseline)`);
  }
  if (largePrints.length) {
    const tag = largePrints.map(p => `${p.ratio.toFixed(1)}×${p.side === 'up' ? '↑' : '↓'}`).join(' ');
    parts.push(`large prints: ${tag}`);
  }
  if (sustainedBars >= 2) {
    parts.push(`sustained ${sustainedSide === 'up' ? 'buying' : 'selling'} ${sustainedBars} bars`);
  }
  if (vwap != null) {
    parts.push(`vwap $${vwap.toFixed(2)} (${vwapState}, ${vwapDevPct >= 0 ? '+' : ''}${vwapDevPct}%)`);
  }
  parts.push(`close-in-range bias ${press >= 0 ? '+' : ''}${press}`);
  // v3 / Data Depth additions — kept on the same single-line block so we
  // don't blow up the prompt budget. Only emitted when meaningful.
  parts.push(`cum-delta ${cumDelta >= 0 ? '+' : ''}${cumDelta.toFixed(0)} (${cdLabel})`);
  if (confirmedSweeps.length) {
    const tag = confirmedSweeps.slice(0, 3).map(s => `${s.ratio.toFixed(1)}×${s.side === 'up' ? '↑' : '↓'}${s.movePct >= 0 ? '+' : ''}${s.movePct}%`).join(' ');
    parts.push(`confirmed sweeps: ${tag}`);
  }
  if (vpin != null && vpin >= 0.3) parts.push(`VPIN ${vpin.toFixed(2)} ${vpinLabel}`);

  return {
    ok: true,
    surgeLabel, surgeRatio, direction,
    vwap: vwap != null ? +vwap.toFixed(2) : null,
    vwapDevPct, vwapState,
    largePrints,
    sustainedBars, sustainedSide,
    pressureScore: press,
    cumDelta: +cumDelta.toFixed(0),
    cumDeltaSlope: cdSlope,
    cumDeltaLabel: cdLabel,
    confirmedSweeps,
    vpin, vpinLabel,
    description: `Order flow: ${parts.join(' · ')}.`,
  };
}

module.exports = { analyzeOrderFlow };
