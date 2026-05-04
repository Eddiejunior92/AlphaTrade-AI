// Pure-JS technical indicators used by BOTH day and swing strategies.
// Computed from the same OHLCV bar series the agent already pulls each cycle —
// no extra network calls, no extra latency. The LLM ensemble consumes this as
// one input among many; it does NOT make trading decisions on its own.

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

// Wilder's RSI(14). Returns the latest RSI value (0–100) or null.
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

function rsiLabel(v) {
  if (v == null) return 'unknown';
  if (v >= 70) return 'overbought';
  if (v <= 30) return 'oversold';
  if (v >= 55) return 'bullish';
  if (v <= 45) return 'bearish';
  return 'neutral';
}

// MACD(12, 26, 9). Returns { macd, signal, histogram, cross } from latest bar.
function macd(closes, fast = 12, slow = 26, signalP = 9) {
  if (closes.length < slow + signalP) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine, signalP);
  const last = macdLine.length - 1;
  const m = macdLine[last], s = signalLine[last];
  const h = m - s;
  const prevH = macdLine[last - 1] - signalLine[last - 1];
  let cross = 'none';
  if (prevH <= 0 && h > 0) cross = 'bullish cross';
  else if (prevH >= 0 && h < 0) cross = 'bearish cross';
  return { macd: +m.toFixed(4), signal: +s.toFixed(4), histogram: +h.toFixed(4), cross };
}

// Volume trend — ratio of recent (last 5 bars) average volume vs the prior
// 20-bar average. >1 means volume is expanding, <1 means contracting.
function volumeTrend(bars) {
  if (bars.length < 25) return null;
  const recent = bars.slice(-5).map(b => b.v).reduce((a, b) => a + b, 0) / 5;
  const baseWindow = bars.slice(-25, -5).map(b => b.v);
  const base = baseWindow.reduce((a, b) => a + b, 0) / baseWindow.length;
  if (base === 0) return null;
  const ratio = +(recent / base).toFixed(2);
  let label = 'flat';
  if (ratio >= 1.5) label = 'surging';
  else if (ratio >= 1.15) label = 'expanding';
  else if (ratio <= 0.7) label = 'drying up';
  else if (ratio <= 0.85) label = 'contracting';
  return { ratio, label };
}

// Volatility — per-bar stddev of last-N log returns (in %) + ATR(14) %.
function volatility(bars, lookback = 20) {
  if (bars.length < lookback + 2) return null;
  const closes = bars.slice(-lookback - 1).map(b => b.c);
  const rets = [];
  for (let i = 1; i < closes.length; i += 1) {
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const stddevPct = +(Math.sqrt(variance) * 100).toFixed(3);

  // ATR(14)% — true range avg divided by latest close
  const atrLook = Math.min(14, bars.length - 1);
  let atrSum = 0;
  for (let i = bars.length - atrLook; i < bars.length; i += 1) {
    const b = bars[i], pc = bars[i - 1].c;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    atrSum += tr;
  }
  const atr = atrSum / atrLook;
  const last = bars[bars.length - 1].c;
  const atrPct = last > 0 ? +((atr / last) * 100).toFixed(3) : null;

  let label = 'normal';
  if (atrPct != null) {
    if (atrPct >= 2.5) label = 'high';
    else if (atrPct >= 1.2) label = 'elevated';
    else if (atrPct <= 0.4) label = 'low';
  }
  return { stddevPctPerBar: stddevPct, atrPct, label };
}

function computeIndicators(bars) {
  if (!Array.isArray(bars) || bars.length < 20) {
    return { ok: false, reason: 'Insufficient bars for indicators (need ≥20)' };
  }
  const closes = bars.map(b => b.c);
  const rsiV = rsi(closes, 14);
  const macdV = macd(closes, 12, 26, 9);
  const volV = volumeTrend(bars);
  const volat = volatility(bars, 20);
  return {
    ok: true,
    rsi: rsiV,
    rsiLabel: rsiLabel(rsiV),
    macd: macdV,            // { macd, signal, histogram, cross } | null
    volume: volV,           // { ratio, label } | null
    volatility: volat,      // { stddevPctPerBar, atrPct, label } | null
  };
}

module.exports = { computeIndicators };
