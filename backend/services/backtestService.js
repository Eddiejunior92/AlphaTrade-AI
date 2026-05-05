// Backtest engine — replays daily bars on a rules-based strategy with
// configurable slippage, commission, and a simple regime filter. NOT a full
// 4-LLM ensemble replay (that would burn the API budget). It's a fast,
// deterministic proxy that uses indicators + pattern + historical-intel signals
// to produce buy/sell decisions on each bar so the user can size, sweep, and
// compare parameter changes from the dashboard.
const alpaca = require('./alpacaService');
// Route bars through the broker router so ASX backtests pull from IBKR
// instead of silently grabbing US-listed instruments with overlapping
// tickers (e.g. BHP, RIO) from Alpaca.
const brokerRouter = require('./brokerRouter');
const indicators = require('./indicatorsService');
const patterns = require('./patternService');
const db = require('./db');

const DEFAULT_PARAMS = {
  symbols: ['SPY'],
  startCash: 100000,
  lookbackDays: 365,
  slippageBps: 5,
  commissionUSD: 1.0,
  // Strategy params:
  rsiBuyMax: 55,
  rsiSellMin: 70,
  stopLossPct: 0.04,
  takeProfitPct: 0.10,
  trailingStopPct: 0.06,
  maxPositionPct: 0.20,
  // Regime filter — only buy when price > SMA50 OR force off
  requireUptrend: true,
};

function applySlippage(price, side, bps) {
  const adj = price * (bps / 10000);
  return side === 'BUY' ? price + adj : price - adj;
}

function computeSharpe(returns, periodsPerYear = 252) {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return +((mean / std) * Math.sqrt(periodsPerYear)).toFixed(2);
}

function computeMaxDrawdown(equityCurve) {
  let peak = -Infinity, maxDD = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return +(maxDD * 100).toFixed(2);  // negative %
}

