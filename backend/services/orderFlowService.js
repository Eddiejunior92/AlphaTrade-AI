// Order-flow proxy — pure compute on bars we already fetched. Detects
// volume surges in the most recent 1-min bars and labels them as buy- or
// sell-pressure based on the price move within the surge bars. No extra API
// calls. Surfaced in the LLM prompt as one extra context line.
function analyzeOrderFlow(bars) {
  if (!Array.isArray(bars) || bars.length < 25) return { ok: false, reason: 'insufficient bars' };
  const recent = bars.slice(-5);
  const baseline = bars.slice(-25, -5);
  const baseVol = baseline.reduce((s, b) => s + (+b.v || 0), 0) / Math.max(1, baseline.length);
  if (baseVol <= 0) return { ok: false, reason: 'no baseline volume' };

  let surgeVol = 0, signedMove = 0;
  for (const b of recent) {
    const v = +b.v || 0;
    surgeVol += v;
    const o = +b.o || 0, c = +b.c || 0;
    if (o > 0) signedMove += ((c - o) / o) * v;
  }
  const surgeRatio = +(surgeVol / (baseVol * recent.length)).toFixed(2);
  const direction = signedMove > 0 ? 'buy_pressure' : signedMove < 0 ? 'sell_pressure' : 'neutral';

  let label = 'normal';
  if (surgeRatio >= 3) label = 'extreme_surge';
  else if (surgeRatio >= 2) label = 'surge';
  else if (surgeRatio >= 1.5) label = 'elevated';

  return {
    ok: true,
    label, direction, surgeRatio,
    description: label === 'normal'
      ? null
      : `Order flow: ${label.replace('_', ' ')} (${surgeRatio}× baseline vol, ${direction.replace('_', ' ')}).`,
  };
}

module.exports = { analyzeOrderFlow };
