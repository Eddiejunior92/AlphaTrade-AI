// Self-Play Scenario Simulation Layer.
//
// Fast Monte-Carlo path generator that fuses every forward-looking signal
// the agent already has — recent price action, ATR-based realized vol,
// implied vol from the options chain, current regime classification, the
// macro-forecast layer's regime call, and (lightly) historical-intelligence
// drift bias — into a probability-weighted outlook for the next 1-3 days.
//
// The output is rendered into a compact prompt block that gives every LLM
// a "here's what's plausible from where we sit" reference. It does NOT
// vote, doesn't size trades, doesn't gate anything. Quorum, the 85%
// confidence threshold, $100/day USD loss budget, 5% drawdown breaker,
// kill switch, no-averaging-in, and trailing-stop ratchet ALL retain full
// veto power. This layer is strictly informational.
//
// Engine: Geometric Brownian Motion in log-space, optionally with a
// jump-diffusion overlay during high-vol / rate-shock regimes (rare large
// moves). Pure JS — no external calls — so per-symbol per-cycle is cheap.
// Cached for ~3 min keyed on the last bar timestamp so the same minute's
// re-runs hit the cache.

const SIM_PATHS = parseInt(process.env.SIM_PATHS || '400');
const SIM_HORIZON_DAYS = 3;
const ANNUAL_TRADING_DAYS = 252;
const TTL_MS = 3 * 60 * 1000;
// Drift is *capped* — short-term slope can otherwise produce silly forward
// projections after a strong run-up. ±0.4% per day is already aggressive.
const MAX_DRIFT_PER_DAY = 0.004;

// Cache key includes the sim-shaping inputs (timeframe + strategy stops) so
// day vs swing strategies on the same symbol never share an entry — if they
// did, one strategy's cached P(stop hit) / P(target hit) would render with
// the OTHER strategy's stop/target, producing misleading numbers in the
// prompt block.
const _cache = new Map();   // cacheKey -> { ts, lastBarT, data }
function makeCacheKey(symbol, barsPerDay, stopLossPct, takeProfitPct) {
  return `${symbol}|${barsPerDay}|${stopLossPct}|${takeProfitPct}`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Box-Muller — one normal sample per call. Fast enough for 400 paths × 3 days.
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Daily realized vol from the last ~N bar log-returns. Falls back to ATR%
// when bars are too sparse.
function realizedVolPerBar(bars, n = 30) {
  if (!bars || bars.length < 5) return null;
  const closes = bars.map(b => b.c).filter(Number.isFinite);
  const window = closes.slice(-Math.min(closes.length, n + 1));
  const rets = [];
  for (let i = 1; i < window.length; i++) {
    const a = window[i - 1], b = window[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 4) return null;
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - m) * (x - m), 0) / rets.length;
  return Math.sqrt(v);
}

// Convert a per-bar vol estimate to per-trading-day. For 1-min day-strategy
// bars: ~390 bars/day. For 15-min swing bars: ~26 bars/day. Caller passes
// barsPerDay so we don't have to guess.
function volPerDay(volPerBar, barsPerDay) {
  if (volPerBar == null || !Number.isFinite(barsPerDay) || barsPerDay <= 0) return null;
  return volPerBar * Math.sqrt(barsPerDay);
}

// Short-term drift estimate: linear fit of the last N closes in log-space,
// expressed per trading-day. Capped to MAX_DRIFT_PER_DAY in either direction.
function shortTermDriftPerDay(bars, barsPerDay, lookback = 30) {
  if (!bars || bars.length < 8 || !Number.isFinite(barsPerDay)) return 0;
  const closes = bars.map(b => b.c).filter(c => Number.isFinite(c) && c > 0).slice(-lookback);
  if (closes.length < 5) return 0;
  // OLS slope of ln(close) vs bar index.
  const n = closes.length;
  const xs = Array.from({ length: n }, (_, i) => i);
  const ys = closes.map(c => Math.log(c));
  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) * (xs[i] - xMean);
  }
  const slopePerBar = den > 0 ? num / den : 0;
  const slopePerDay = slopePerBar * barsPerDay;
  return clamp(slopePerDay, -MAX_DRIFT_PER_DAY, MAX_DRIFT_PER_DAY);
}

