// mtfConsensusService — Multi-Timeframe trend consensus for the Technical
// Analyst. Pure function; never throws; null-safe degradation. Strictly
// informational — fed into the Council's Technical Analyst prompt only.
// CANNOT bypass quorum, gate, sizing, or any hard rail.
//
// PHASE B STUB: agent.js currently fetches a single timeframe per cycle.
// When 5m/15m/1h fetches are wired in (TODO below), the Technical Analyst
// will receive a real `mtfConsensus` block. Until then, missing timeframes
// degrade gracefully and the function returns `{ ok:false, reason }`.

function _trendFromIndicators(ind) {
  if (!ind || typeof ind !== 'object') return null;
  // Lightweight trend label from MACD histogram + RSI midline.
  const macdHist = ind?.macd?.histogram;
  const rsi = ind?.rsi;
  if (!Number.isFinite(macdHist) && !Number.isFinite(rsi)) return null;
  let score = 0;
  if (Number.isFinite(macdHist)) score += macdHist > 0 ? 1 : macdHist < 0 ? -1 : 0;
  if (Number.isFinite(rsi)) score += rsi > 55 ? 1 : rsi < 45 ? -1 : 0;
  if (score >= 1) return 'up';
  if (score <= -1) return 'down';
  return 'flat';
}

// computeMtfConsensus({ tf5m, tf15m, tf1h }) — each timeframe is an
// `indicators`-shaped object (or null). Returns:
//   { ok, agree, direction, score, frames, reason? }
// score ∈ [-1, 1]: +1 = all up, -1 = all down, 0 = mixed. agree ∈ [0, 3].
function computeMtfConsensus({ tf5m, tf15m, tf1h } = {}) {
  const frames = {
    m5:  _trendFromIndicators(tf5m),
    m15: _trendFromIndicators(tf15m),
    h1:  _trendFromIndicators(tf1h),
  };
  const present = Object.values(frames).filter(v => v != null);
  if (present.length === 0) {
    return { ok: false, reason: 'no_timeframes_available', frames, agree: 0, direction: null, score: 0 };
  }
  const upN = present.filter(v => v === 'up').length;
  const dnN = present.filter(v => v === 'down').length;
  const score = (upN - dnN) / present.length;
  let direction = null;
  let agree = 0;
  if (upN > dnN) { direction = 'up'; agree = upN; }
  else if (dnN > upN) { direction = 'down'; agree = dnN; }
  else { direction = 'flat'; agree = present.length - upN - dnN; }
  return { ok: true, agree, direction, score: +score.toFixed(3), frames, framesPresent: present.length };
}

function renderForPrompt(mtf) {
  if (!mtf || !mtf.ok) return null;
  const f = mtf.frames || {};
  return [
    'MTF CONSENSUS (5m / 15m / 1h):',
    `  • 5m=${f.m5 ?? 'n/a'}  15m=${f.m15 ?? 'n/a'}  1h=${f.h1 ?? 'n/a'}`,
    `  • aligned=${mtf.agree}/${mtf.framesPresent}  dir=${mtf.direction}  score=${mtf.score >= 0 ? '+' : ''}${mtf.score}`,
  ].join('\n');
}

module.exports = { computeMtfConsensus, renderForPrompt };
