// Market-regime classifier.
//
// Pure function over the same inputs the LLMs already see — bars, computed
// indicators, and blended news/social sentiment — so it adds zero new data
// dependencies. Returns a primary regime label plus secondary tags so a
// "trending_up" name in a "high_vol" tape is still flagged.
//
// Regimes (mutually-exclusive primary):
//   • high_vol         — ATR% ≥ 2.5 (or volatility.label === 'high')
//   • low_liquidity    — volume.ratio ≤ 0.7 (volume drying up)
//   • news_driven      — |sentiment.score| ≥ 0.5 AND fresh news
//   • trending_up      — short-EMA > long-EMA, MACD hist > 0, RSI ≥ 55
//   • trending_down    — short-EMA < long-EMA, MACD hist < 0, RSI ≤ 45
//   • mean_reverting   — RSI ∈ [40, 60], MACD hist ~0, low ATR
//   • normal           — fallback
//
// Priority order: high_vol > low_liquidity > news_driven > trending_*
// > mean_reverting > normal. Volatility-management considerations dominate.
//
// All thresholds are conservative enough to avoid label flapping; the meta
// layer also requires a min sample count per (regime, strategy) before any
// adjustment kicks in, so noisy classifications self-cancel anyway.

const HIGH_VOL_ATR_PCT_BASE = 2.5;
const LOW_LIQ_VOL_RATIO = 0.70;
const NEWS_SCORE_ABS = 0.50;
const TREND_RSI_UP = 55;
const TREND_RSI_DN = 45;

// Continuous-online-learning adjusts HIGH_VOL_ATR_PCT within ±15% of the
// hardcoded base. Hard floor + ceiling enforced here so any future drift
// cannot escape safety bounds. Falls back to base on any error.
function HIGH_VOL_ATR_PCT() {
  try {
    const cl = require('./continuousLearningService');
    const mult = cl.getThresholdDelta('HIGH_VOL_ATR_PCT');
    const adjusted = HIGH_VOL_ATR_PCT_BASE * mult;
    return Math.max(2.0, Math.min(3.5, adjusted));   // hard floor/ceiling
  } catch (_) { return HIGH_VOL_ATR_PCT_BASE; }
}

