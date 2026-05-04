// Intraday tactical setups for the DAY-TRADING strategy.
//
// Looks at the last ~30-60 minutes of 1-minute bars and flags two
// high-conviction patterns the LLM ensemble can use as priors:
//
//   1. DIP_BUY_SETUP — short-term pullback to support that's starting to
//      reverse, with rising volume. The classic "buy the dip" entry.
//   2. PROFIT_TAKE_SETUP — open position is in profit AND price is at
//      resistance OR momentum is clearly fading. The "sell into strength"
//      exit.
//
// This service is purely informational. It DOES NOT decide trades.
// The 4-LLM ensemble still votes, the 3-of-4 quorum still applies, and the
// 75% confidence gate (Aggressive scale) is unchanged. Setups simply give
// the models another structured signal to weigh.

function lastN(arr, n) { return arr.slice(-Math.min(n, arr.length)); }
function pctChange(a, b) { return b ? ((a - b) / b) * 100 : 0; }

// --- DIP BUY -----------------------------------------------------------------
// Conditions (need ≥3 of 5):
//   • turningUp:    last 3 bars show a green reversal candle (close > 3-bar open)
//   • higherLow:    last 3-bar low > prior 7-bar low (HL forming)
//   • volConfirm:   last 3-bar avg vol ≥ 1.1× prior 7-bar avg (rising volume)
//   • nearSupport:  within 0.6% of nearest clustered support level
//   • rsiOK:        RSI(14) between 30 and 60 (oversold→recovering zone)
// Pullback magnitude must be 0.3-2.5% off a high made in the last 5-25 bars
// (otherwise it's noise or a full trend reversal, not a dip).
function detectDipBuySetup(bars, indicators, patterns) {
  if (!Array.isArray(bars) || bars.length < 30) return null;
  const recent = lastN(bars, 30);
  const closes = recent.map(b => b.c);
  const highs  = recent.map(b => b.h);
  const lows   = recent.map(b => b.l);
  const last = closes[closes.length - 1];

  // Recent high in window, but not from the most recent 2 bars (need a real pullback after it)
  const eligibleHighs = highs.slice(0, -2);
  const recentHigh = Math.max(...eligibleHighs);
  const recentHighIdx = eligibleHighs.lastIndexOf(recentHigh);
  const barsSinceHigh = (recent.length - 2) - recentHighIdx; // 0..27
  const pullbackPct = pctChange(recentHigh, last); // positive = pulled back

  if (pullbackPct < 0.3 || pullbackPct > 2.5) return null;
  if (barsSinceHigh < 3 || barsSinceHigh > 22) return null;

  // Reversal candle (last 3 bars overall green)
  const last3 = recent.slice(-3);
  const turningUp = last3[2].c > last3[0].o && last3[2].c > last3[2].o;

  // Higher low: min(last 3 lows) > min(prior 7 lows)
  const priorLow  = Math.min(...lows.slice(-10, -3));
  const recentLow = Math.min(...lows.slice(-3));
  const higherLow = recentLow > priorLow;

  // Volume confirmation
  const recentVol = last3.reduce((a, b) => a + b.v, 0) / 3;
  const priorVolWindow = recent.slice(-10, -3);
  const priorVol = priorVolWindow.reduce((a, b) => a + b.v, 0) / Math.max(1, priorVolWindow.length);
  const volConfirm = priorVol > 0 && recentVol >= priorVol * 1.1;

  // Near a clustered support level (from the existing pattern service)
  const ns = patterns?.nearestSupport;
  const nearSupport = ns ? Math.abs(pctChange(last, ns.price)) <= 0.6 : false;

  // RSI in the oversold→recovering zone
  const rsi = indicators?.rsi;
  const rsiOK = rsi != null && rsi >= 30 && rsi <= 60;

  const flags = { turningUp, higherLow, volConfirm, nearSupport, rsiOK };
  const score = Object.values(flags).filter(Boolean).length;
  if (score < 3) return null;

  const desc =
    `Pulled back ${pullbackPct.toFixed(2)}% from recent high $${recentHigh.toFixed(2)} (${barsSinceHigh} bars ago); ` +
    `${higherLow ? 'higher-low forming, ' : ''}` +
    `${turningUp ? 'green reversal candle, ' : ''}` +
    `${volConfirm ? `volume rising (${(recentVol / priorVol).toFixed(2)}× prior), ` : ''}` +
    `${nearSupport ? `at support $${ns.price}, ` : ''}` +
    `RSI ${rsi ?? 'n/a'}`;

  return {
    type: 'DIP_BUY_SETUP',
    score,                                // 3..5
    strength: score >= 5 ? 'strong' : score >= 4 ? 'moderate' : 'tentative',
    pullbackPct: +pullbackPct.toFixed(2),
    fromHigh: +recentHigh.toFixed(2),
    barsSinceHigh,
    nearestSupport: ns ? ns.price : null,
    flags,
    description: desc,
  };
}

// --- PROFIT TAKE -------------------------------------------------------------
// Only meaningful when a position is open AND in profit ≥ 0.5%.
// Triggers (any one is enough to flag; more = stronger):
//   • atResistance:   within 0.4% of nearest clustered resistance
//   • momentumFade:   RSI ≥ 70 AND last close < prior close (first red after run)
//   • volumeDryUp:    volume label is "drying up" or "contracting"
//   • macdRollOver:   MACD bearish cross detected
function detectProfitTakeSetup(bars, indicators, patterns, holding) {
  if (!holding || !Array.isArray(bars) || bars.length < 20) return null;
  const closes = bars.map(b => b.c);
  const last = closes[closes.length - 1];
  const profitPct = pctChange(last, holding.avg_cost);
  if (profitPct < 0.5) return null;

  const triggers = [];

  const nr = patterns?.nearestResistance;
  if (nr && Math.abs(pctChange(nr.price, last)) <= 0.4) {
    triggers.push(`at resistance $${nr.price}`);
  }
  if (indicators?.rsi != null && indicators.rsi >= 70 &&
      closes[closes.length - 1] < closes[closes.length - 2]) {
    triggers.push(`RSI ${indicators.rsi} overbought + first lower close`);
  }
  const volLabel = indicators?.volume?.label;
  if (volLabel === 'drying up' || volLabel === 'contracting') {
    triggers.push(`volume ${volLabel} (${indicators.volume.ratio}×)`);
  }
  if (indicators?.macd?.cross === 'bearish cross') {
    triggers.push(`MACD bearish cross`);
  }

  if (!triggers.length) return null;

  return {
    type: 'PROFIT_TAKE_SETUP',
    strength: triggers.length >= 2 ? 'strong' : 'moderate',
    profitPct: +profitPct.toFixed(2),
    triggers,
    description: `Position +${profitPct.toFixed(2)}%; ${triggers.join(' + ')}`,
  };
}

function analyzeIntraday(bars, indicators, patterns, holding) {
  if (!Array.isArray(bars) || bars.length < 20) {
    return { ok: false, reason: 'Insufficient bars (need ≥20)' };
  }
  return {
    ok: true,
    windowBars: Math.min(bars.length, 60),
    dipBuy: detectDipBuySetup(bars, indicators, patterns),
    profitTake: detectProfitTakeSetup(bars, indicators, patterns, holding),
  };
}

module.exports = { analyzeIntraday };
