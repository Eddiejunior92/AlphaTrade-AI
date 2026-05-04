// Hedging — monitors portfolio-level risk (avg pairwise correlation + realized
// volatility). When a risk spike fires, emits a HEDGE_SIGNAL audit + Discord
// alert. If AUTO_HEDGE=true, can size and request an inverse-ETF hedge (SH for
// SPY-correlated longs). Otherwise it's purely advisory. Quorum + gates and
// circuit breaker are unchanged.
const db = require('./db');
const discord = require('./discordService');
const portfolioOpt = require('./portfolioOptimizationService');
const alpaca = require('./alpacaService');

const HIGH_CORR_THRESH = 0.70;
const HIGH_VOL_THRESH_DAILY = 0.025;   // 2.5% daily portfolio vol
const COOLDOWN_MS = 30 * 60 * 1000;    // don't re-alert more than every 30m
const HEDGE_NOTIONAL_FRACTION = 0.15;  // hedge 15% of long exposure

let _lastAlert = 0;
let _lastHedgeAt = 0;

async function getPortfolioRisk(holdings) {
  if (!holdings?.length) return { avgCorr: 0, dailyVol: 0, longUSD: 0, ok: true };
  const symbols = holdings.map(h => h.symbol);
  const snap = await portfolioOpt.getPortfolioSnapshot(symbols);
  const longUSD = holdings.reduce((s, h) => s + (parseFloat(h.qty) || 0) * (parseFloat(h.last_price || h.avg_cost) || 0), 0);

  // Crude daily-vol proxy: equally weighted vol of each symbol's daily returns
  // multiplied by (1 + avgCorr) to reflect crowding.
  let weightedVar = 0, n = 0;
  for (const sym of snap.symbols) {
    const r = await portfolioOpt.evaluateAddition({ candidate: sym, holdings: holdings.filter(h => h.symbol !== sym) });
    // Re-pull daily returns via opt service cache
    // (lightweight: we'll just use snap.avgCorr to estimate book vol below)
    n++;
  }
  const avgCorr = snap.avgCorr || 0;
  // Approximate vol from price data: use last 30 daily bars
  const vols = await Promise.all(symbols.map(async s => {
    try {
      const bars = await alpaca.getBars(s, '1Day', 30);
      if (!Array.isArray(bars) || bars.length < 5) return null;
      const returns = [];
      for (let i = 1; i < bars.length; i++) {
        const p0 = +bars[i - 1].c, p1 = +bars[i].c;
        if (p0 > 0 && p1 > 0) returns.push((p1 - p0) / p0);
      }
      const m = returns.reduce((a, b) => a + b, 0) / returns.length;
      const v = returns.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, returns.length - 1);
      return Math.sqrt(v);
    } catch { return null; }
  }));
  const validVols = vols.filter(v => v != null);
  const meanSymVol = validVols.length ? validVols.reduce((a, b) => a + b, 0) / validVols.length : 0;
  // Rough portfolio vol with correlation amplification
  const dailyVol = meanSymVol * Math.sqrt(1 + Math.max(0, avgCorr) * (validVols.length - 1) / Math.max(1, validVols.length));

  return {
    avgCorr,
    dailyVol: +dailyVol.toFixed(4),
    longUSD: +longUSD.toFixed(2),
    nSymbols: symbols.length,
    maxPair: snap.maxPair,
    ok: true,
  };
}

async function evaluateAndAlert(holdings, { autoHedge = false } = {}) {
  if (!holdings?.length || holdings.length < 2) return { triggered: false };
  const risk = await getPortfolioRisk(holdings);
  const reasons = [];
  if (risk.avgCorr >= HIGH_CORR_THRESH) reasons.push(`avg pairwise correlation ${risk.avgCorr} ≥ ${HIGH_CORR_THRESH}`);
  if (risk.dailyVol >= HIGH_VOL_THRESH_DAILY) reasons.push(`portfolio daily vol ${(risk.dailyVol * 100).toFixed(2)}% ≥ ${(HIGH_VOL_THRESH_DAILY * 100).toFixed(1)}%`);
  if (!reasons.length) return { triggered: false, risk };

  // Cooldown to avoid log/alert spam
  if (Date.now() - _lastAlert < COOLDOWN_MS) return { triggered: true, risk, reasons, suppressed: true };
  _lastAlert = Date.now();

  await db.recordAudit({
    event_type: 'HEDGE_SIGNAL',
    payload: { reasons, risk, holdings: holdings.map(h => h.symbol), autoHedge },
  });

  try {
    await discord.sendAlert({
      title: '🛡️ Portfolio Risk — Hedge Signal',
      description: reasons.join(' · '),
      color: 0xffaa00,
      fields: [
        { name: 'Avg correlation', value: String(risk.avgCorr), inline: true },
        { name: 'Est daily vol', value: `${(risk.dailyVol * 100).toFixed(2)}%`, inline: true },
        { name: 'Long exposure', value: `$${risk.longUSD.toFixed(0)}`, inline: true },
        { name: 'Holdings', value: holdings.map(h => h.symbol).join(', ').slice(0, 800) },
      ],
    });
  } catch {}

  // Optional auto-hedge — disabled by default. Buys SH inverse-SPY ETF sized at
  // 15% of long notional. Only triggers once per cooldown window. Recorded as
  // its own audit row so the trail is explicit.
  if (autoHedge && Date.now() - _lastHedgeAt > COOLDOWN_MS) {
    try {
      const hedgeNotional = risk.longUSD * HEDGE_NOTIONAL_FRACTION;
      if (hedgeNotional >= 50) {
        const shBars = await alpaca.getBars('SH', '1Min', 1).catch(() => []);
        const px = Array.isArray(shBars) && shBars.length ? +shBars[shBars.length - 1].c : null;
        if (px && px > 0) {
          const qty = Math.floor(hedgeNotional / px);
          if (qty > 0) {
            const order = await alpaca.placeOrder({ symbol: 'SH', qty, side: 'buy', type: 'market', time_in_force: 'day' }).catch(e => ({ error: e.message }));
            await db.recordAudit({
              event_type: 'HEDGE_EXECUTED',
              symbol: 'SH',
              decision: 'BUY',
              payload: { qty, notional: +(qty * px).toFixed(2), reason: reasons.join(' · '), order_id: order?.id || null, error: order?.error || null },
            });
            _lastHedgeAt = Date.now();
          }
        }
      }
    } catch (e) {
      await db.recordAudit({ event_type: 'HEDGE_ERROR', payload: { error: e.message } });
    }
  }

  return { triggered: true, risk, reasons };
}

module.exports = { getPortfolioRisk, evaluateAndAlert };