// Regime + macro tilt — small additive nudges to drift, asymmetric:
// adverse regimes pull drift toward zero/negative more aggressively than
// constructive regimes lift it. This is intentional — overshooting
// optimism is the more dangerous failure mode.
function regimeDriftTilt(regime, macroRegime, macroForecastRegime) {
  let tilt = 0;
  // Local regime (per-symbol tape from regimeService).
  switch (regime?.primary) {
    case 'high_vol':       tilt -= 0.0010; break;
    case 'low_liquidity':  tilt -= 0.0005; break;
    case 'trending_up':    tilt += 0.0008; break;
    case 'trending_down':  tilt -= 0.0012; break;
    case 'mean_reverting': /* zero */     break;
    case 'news_driven':
      // Sign comes from sentiment if available.
      if (regime.tags?.includes('news_pos')) tilt += 0.0006;
      else if (regime.tags?.includes('news_neg')) tilt -= 0.0010;
      break;
    default: /* zero */ break;
  }
  // Macro regime (cross-asset, global).
  const adverseMacro = ['VOL_SPIKE', 'RATE_SHOCK', 'RISK_OFF', 'STAGFLATION'];
  const supportMacro = ['RISK_ON', 'GOLDILOCKS'];
  if (adverseMacro.includes(macroRegime)) tilt -= 0.0010;
  else if (supportMacro.includes(macroRegime)) tilt += 0.0005;
  if (adverseMacro.includes(macroForecastRegime)) tilt -= 0.0008;
  else if (supportMacro.includes(macroForecastRegime)) tilt += 0.0003;
  // Final cap so the tilt alone can't push drift past the daily cap.
  return clamp(tilt, -0.0030, 0.0015);
}

// Vol multiplier from regime — vol expands during stress, compresses during
// calm. Multiplier ∈ [0.8, 1.6] so a quiet tape doesn't get unrealistically
// dampened and a stressed tape gets bigger tails.
function regimeVolMult(regime, macroRegime, macroForecastRegime) {
  let m = 1.0;
  if (regime?.primary === 'high_vol') m *= 1.30;
  if (regime?.primary === 'low_liquidity') m *= 1.15;
  if (macroRegime === 'VOL_SPIKE' || macroForecastRegime === 'VOL_SPIKE') m *= 1.25;
  if (macroRegime === 'RATE_SHOCK' || macroForecastRegime === 'RATE_SHOCK') m *= 1.15;
  if (macroRegime === 'GOLDILOCKS') m *= 0.90;
  return clamp(m, 0.8, 1.6);
}

// Jump-diffusion intensity — only "on" during stress regimes. Each day has
// a small probability of a fat-tail jump (drawn from a Laplace-ish dist).
function jumpParams(regime, macroRegime, macroForecastRegime) {
  const stressed =
    regime?.primary === 'high_vol' ||
    macroRegime === 'VOL_SPIKE' || macroForecastRegime === 'VOL_SPIKE' ||
    macroRegime === 'RATE_SHOCK' || macroForecastRegime === 'RATE_SHOCK' ||
    macroRegime === 'RISK_OFF' || macroForecastRegime === 'RISK_OFF';
  if (!stressed) return { lambdaPerDay: 0, jumpScale: 0, jumpBias: 0 };
  // ~10% chance per day of a jump of order ±2-3% (Laplace tails).
  const adverse = macroRegime === 'RISK_OFF' || macroRegime === 'STAGFLATION' ||
                  macroForecastRegime === 'RISK_OFF' || macroForecastRegime === 'STAGFLATION';
  return { lambdaPerDay: 0.10, jumpScale: 0.020, jumpBias: adverse ? -0.005 : 0 };
}

