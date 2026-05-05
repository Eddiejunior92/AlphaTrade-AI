// Earnings signal service — derives a Post-Earnings-Announcement-Drift (PEAD)
// bias and a pre-earnings blackout flag from the fundamentals data we already
// fetch (no new API calls, no new cost). The LLM ensemble consumes the
// rendered prompt block; quorum and confidence gates remain the sole arbiters
// of execution. Pure compute — never throws.
//
// Inputs we have today (from fundamentalsService):
//   - fundamentals.earnings_next_date  (YYYY-MM-DD or null)
//   - fundamentals.earnings_recent_surprise_pct  (last EPS surprise %)
//
// What we derive:
//   - daysToEarnings     (calendar days, null if unknown)
//   - blackoutFlag       (within 2 calendar days BEFORE earnings → avoid new BUYs)
//   - daysSinceEarnings  (estimated; companies report ~90d cadence, so
//                         daysSince ≈ 90 - daysTo when daysTo is known)
//   - peadBias           ('bullish' | 'bearish' | 'neutral') — academic PEAD
//                         effect: stocks that beat by ≥5% tend to drift up for
//                         ~30-60 trading days post-announcement, missers down.
//   - peadStrength       ('strong' | 'moderate' | 'weak' | 'none')

function parseDateSafe(s) {
  if (!s || typeof s !== 'string') return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function daysBetween(a, b) {
  const ms = a.getTime() - b.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function analyzeEarningsSignal(fundamentals, now = new Date()) {
  if (!fundamentals) return { ok: false, reason: 'no fundamentals' };

  const nextDateStr = fundamentals.earnings_next_date || null;
  const lastSurprise = Number.isFinite(+fundamentals.earnings_recent_surprise_pct)
    ? +fundamentals.earnings_recent_surprise_pct
    : null;

  let daysToEarnings = null;
  let blackoutFlag = false;
  let daysSinceEarnings = null;
  const nextDate = parseDateSafe(nextDateStr);
  if (nextDate) {
    daysToEarnings = daysBetween(nextDate, now);
    // Blackout: today through 2 calendar days before the print.
    if (daysToEarnings >= 0 && daysToEarnings <= 2) blackoutFlag = true;
    // Estimate days since LAST earnings assuming ~91-day quarterly cadence.
    if (daysToEarnings >= 0 && daysToEarnings <= 100) {
      daysSinceEarnings = Math.max(0, 91 - daysToEarnings);
    }
  }

  // PEAD bias — only meaningful in the drift window after a print
  // (academic literature: most of the drift plays out in the first 60 trading
  //  days post-announcement). We use ≤ 60 calendar days as a conservative
  //  proxy. Surprise magnitudes:
  //   |surprise| ≥ 10%  → strong drift bias
  //   |surprise| ≥ 5%   → moderate
  //   |surprise| ≥ 2%   → weak
  //   |surprise| < 2%   → none
  let peadBias = 'neutral';
  let peadStrength = 'none';
  if (lastSurprise != null && daysSinceEarnings != null && daysSinceEarnings <= 60) {
    const m = Math.abs(lastSurprise);
    if (m >= 10) peadStrength = 'strong';
    else if (m >= 5) peadStrength = 'moderate';
    else if (m >= 2) peadStrength = 'weak';
    if (peadStrength !== 'none') peadBias = lastSurprise > 0 ? 'bullish' : 'bearish';
  }

  return {
    ok: true,
    daysToEarnings,
    daysSinceEarnings,
    blackoutFlag,
    lastSurprisePct: lastSurprise,
    peadBias,
    peadStrength,
  };
}

function renderForPrompt(sig) {
  if (!sig || !sig.ok) return null;
  const parts = [];
  if (sig.daysToEarnings != null) {
    if (sig.blackoutFlag) {
      parts.push(`⚠️ EARNINGS BLACKOUT: prints in ${sig.daysToEarnings}d — avoid new BUYs (overnight gap risk)`);
    } else if (sig.daysToEarnings >= 0 && sig.daysToEarnings <= 7) {
      parts.push(`Earnings in ${sig.daysToEarnings}d — trim conviction on new BUYs`);
    } else if (sig.daysToEarnings > 7) {
      parts.push(`Next earnings in ${sig.daysToEarnings}d (no immediate calendar risk)`);
    }
  }
  if (sig.peadStrength !== 'none' && sig.peadBias !== 'neutral') {
    const sign = sig.lastSurprisePct >= 0 ? '+' : '';
    parts.push(`PEAD bias: ${sig.peadBias} (${sig.peadStrength}, last surprise ${sign}${sig.lastSurprisePct}%, ${sig.daysSinceEarnings}d post-print)`);
  }
  if (!parts.length) return null;
  return `Earnings signal: ${parts.join(' · ')}.`;
}

module.exports = { analyzeEarningsSignal, renderForPrompt };