async function runBacktest(rawParams = {}) {
  const p = { ...DEFAULT_PARAMS, ...rawParams };
  const startedAt = Date.now();

  // Pull bars per symbol (one shot, sequential to be polite to the API).
  const series = {};
  for (const sym of p.symbols) {
    try {
      const bars = await brokerRouter.getBars(sym, '1Day', p.lookbackDays + 60);
      if (!Array.isArray(bars) || bars.length < 60) continue;
      series[sym] = bars;
    } catch (e) {
      // Skip silently
    }
  }
  const symbols = Object.keys(series);
  if (!symbols.length) return { ok: false, reason: 'No symbols had usable data', params: p };

  // Align by trading day index — we use each symbol's own bar timeline; the
  // simulation iterates day by day on each symbol independently and aggregates.
  let cash = p.startCash;
  const positions = {};   // sym → { qty, entry, peak, stop, target }
  const equityCurve = []; // [{date, equity}]
  const tradeLog = [];
  const dailyReturns = [];
  let prevEquity = p.startCash;

  // Find common date range — use the longest series and re-index by date.
  const allDates = new Set();
  for (const sym of symbols) for (const b of series[sym]) allDates.add(String(b.t).slice(0, 10));
  const sortedDates = [...allDates].sort();
  const startIdx = Math.max(0, sortedDates.length - p.lookbackDays);
  const tradingDates = sortedDates.slice(startIdx);

  // Index per symbol: date → bar
  const dateIdx = {};
  for (const sym of symbols) {
    dateIdx[sym] = new Map();
    for (const b of series[sym]) dateIdx[sym].set(String(b.t).slice(0, 10), b);
  }

  // Need enough warmup bars for indicators (50+ bars before first signal day).
  const WARMUP = 50;
  for (let dIdx = 0; dIdx < tradingDates.length; dIdx++) {
    const date = tradingDates[dIdx];

    for (const sym of symbols) {
      const bar = dateIdx[sym].get(date);
      if (!bar) continue;
      // Build the rolling window up to and including this date.
      const fullSeries = series[sym];
      const upTo = fullSeries.findIndex(b => String(b.t).slice(0, 10) === date);
      if (upTo < WARMUP) continue;
      const window = fullSeries.slice(Math.max(0, upTo - WARMUP - 5), upTo + 1);
      const close = +bar.c;
      if (!(close > 0)) continue;

      const ind = indicators.computeIndicators(window);
      const pat = patterns.analyzePatterns(window);
      const rsi = ind?.rsi;
      const trendUp = pat?.trend === 'up' || pat?.aboveSma50;
      const macdBull = ind?.macd?.cross === 'bullish';
      const macdBear = ind?.macd?.cross === 'bearish';

      const pos = positions[sym];

      // EXIT logic first (stop / target / trailing / signal).
      if (pos) {
        // Update trailing peak
        if (close > pos.peak) {
          pos.peak = close;
          const newTrail = pos.peak * (1 - p.trailingStopPct);
          if (newTrail > pos.stop) pos.stop = newTrail;
        }
        let exitReason = null;
        if (close <= pos.stop) exitReason = 'STOP';
        else if (close >= pos.target) exitReason = 'TARGET';
        else if (rsi >= p.rsiSellMin && macdBear) exitReason = 'RSI_BEAR';

        if (exitReason) {
          const exit = applySlippage(close, 'SELL', p.slippageBps);
          const proceeds = pos.qty * exit - p.commissionUSD;
          const cost = pos.qty * pos.entry;
          const pnl = proceeds - cost;
          cash += proceeds;
          tradeLog.push({
            date, symbol: sym, side: 'SELL', qty: pos.qty,
            price: +exit.toFixed(2), pnl: +pnl.toFixed(2), reason: exitReason,
          });
          delete positions[sym];
        }
      } else {
        // ENTRY logic
        const buyOK = rsi != null && rsi <= p.rsiBuyMax && rsi >= 30
          && (!p.requireUptrend || trendUp)
          && (macdBull || trendUp);
        if (buyOK) {
          // Position sizing: max position pct of equity
          const equityNow = cash + Object.values(positions).reduce((s, q) => s + q.qty * close, 0);
          const budget = Math.min(cash, equityNow * p.maxPositionPct);
          const entry = applySlippage(close, 'BUY', p.slippageBps);
          const qty = Math.floor((budget - p.commissionUSD) / entry);
          if (qty > 0) {
            const cost = qty * entry + p.commissionUSD;
            cash -= cost;
            positions[sym] = {
              qty, entry,
              peak: entry,
              stop: entry * (1 - p.stopLossPct),
              target: entry * (1 + p.takeProfitPct),
            };
            tradeLog.push({ date, symbol: sym, side: 'BUY', qty, price: +entry.toFixed(2), reason: `RSI ${rsi}, ${trendUp ? 'uptrend' : 'flat'}` });
          }
        }
      }
    }

    // End-of-day mark to market on whatever close prices we have for the date.
    let mkt = 0;
    for (const [sym, pos] of Object.entries(positions)) {
      const b = dateIdx[sym].get(date);
      const px = b ? +b.c : pos.entry;
      mkt += pos.qty * px;
    }
    const equity = cash + mkt;
    equityCurve.push({ date, equity: +equity.toFixed(2) });
    if (prevEquity > 0) dailyReturns.push((equity - prevEquity) / prevEquity);
    prevEquity = equity;
  }

  // Close any open positions at the last close
  const lastDate = tradingDates[tradingDates.length - 1];
  for (const [sym, pos] of Object.entries(positions)) {
    const b = dateIdx[sym].get(lastDate);
    if (!b) continue;
    const exit = applySlippage(+b.c, 'SELL', p.slippageBps);
    const pnl = pos.qty * exit - pos.qty * pos.entry - p.commissionUSD;
    cash += pos.qty * exit - p.commissionUSD;
    tradeLog.push({ date: lastDate, symbol: sym, side: 'SELL', qty: pos.qty, price: +exit.toFixed(2), pnl: +pnl.toFixed(2), reason: 'END' });
  }

  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : p.startCash;
  const wins = tradeLog.filter(t => t.side === 'SELL' && t.pnl > 0).length;
  const losses = tradeLog.filter(t => t.side === 'SELL' && t.pnl <= 0).length;
  const totalSells = wins + losses;
  const grossPnl = tradeLog.filter(t => t.pnl).reduce((s, t) => s + t.pnl, 0);

  const results = {
    ok: true,
    durationMs: Date.now() - startedAt,
    startCash: p.startCash,
    finalEquity: +finalEquity.toFixed(2),
    totalReturnPct: +(((finalEquity - p.startCash) / p.startCash) * 100).toFixed(2),
    grossPnl: +grossPnl.toFixed(2),
    nTrades: totalSells,
    nBuys: tradeLog.filter(t => t.side === 'BUY').length,
    winRate: totalSells ? +(wins / totalSells).toFixed(3) : 0,
    sharpe: computeSharpe(dailyReturns),
    maxDrawdownPct: computeMaxDrawdown(equityCurve.map(p => p.equity)),
    nSymbolsUsed: symbols.length,
    daysSimulated: tradingDates.length,
  };

  // Persist run
  let runId = null;
  try {
    const { rows } = await db.query(`
      INSERT INTO backtest_runs (symbols, start_date, end_date, params, results, equity_curve, trades, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING id
    `, [symbols, tradingDates[0], lastDate, p, results, equityCurve, tradeLog.slice(-500)]);
    runId = rows[0]?.id;
  } catch (e) {
    // Schema not yet ensured — return results without persistence
  }

  return { ...results, id: runId, params: p, equityCurve, trades: tradeLog.slice(-200), symbols };
}

async function getRecentRuns(limit = 20) {
  try {
    const { rows } = await db.query(`
      SELECT id, symbols, start_date, end_date, params, results, created_at
      FROM backtest_runs ORDER BY created_at DESC LIMIT $1
    `, [limit]);
    return rows;
  } catch { return []; }
}

async function getRun(id) {
  try {
    const { rows } = await db.query('SELECT * FROM backtest_runs WHERE id = $1', [id]);
    return rows[0] || null;
  } catch { return null; }
}

module.exports = { runBacktest, getRecentRuns, getRun, DEFAULT_PARAMS };