// Public: simulate. Returns a probability-weighted outlook + a render-ready
// prompt block. NEVER throws — failures collapse to a null block so the
// agent loop is unaffected.
function simulate({ symbol, bars, indicators, regime, macroForecast, optionsFlow,
                    barsPerDay = 390, stopLossPct = 0.005, takeProfitPct = 0.01,
                    historicalDriftHint = 0 }) {
  try {
    if (!bars || bars.length < 8) return { ok: false, reason: 'insufficient-bars' };
    const lastBar = bars[bars.length - 1];
    const spot = lastBar?.c;
    if (!Number.isFinite(spot) || spot <= 0) return { ok: false, reason: 'no-spot' };

    // Cache hit — same last-bar timestamp + same shaping inputs (timeframe,
    // stops) ⇒ identical sim. Different strategies on the same symbol get
    // their own cache slot.
    const cacheKey = makeCacheKey(symbol, barsPerDay, stopLossPct, takeProfitPct);
    const cached = _cache.get(cacheKey);
    if (cached && cached.lastBarT === lastBar.t && Date.now() - cached.ts < TTL_MS) {
      return cached.data;
    }

    // --- Vol estimate -----------------------------------------------------
    // Blend three sources with adaptive weights:
    //   • realized per-bar → annualised → daily
    //   • ATR% (already daily-ish) → ATR is roughly 1× standard daily move
    //   • IV (annualised %) → daily by /sqrt(252), only when present
    const rPerBar = realizedVolPerBar(bars, 30);
    const realizedDaily = volPerDay(rPerBar, barsPerDay);            // decimal (e.g. 0.018)
    const atrPct = Number(indicators?.volatility?.atrPct);            // already %
    const atrDaily = Number.isFinite(atrPct) ? atrPct / 100 : null;   // → decimal
    // optionsFlow.ivAvg is annualised vol expressed as a fraction (0.28 = 28%)
    const ivAnnual = Number(optionsFlow?.ivAvg);
    const ivDaily = Number.isFinite(ivAnnual) ? ivAnnual / Math.sqrt(ANNUAL_TRADING_DAYS) : null;

    const candidates = [];
    if (realizedDaily != null) candidates.push({ v: realizedDaily, w: 1.0 });
    if (atrDaily != null)      candidates.push({ v: atrDaily,      w: 0.7 });
    if (ivDaily != null)       candidates.push({ v: ivDaily,       w: 1.2 }); // forward-looking, weight higher
    if (!candidates.length) return { ok: false, reason: 'no-vol-estimate' };
    const wSum = candidates.reduce((s, c) => s + c.w, 0);
    let sigmaDaily = candidates.reduce((s, c) => s + c.v * c.w, 0) / wSum;
    // Sanity floor + ceiling so a bad input doesn't blow up the sim.
    sigmaDaily = clamp(sigmaDaily, 0.003, 0.10);

    const macroRegime = macroForecast?.current?.regime || null;
    const macroForecastRegime = macroForecast?.forecast?.regime || null;
    sigmaDaily *= regimeVolMult(regime, macroRegime, macroForecastRegime);

    // --- Drift estimate ---------------------------------------------------
    let mu = shortTermDriftPerDay(bars, barsPerDay, 30);
    mu += regimeDriftTilt(regime, macroRegime, macroForecastRegime);
    // Historical-intelligence drift hint is a decimal per day, already small.
    if (Number.isFinite(historicalDriftHint)) mu += clamp(historicalDriftHint, -0.001, 0.001);
    mu = clamp(mu, -MAX_DRIFT_PER_DAY * 1.5, MAX_DRIFT_PER_DAY * 1.5);

    // --- Run paths --------------------------------------------------------
    const jumps = jumpParams(regime, macroRegime, macroForecastRegime);
    const days = SIM_HORIZON_DAYS;
    const N = SIM_PATHS;
    // GBM step in log-space: r = (μ - σ²/2)·dt + σ·√dt·Z   (dt=1 day)
    const drift = mu - 0.5 * sigmaDaily * sigmaDaily;

    // Path-level outcome accumulators.
    const finalPrices = new Array(N);
    const dayPrices = [new Array(N), new Array(N), new Array(N)];   // per-day end prices
    let stopHit = 0, targetHit = 0;
    const stopLevel = spot * (1 - stopLossPct);
    const targetLevel = spot * (1 + takeProfitPct);

    for (let p = 0; p < N; p++) {
      let price = spot;
      let touchedStop = false, touchedTarget = false;
      for (let d = 0; d < days; d++) {
        let logRet = drift + sigmaDaily * randn();
        // Optional jump.
        if (jumps.lambdaPerDay > 0 && Math.random() < jumps.lambdaPerDay) {
          // Laplace-ish: sign random, magnitude exponential-ish.
          const sign = Math.random() < 0.5 ? -1 : 1;
          const mag = -Math.log(1 - Math.random()) * jumps.jumpScale;
          logRet += sign * mag + jumps.jumpBias;
        }
        price = price * Math.exp(logRet);
        // Approximate intra-day range using sigmaDaily — touch checks use the
        // path's daily HIGH/LOW estimated as price × exp(±0.6·σ_daily) so a
        // path that closes flat can still trigger a stop on intra-day noise.
        const hi = price * Math.exp(0.6 * sigmaDaily);
        const lo = price * Math.exp(-0.6 * sigmaDaily);
        if (!touchedStop && lo <= stopLevel) touchedStop = true;
        if (!touchedTarget && hi >= targetLevel) touchedTarget = true;
        dayPrices[d][p] = price;
      }
      finalPrices[p] = price;
      if (touchedStop) stopHit += 1;
      if (touchedTarget) targetHit += 1;
    }

    // --- Probabilistic summaries -----------------------------------------
    const sortAsc = arr => arr.slice().sort((a, b) => a - b);
    const pct = (sorted, q) => sorted[Math.floor(q * (sorted.length - 1))];
    const mean = arr => arr.reduce((s, x) => s + x, 0) / arr.length;

    const summarise = (arr, day) => {
      const sorted = sortAsc(arr);
      const m = mean(arr);
      const upMoves = arr.filter(x => x > spot).length / arr.length;
      const up1 = arr.filter(x => x > spot * 1.01).length / arr.length;
      const up2 = arr.filter(x => x > spot * 1.02).length / arr.length;
      const dn1 = arr.filter(x => x < spot * 0.99).length / arr.length;
      const dn2 = arr.filter(x => x < spot * 0.98).length / arr.length;
      return {
        day,
        median: +pct(sorted, 0.5).toFixed(4),
        p05:    +pct(sorted, 0.05).toFixed(4),
        p95:    +pct(sorted, 0.95).toFixed(4),
        meanRet: +(((m - spot) / spot) * 100).toFixed(2),
        pUp:    +(upMoves * 100).toFixed(0),
        pUp1:   +(up1 * 100).toFixed(0),
        pUp2:   +(up2 * 100).toFixed(0),
        pDn1:   +(dn1 * 100).toFixed(0),
        pDn2:   +(dn2 * 100).toFixed(0),
      };
    };
    const perDay = dayPrices.map((arr, i) => summarise(arr, i + 1));
    const finalSummary = perDay[perDay.length - 1];

    const result = {
      ok: true,
      symbol, spot, ts: Date.now(),
      paths: N, horizonDays: days, lastBarT: lastBar.t,
      inputs: {
        sigmaDailyPct: +(sigmaDaily * 100).toFixed(3),
        muDailyPct:    +(mu * 100).toFixed(3),
        regime: regime?.primary || null,
        macroNow:      macroRegime,
        macroForecast: macroForecastRegime,
        jumpsOn: jumps.lambdaPerDay > 0,
      },
      perDay,
      probStopHit:   +((stopHit / N) * 100).toFixed(0),
      probTargetHit: +((targetHit / N) * 100).toFixed(0),
      expectedRet3d: finalSummary.meanRet,
      band3d: { p05: finalSummary.p05, p95: finalSummary.p95, median: finalSummary.median },
    };

    _cache.set(cacheKey, { ts: Date.now(), lastBarT: lastBar.t, data: result });
    return result;
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Compact 3-5 line prompt block. Returns null when nothing meaningful.
function renderForPrompt(d) {
  if (!d || !d.ok) return null;
  const i = d.inputs;
  const d1 = d.perDay[0], d3 = d.perDay[2];
  const lines = [];
  lines.push(`Self-play sim (${d.paths} paths, ${d.horizonDays}d, σ_d=${i.sigmaDailyPct}%${i.jumpsOn ? ' + fat-tails' : ''}):`);
  lines.push(`  1d: median ${(((d1.median - d.spot) / d.spot) * 100).toFixed(2)}% · P(>+1%) ${d1.pUp1}% · P(<-1%) ${d1.pDn1}%`);
  lines.push(`  3d: mean ${d3.meanRet >= 0 ? '+' : ''}${d3.meanRet}% · 5-95 band [${(((d3.p05 - d.spot) / d.spot) * 100).toFixed(1)}%, ${(((d3.p95 - d.spot) / d.spot) * 100).toFixed(1)}%]`);
  lines.push(`  vs strategy stop/target: P(stop hit) ${d.probStopHit}% · P(target hit) ${d.probTargetHit}% (informational — quorum/gate untouched)`);
  return lines.join('\n');
}

// Introspection helpers — return the most recent (any-strategy) cached sim
// for a given symbol. The trading path always re-runs simulate() with the
// caller's strategy-specific shaping inputs, so this is purely for endpoint
// display.
function findLatestForSymbol(symbol) {
  let best = null;
  for (const [key, c] of _cache) {
    if (!key.startsWith(`${symbol}|`)) continue;
    if (!best || c.ts > best.ts) best = c;
  }
  return best;
}
function getCached(symbol) {
  const c = findLatestForSymbol(symbol);
  if (!c) return null;
  if (Date.now() - c.ts >= TTL_MS) return null;
  return c.data;
}
function getCachedRaw(symbol) {
  const c = findLatestForSymbol(symbol);
  return c ? { ...c.data, _ageMs: Date.now() - c.ts, _stale: Date.now() - c.ts >= TTL_MS } : null;
}

module.exports = {
  simulate, renderForPrompt, getCached, getCachedRaw,
  SIM_PATHS, SIM_HORIZON_DAYS,
};