function emaSeries(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// Simple normalized slope of last-N closes, per-bar in % terms. Captures
// regime drift independently of MACD so a quiet uptrend still classifies
// as trending_up even when MACD signal is fading.
function slopePct(closes, lookback = 20) {
  if (!closes || closes.length < lookback + 1) return 0;
  const a = closes[closes.length - lookback - 1];
  const b = closes[closes.length - 1];
  if (!a) return 0;
  return ((b - a) / a) / lookback;  // per-bar return
}

function classifyRegime({ bars, indicators, newsSentiment }) {
  const tags = [];
  let primary = 'normal';
  let confidence = 0.5;            // how confident we are in the label

  // --- 1. High-vol takes priority — risk dynamics shift first ---------------
  const atrPct = Number(indicators?.volatility?.atrPct);
  if (Number.isFinite(atrPct)) {
    if (atrPct >= HIGH_VOL_ATR_PCT() || indicators?.volatility?.label === 'high') {
      primary = 'high_vol'; confidence = Math.min(1, atrPct / 4); tags.push('high_vol');
    }
  }

  // --- 2. Low liquidity — independently flagged regardless of trend ---------
  const volRatio = Number(indicators?.volume?.ratio);
  if (Number.isFinite(volRatio) && volRatio <= LOW_LIQ_VOL_RATIO) {
    if (primary === 'normal') { primary = 'low_liquidity'; confidence = 0.6; }
    tags.push('low_liquidity');
  }

  // --- 3. News-driven — strong fresh sentiment overrides quiet trends ------
  const sScore = Number(newsSentiment?.score);
  if (Number.isFinite(sScore) && Math.abs(sScore) >= NEWS_SCORE_ABS) {
    if (primary === 'normal') { primary = 'news_driven'; confidence = Math.min(1, Math.abs(sScore)); }
    tags.push(sScore > 0 ? 'news_bullish' : 'news_bearish');
  }

  // --- 4. Trend detection — only if not already flagged ---------------------
  if (primary === 'normal' && Array.isArray(bars) && bars.length >= 30) {
    const closes = bars.map(b => b.c);
    const ema20 = emaSeries(closes, 20);
    const ema50 = bars.length >= 60 ? emaSeries(closes, 50) : emaSeries(closes, Math.min(50, Math.floor(closes.length / 2)));
    const slope = slopePct(closes, 20);
    const rsi = Number(indicators?.rsi);
    const hist = Number(indicators?.macd?.histogram);

    if (ema20 != null && ema50 != null) {
      const upBias  = ema20 > ema50 && (Number.isFinite(hist) ? hist > 0 : true) && (Number.isFinite(rsi) ? rsi >= TREND_RSI_UP : slope > 0);
      const dnBias  = ema20 < ema50 && (Number.isFinite(hist) ? hist < 0 : true) && (Number.isFinite(rsi) ? rsi <= TREND_RSI_DN : slope < 0);
      if (upBias)      { primary = 'trending_up';   confidence = Math.min(1, Math.abs(slope) * 200 + 0.4); }
      else if (dnBias) { primary = 'trending_down'; confidence = Math.min(1, Math.abs(slope) * 200 + 0.4); }
    }

    // --- 5. Mean reversion — quiet, range-bound, neutral oscillator -------
    if (primary === 'normal') {
      const rangeBound = Number.isFinite(rsi) && rsi >= 40 && rsi <= 60;
      const macdFlat   = Number.isFinite(hist) ? Math.abs(hist) < 0.1 : true;
      const lowAtr     = Number.isFinite(atrPct) && atrPct < 1.2;
      if (rangeBound && macdFlat && lowAtr) { primary = 'mean_reverting'; confidence = 0.55; }
    }
  }

  return {
    primary,
    tags,
    confidence: +confidence.toFixed(3),
    metrics: {
      atrPct: Number.isFinite(atrPct) ? atrPct : null,
      volRatio: Number.isFinite(volRatio) ? volRatio : null,
      sentiment: Number.isFinite(sScore) ? sScore : null,
      rsi: Number.isFinite(Number(indicators?.rsi)) ? Number(indicators.rsi) : null,
      macdHist: Number.isFinite(Number(indicators?.macd?.histogram)) ? Number(indicators.macd.histogram) : null,
    },
  };
}

// Compact prompt block — informational only. Never directs the LLM to act
// against its own analysis; just labels the tape and notes that the meta
// layer will tighten gates if the regime has been historically poor.
function getPromptBlock(regime, metaAdjust) {
  if (!regime) return null;
  const adjLine = metaAdjust && (metaAdjust.confidenceBoost > 0 || metaAdjust.regimeMult !== 1)
    ? ` Meta layer: +${(metaAdjust.confidenceBoost * 100).toFixed(0)}pp conf gate, ×${metaAdjust.regimeMult.toFixed(2)} size.`
    : '';
  const tagLine = regime.tags && regime.tags.length ? ` (tags: ${regime.tags.join(',')})` : '';
  return `Detected market regime: ${regime.primary}${tagLine}.${adjLine}`;
}

// Map regime → 4 one-hot dims for ML feature extraction. Kept compact so
// adding new regimes later doesn't blow up the feature schema unnecessarily.
function toOneHot(regime) {
  const p = regime?.primary || 'normal';
  return {
    is_high_vol:      p === 'high_vol' ? 1 : 0,
    is_trending:      (p === 'trending_up' || p === 'trending_down') ? 1 : 0,
    is_mean_revert:   p === 'mean_reverting' ? 1 : 0,
    is_news_driven:   p === 'news_driven' ? 1 : 0,
  };
}

const ALL_REGIMES = ['high_vol', 'low_liquidity', 'news_driven', 'trending_up', 'trending_down', 'mean_reverting', 'normal'];

module.exports = { classifyRegime, getPromptBlock, toOneHot, ALL_REGIMES };
