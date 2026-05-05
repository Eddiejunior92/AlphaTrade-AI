const axios = require('axios');
const llmWeighting = require('./llmWeightingService');
const metaReasoner = require('./metaReasonerService');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';

const MODELS = [
  {
    id: 'gemini',
    label: 'Gemini 2.0 Flash',
    provider: 'openrouter',
    model: 'google/gemini-2.0-flash-001',
    role: 'Quantitative analyst — focus on price action and momentum.',
  },
  {
    id: 'claude',
    label: 'Claude 3.7 Sonnet',
    provider: 'openrouter',
    model: 'anthropic/claude-3.7-sonnet',
    role: 'Risk manager — focus on downside risk and capital preservation.',
  },
  {
    id: 'gpt4o',
    label: 'GPT-4o',
    provider: 'openrouter',
    model: 'openai/gpt-4o',
    role: 'Strategy generalist — synthesize technicals and fundamentals.',
  },
  {
    id: 'grok',
    label: 'Grok 4 Fast',
    provider: 'xai',
    model: 'grok-4-fast-non-reasoning',
    role: 'Truth & sentiment specialist — read social/news sentiment, flag red flags.',
  },
];

const MIN_VALID_MODELS = parseInt(process.env.MIN_VALID_MODELS || '3');

function buildPrompt({ symbol, priceData, sentiment, newsSentiment, holding, portfolio, role, patterns, fundamentals, indicators, intraday, historical, strategyName, premarket, adaptiveHints, portfolioRisk, orderFlow, optionsActivity, optionsFlow, earningsSignal, regimeContext, knowledgeContext, macroForecast, scenarioSim, ensembleWeights, priorMeta, causalContext, counterfactualContext, experienceContext, propagationContext, feedbackContext }) {
  // Compact upgrade blocks — informational only, never override quorum/gate.
  const adaptiveBlock = adaptiveHints ? `\n${adaptiveHints}\n` : '';
  const portRiskBlock = portfolioRisk ? `\n${portfolioRisk}\n` : '';
  const flowLine = orderFlow?.description ? `\n${orderFlow.description}\n` : '';
  const optsLine = optionsActivity ? `\n${optionsActivity}\n` : '';
  // Quantitative options-chain block (P/C ratio, IV avg, IV rank, IV skew,
  // unusual sweeps/blocks). Sits next to the Grok-narrative `optionsActivity`
  // line above and complements it. Strictly informational.
  const optFlowLine = optionsFlow ? `\n${optionsFlow}\n` : '';
  const earnLine = earningsSignal ? `\n${earningsSignal}\n` : '';
  // Regime classification block — informational. Tells the LLM what tape
  // we're in (high-vol/trending/news-driven/etc.) and whether the meta layer
  // has tightened gates. Never directs a vote — quorum still rules.
  const regimeBlock = regimeContext ? `\n${regimeContext}\n` : '';
  // Macro regime forecast block — current + 24-48h forecast, with informational
  // risk-posture hints. Strictly informational; quorum/gate/sizing/breaker are
  // enforced by the agent + risk manager, never by the LLM.
  const macroBlock = macroForecast ? `\n${macroForecast}\n` : '';
  // Self-play Monte-Carlo scenario sim — probability-weighted 1-3d outlook
  // built from regime + macro + IV + recent price action. Strictly
  // informational; does not vote, size, or gate anything.
  const simBlock = scenarioSim ? `\n${scenarioSim}\n` : '';
  // Dynamic ensemble weighting block — shows each peer model's current
  // weight + sample size in this (strategy × regime × market) context.
  // Strictly informational; the prior weight may inform the model's own
  // confidence calibration but never overrides quorum/gate.
  const weightsBlock = ensembleWeights ? `\n${ensembleWeights}\n` : '';
  // Prior cycle's meta-reasoner opinion (if any). Models can see and
  // disagree with the prior take — useful context, not gospel.
  const metaBlock = priorMeta ? `\n${priorMeta}\n` : '';
  // Causal-inference graph for the current (strategy × regime × market)
  // context — top features that historically *cause* (per spurious-filtered
  // lift) higher or lower win-rate. Strictly informational.
  const causalBlock = causalContext ? `\n${causalContext}\n` : '';
  // Counterfactual replay summary — "what if we tightened the gate / required
  // 4/4 quorum / required meta-agreement" over recent closes. Informational
  // only; the live rules are not changed by this layer.
  const cfBlock = counterfactualContext ? `\n${counterfactualContext}\n` : '';

  // Long-term memory / experience replay block. Pre-rendered text sourced
  // from memoryService.retrieveSimilar() — the top-K most similar past
  // closed trades for this (strategy, regime, market, indicator buckets)
  // context. Strictly informational priors; raw quorum + confidence gate
  // retain full veto power.
  const expBlock = experienceContext ? `\n${experienceContext}\n` : '';
  // Cross-Market & Sector Propagation block — top-K active propagation edges
  // for the symbol's (market × sector) bucket where the source bucket is
  // CURRENTLY in the conditioning state. Strictly informational priors.
  const propBlock = propagationContext ? `\n${propagationContext}\n` : '';
  // Human-in-the-Loop feedback block — pre-rendered summary of recent USER
  // feedback for this (strategy, regime, market) bucket. Strictly informational
  // priors; raw quorum + confidence gate retain full veto power.
  const feedbackBlock = feedbackContext ? `\n${feedbackContext}\n` : '';
  // Long-term knowledge-graph block — slow-moving per-symbol context
  // (sector peers, earnings track, valuation, macro, major events).
  // Informational; never overrides quorum/gate/sizing.
  const knowledgeBlock = knowledgeContext ? `\n${knowledgeContext}\n` : '';
  const upgradeContext = `${adaptiveBlock}${portRiskBlock}${flowLine}${optsLine}${optFlowLine}${earnLine}${regimeBlock}${macroBlock}${simBlock}${weightsBlock}${metaBlock}${causalBlock}${cfBlock}${expBlock}${propBlock}${feedbackBlock}${knowledgeBlock}`;
  // 20-year historical intelligence (cached, refreshed once/day before open).
  // Already a pre-rendered text block — null when cache isn't warm yet.
  const historicalBlock = historical ? `\n${historical}\n` : '';
  // Pre-market briefing injection (only present during the first ~60 min after open).
  const premarketBlock = premarket ? `\nPRE-MARKET BRIEFING (use as PRIOR — overrides nothing, but explains gaps & catalysts):\n${premarket}\n` : '';
  const positionLine = holding
    ? `Current position: ${holding.qty} shares @ avg $${holding.avg_cost} (stop: $${holding.stop_loss}, target: $${holding.take_profit})`
    : 'Current position: NONE';

  // News + social sentiment block (Grok, refreshed ≤10m). Shows both channels
  // separately so the model can spot news/social divergences.
  let newsLine = 'News + social sentiment: unavailable';
  if (newsSentiment) {
    const sgn = (n) => n == null ? 'n/a' : (n >= 0 ? `+${n}` : `${n}`);
    const newsBit = `news ${sgn(newsSentiment.news_score)} (${newsSentiment.summary || '—'})`;
    const socBit  = `social ${sgn(newsSentiment.social_score)} (${newsSentiment.social_summary || '—'})`;
    const insights = newsSentiment.insights?.length ? '\n  Key insights: ' + newsSentiment.insights.map(i => '• ' + i).join('  ') : '';
    newsLine = `Real-time sentiment (Grok, last 6-24h): blended ${newsSentiment.label} (${sgn(newsSentiment.score)})\n  ${newsBit}\n  ${socBit}${insights}`;
  }

  // Technical indicators block — used by BOTH strategies.
  let indicatorsLine = 'Technical indicators: unavailable';
  if (indicators && indicators.ok) {
    const m = indicators.macd;
    const v = indicators.volume;
    const vol = indicators.volatility;
    indicatorsLine = `Technical indicators:
  RSI(14): ${indicators.rsi} (${indicators.rsiLabel})
  MACD(12,26,9): macd=${m ? m.macd : 'n/a'} signal=${m ? m.signal : 'n/a'} hist=${m ? m.histogram : 'n/a'} (${m ? m.cross : 'n/a'})
  Volume trend (last 5 vs prior 20): ${v ? v.ratio + 'x' : 'n/a'} (${v ? v.label : 'n/a'})
  Volatility: ATR ${vol ? vol.atrPct + '%' : 'n/a'} · stdev ${vol ? vol.stddevPctPerBar + '%/bar' : 'n/a'} (${vol ? vol.label : 'n/a'})`;
  }

  // --- Day strategy (intraday scalp) -----------------------------------
  if (strategyName !== 'swing') {
    // Compact intraday-pattern block (last ~60 1-min bars)
    let dayPatternsBlock = 'Intraday structure (last 60 min): unavailable';
    if (patterns && patterns.ok) {
      const s = patterns.structure || {};
      const ns = patterns.nearestSupport ? `$${patterns.nearestSupport.price} (${patterns.nearestSupport.distPct}% below)` : 'n/a';
      const nr = patterns.nearestResistance ? `$${patterns.nearestResistance.price} (${patterns.nearestResistance.distPct}% above)` : 'n/a';
      const sup = (patterns.supports || []).slice(0, 2).map(x => `$${x.price}(×${x.touches})`).join(', ') || 'none';
      const res = (patterns.resistances || []).slice(0, 2).map(x => `$${x.price}(×${x.touches})`).join(', ') || 'none';
      const vwapLine = patterns.vwap != null
        ? `\n  VWAP: $${patterns.vwap} (${patterns.vwapState}, ${patterns.vwapDevPct >= 0 ? '+' : ''}${patterns.vwapDevPct}%)`
        : '';
      dayPatternsBlock = `Intraday structure (last ~60 min, 1-min bars):
  Trend: ${patterns.trend} (slope ${patterns.slopePctPerBar}%/bar) · Above SMA20: ${patterns.aboveSma20 ? 'yes' : 'no'}${vwapLine}
  Structure: HH=${s.higherHighs} HL=${s.higherLows} LH=${s.lowerHighs} LL=${s.lowerLows}
  Recent swing highs: ${(s.recentHighs || []).map(p => '$' + p).join(' → ') || 'n/a'}
  Recent swing lows:  ${(s.recentLows || []).map(p => '$' + p).join(' → ') || 'n/a'}
  Support: ${sup} · Resistance: ${res}
  Nearest support: ${ns} · Nearest resistance: ${nr}
  Breakout state: ${patterns.breakout}`;
    }

    // Tactical setup flags — dip-buy / profit-take.
    // Distinguish "no setup found" (clean scan) from "couldn't compute"
    // (insufficient bars) so models don't conflate them.
    let intradayBlock;
    if (!intraday || !intraday.ok) {
      intradayBlock = `Tactical setups: unavailable (${intraday?.reason || 'not computed'}).`;
    } else {
      const parts = [];
      if (intraday.dipBuy) {
        parts.push(`🟢 DIP-BUY SETUP (${intraday.dipBuy.strength}, score ${intraday.dipBuy.score}/5): ${intraday.dipBuy.description}`);
      }
      if (intraday.profitTake) {
        parts.push(`🟡 PROFIT-TAKE SETUP (${intraday.profitTake.strength}): ${intraday.profitTake.description}`);
      }
      intradayBlock = parts.length
        ? `Tactical setups detected:\n  ${parts.join('\n  ')}`
        : `Tactical setups: scanned, none triggered this cycle (no dip-buy or profit-take pattern present).`;
    }

    return `You are a ${role}
You are evaluating ${symbol} for an INTRADAY DAY-TRADE (scalp on 1-min bars, auto-flattens before close — no overnight risk). Decisions must respect the last 30-60 minutes of price action far more than longer-term context.

${positionLine}
Portfolio cash: $${portfolio.cash_balance}
Recent bars (last 5 of 1-min): ${JSON.stringify(priceData.bars)}
Latest price: $${priceData.latest} · Period change: ${priceData.change} · Period high/low: $${priceData.high} / $${priceData.low}
Short-term price action: ${sentiment}
${newsLine}

${indicatorsLine}

${dayPatternsBlock}

${intradayBlock}
${historicalBlock}${premarketBlock}${upgradeContext}
Decision guidance for INTRADAY trades:
  • DIP-BUY (favor BUY) — pullback to support after a leg up, with reversal candle + rising volume + RSI 30-60 + news/social not bearish. The strongest dip-buys have a confirmed higher-low forming AND price within 0.6% of a clustered support level. A flagged DIP_BUY_SETUP above is a strong prior — weight it heavily, especially if score ≥ 4.
  • BREAKOUT (favor BUY) — fresh close above a 60-min resistance with expanding volume, MACD bullish cross, RSI < 70. Avoid chasing if RSI > 75 or volume is flat.
  • PROFIT-TAKE (favor SELL when holding) — open position is in profit and price is at/within 0.4% of resistance, OR RSI ≥ 70 with first lower close, OR MACD bearish cross, OR volume drying up. A flagged PROFIT_TAKE_SETUP above is a strong prior to exit. Don't give back a winner because you're greedy.
  • SELL also when an open position breaks support, MACD turns bearish on rising volume, or news/social turns sharply negative.
  • Prefer HOLD when channels conflict (e.g. bullish price but bearish social, overbought RSI on weak volume), when no clear pattern is present, when within 5 minutes of a major resistance/support and direction is ambiguous, or when volatility label is "high" with no clear setup.
  • A tactical setup flagged above is a structured prior — strong agreement across price action + indicators + setup + sentiment should give 80%+ confidence; mixed signals should stay under 70%.

You must respond in EXACTLY this format (no markdown, no extra text):
DECISION: BUY|SELL|HOLD
CONFIDENCE: <integer 0-100>
RATIONALE: <one or two sentences citing the strongest setup or signal>`;
  }

  // --- Swing (longer-hold) — richer prompt with patterns + fundamentals -
  let patternsBlock = 'Pattern analysis: unavailable';
  if (patterns && patterns.ok) {
    const s = patterns.structure || {};
    const sup = (patterns.supports || []).map(x => `$${x.price}(×${x.touches})`).join(', ') || 'none identified';
    const res = (patterns.resistances || []).map(x => `$${x.price}(×${x.touches})`).join(', ') || 'none identified';
    const ns = patterns.nearestSupport ? `$${patterns.nearestSupport.price} (${patterns.nearestSupport.distPct}% below)` : 'n/a';
    const nr = patterns.nearestResistance ? `$${patterns.nearestResistance.price} (${patterns.nearestResistance.distPct}% above)` : 'n/a';
    const swingVwapLine = patterns.vwap != null
      ? `\n  VWAP: $${patterns.vwap} (${patterns.vwapState}, ${patterns.vwapDevPct >= 0 ? '+' : ''}${patterns.vwapDevPct}%)`
      : '';
    patternsBlock = `Pattern analysis (computed from 60×15-min bars):
  Trend: ${patterns.trend} (slope ${patterns.slopePctPerBar}%/bar)
  Above SMA20: ${patterns.aboveSma20 ? 'yes' : 'no'} ($${patterns.sma20}) · Above SMA50: ${patterns.aboveSma50 ? 'yes' : 'no'} ($${patterns.sma50})${swingVwapLine}
  Structure: higherHighs=${s.higherHighs} higherLows=${s.higherLows} lowerHighs=${s.lowerHighs} lowerLows=${s.lowerLows}
  Recent swing highs: ${(s.recentHighs || []).map(p => '$' + p).join(' → ') || 'n/a'}
  Recent swing lows:  ${(s.recentLows || []).map(p => '$' + p).join(' → ') || 'n/a'}
  Support levels: ${sup}
  Resistance levels: ${res}
  Nearest support: ${ns} · Nearest resistance: ${nr}
  Breakout state: ${patterns.breakout}`;
  }

  let fundamentalsBlock = 'Fundamentals: unavailable';
  if (fundamentals) {
    const pe   = fundamentals.pe_ratio != null ? fundamentals.pe_ratio : 'n/a';
    const eps  = fundamentals.eps_growth_yoy_pct != null ? `${fundamentals.eps_growth_yoy_pct}%` : 'n/a';
    const rev  = fundamentals.revenue_growth_yoy_pct != null ? `${fundamentals.revenue_growth_yoy_pct}%` : 'n/a';
    const earn = fundamentals.earnings_next_date || 'n/a';
    const sur  = fundamentals.earnings_recent_surprise_pct != null ? `${fundamentals.earnings_recent_surprise_pct}%` : 'n/a';
    const sect30 = fundamentals.sector_strength_30d_pct != null ? `${fundamentals.sector_strength_30d_pct}%` : 'n/a';
    fundamentalsBlock = `Fundamentals & macro (Grok, refreshed ≤6h):
  Sector: ${fundamentals.sector || 'n/a'} (${fundamentals.sector_strength_label}, 30d ${sect30})
  Valuation: ${fundamentals.valuation_label} · P/E: ${pe}
  Latest quarter — Revenue YoY: ${rev}, EPS YoY: ${eps}, EPS surprise vs est: ${sur}
  Next earnings: ${earn}
  Macro context: ${fundamentals.macro_context || 'n/a'}`;
  }

  return `You are a ${role}
You are evaluating ${symbol} for a SWING (multi-day longer-hold) trade. This is NOT an intraday scalp — you may hold for several sessions, so weigh fundamentals, sector backdrop, and multi-bar structure as much as recent price action.

${positionLine}
Portfolio cash: $${portfolio.cash_balance}
Latest price: $${priceData.latest} · Period change: ${priceData.change} · Period high/low: $${priceData.high} / $${priceData.low}
Recent bars (last 5 of 15-min): ${JSON.stringify(priceData.bars)}
Short-term price action: ${sentiment}
${newsLine}

${indicatorsLine}

${patternsBlock}

${fundamentalsBlock}
${historicalBlock}${premarketBlock}${upgradeContext}
Decision guidance for SWING trades:
  • Favor BUY when trend is up, indicators confirm (RSI 45-70, MACD positive or fresh bullish cross, expanding volume), structure shows higher highs/lows OR a fresh breakout, sector is strong/flat, valuation is fair-to-cheap or growth strongly justifies a richer multiple, and news+social sentiment isn't actively bearish.
  • Favor SELL when trend is down, indicators deteriorate (RSI rolling over from overbought, MACD bearish cross, volume drying up), structure shows lower highs/lows OR a breakdown, sector is weak, or fundamentals weaken (negative EPS/revenue growth, recent miss).
  • AVOID new BUYs within 2 trading days of earnings (use earnings_next_date) — flag in rationale and prefer HOLD.
  • Elevated/high volatility → trim confidence and prefer waiting for a cleaner setup.
  • Conflict between technicals, sentiment, and fundamentals → lower confidence.
  • If a position is open, weigh whether to hold for the swing target vs. exit; respect the existing trailing stop logic in the agent.

You must respond in EXACTLY this format (no markdown, no extra text):
DECISION: BUY|SELL|HOLD
CONFIDENCE: <integer 0-100>
RATIONALE: <one or two sentences citing the strongest pattern + fundamentals signal>`;
}

function parseModelResponse(text, modelMeta) {
  const decisionMatch = text.match(/DECISION:\s*(BUY|SELL|HOLD)/i);
  const confidenceMatch = text.match(/CONFIDENCE:\s*(\d+(?:\.\d+)?)/i);
  const rationaleMatch = text.match(/RATIONALE:\s*([\s\S]+)/i);

  return {
    model: modelMeta.id,
    label: modelMeta.label,
    role: modelMeta.role,
    action: decisionMatch ? decisionMatch[1].toUpperCase() : 'HOLD',
    confidence: confidenceMatch ? Math.min(100, parseFloat(confidenceMatch[1])) / 100 : 0.5,
    rationale: rationaleMatch ? rationaleMatch[1].trim().slice(0, 400) : text.slice(0, 200),
  };
}

async function callOpenRouter(model, prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  try {
    const res = await axios.post(
      OPENROUTER_URL,
      {
        model: model.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 256,
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://alphatrade.replit.app',
          'X-Title': 'AlphaTrade AI',
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );
    const text = res.data?.choices?.[0]?.message?.content || '';
    return parseModelResponse(text, model);
  } catch (e) {
    console.error(`[LLM:${model.id}] error:`, e.response?.data?.error?.message || e.message);
    return { model: model.id, label: model.label, role: model.role, action: 'HOLD', confidence: 0, rationale: `Error: ${e.message}`, error: true };
  }
}

async function callXAI(model, prompt) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return null;
  try {
    const res = await axios.post(
      XAI_URL,
      {
        model: model.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 256,
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );
    const text = res.data?.choices?.[0]?.message?.content || '';
    return parseModelResponse(text, model);
  } catch (e) {
    console.error(`[LLM:${model.id}] error:`, e.response?.data?.error?.message || e.message);
    return { model: model.id, label: model.label, role: model.role, action: 'HOLD', confidence: 0, rationale: `Error: ${e.message}`, error: true };
  }
}

async function queryModel(model, prompt) {
  if (model.provider === 'openrouter') return callOpenRouter(model, prompt);
  if (model.provider === 'xai') return callXAI(model, prompt);
  return null;
}

async function getEnsembleDecision({ symbol, priceData, sentiment, newsSentiment, holding, portfolio, patterns, fundamentals, indicators, intraday, historical, strategyName, premarket, adaptiveHints, portfolioRisk, orderFlow, optionsActivity, optionsFlow, earningsSignal, regimeContext, knowledgeContext, macroForecast, scenarioSim, regime, market, causalContext, counterfactualContext, experienceContext, propagationContext, feedbackContext, feedbackShrinkage }) {
  // ---------------------------------------------------------------------
  // STEP 1 — Resolve dynamic per-model weights for this (strategy, regime,
  // market) context. Cold-start safe (uniform 1.0). Failures degrade to
  // null → caller treats as uniform.
  // ---------------------------------------------------------------------
  let weightSnap = null, weightsBlock = null;
  try {
    weightSnap = await llmWeighting.getWeights({ strategy: strategyName, regime, market });
    weightsBlock = llmWeighting.renderForPrompt(weightSnap);
  } catch (_) { /* silent — uniform weights */ }

  // ---------------------------------------------------------------------
  // STEP 2 — Inject prior meta-reasoner opinion (from last cycle, same
  // strategy:symbol) so each voter sees the prior take and can disagree.
  // ---------------------------------------------------------------------
  const metaKey = `${strategyName || 'day'}:${symbol}`;
  const priorMetaObj = metaReasoner.getLast(metaKey);
  const priorMetaBlock = metaReasoner.renderForPrompt(priorMetaObj);

  // ---------------------------------------------------------------------
  // STEP 3 — Run the 4 model votes in parallel (existing behaviour).
  // ---------------------------------------------------------------------
  const calls = MODELS.map(m =>
    queryModel(m, buildPrompt({ symbol, priceData, sentiment, newsSentiment, holding, portfolio, role: m.role, patterns, fundamentals, indicators, intraday, historical, strategyName, premarket, adaptiveHints, portfolioRisk, orderFlow, optionsActivity, optionsFlow, earningsSignal, regimeContext, knowledgeContext, macroForecast, scenarioSim, ensembleWeights: weightsBlock, priorMeta: priorMetaBlock, causalContext, counterfactualContext, experienceContext, propagationContext, feedbackContext }))
  );
  const settled = await Promise.allSettled(calls);
  const results = settled
    .map((r, i) => (r.status === 'fulfilled' && r.value) ? r.value : null)
    .filter(Boolean);

  const valid = results.filter(r => !r.error);

  if (valid.length < MIN_VALID_MODELS) {
    return {
      consensus: 'HOLD',
      confidence: 0,
      votes: { BUY: 0, SELL: 0, HOLD: MODELS.length },
      models: results,
      reason: `Only ${valid.length}/${MODELS.length} models returned (need ${MIN_VALID_MODELS}). Forcing HOLD for safety.`,
      weights: weightSnap?.weights || null,
    };
  }

  // ---------------------------------------------------------------------
  // RAW (unweighted) tally — feeds riskManager.checkQuorum unchanged.
  // ---------------------------------------------------------------------
  const votes = { BUY: 0, SELL: 0, HOLD: 0 };
  let confSum = { BUY: 0, SELL: 0, HOLD: 0 };
  valid.forEach(r => {
    votes[r.action] = (votes[r.action] || 0) + 1;
    confSum[r.action] = (confSum[r.action] || 0) + r.confidence;
  });
  const rawConsensus = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  const rawAvgConfidence = votes[rawConsensus] > 0 ? confSum[rawConsensus] / votes[rawConsensus] : 0;
  const agreementCount = votes[rawConsensus];
  const agreementRatio = agreementCount / valid.length;

  // ---------------------------------------------------------------------
  // WEIGHTED tally — informational. Computes both (a) weighted vote sums
  // by action and (b) weighted-confidence on the raw consensus side.
  // ---------------------------------------------------------------------
  const weightedVotes = { BUY: 0, SELL: 0, HOLD: 0 };
  let weightedConfSum = { BUY: 0, SELL: 0, HOLD: 0 };
  let weightedConfDenom = { BUY: 0, SELL: 0, HOLD: 0 };
  valid.forEach(r => {
    const w = weightSnap?.weights?.[r.model]?.weight ?? 1.0;
    weightedVotes[r.action] = (weightedVotes[r.action] || 0) + w;
    weightedConfSum[r.action] = (weightedConfSum[r.action] || 0) + r.confidence * w;
    weightedConfDenom[r.action] = (weightedConfDenom[r.action] || 0) + w;
  });
  const weightedConsensus = Object.entries(weightedVotes).sort((a, b) => b[1] - a[1])[0][0];
  const weightedConfidence = weightedConfDenom[rawConsensus] > 0
    ? weightedConfSum[rawConsensus] / weightedConfDenom[rawConsensus]
    : rawAvgConfidence;

  // SAFETY FLOOR — the gate confidence we expose downstream is
  // min(rawAvgConfidence, weightedConfidence). This means dynamic weights
  // can ONLY tighten the existing gate, never relax it. If high-weight
  // models disagree with the majority, weightedConfidence drops below
  // rawAvgConfidence and the gate gets stricter. If low-weight models
  // drive the majority and high-weight models agree, weightedConfidence
  // can be ABOVE rawAvgConfidence — but we use the lower of the two so
  // the gate never becomes easier to clear.
  // FEEDBACK SHRINKAGE — bounded factor in [0.85, 1.00] from the human-in-
  // the-loop layer. Multiplicative on the gate confidence; the floor keeps
  // it incapable of trivialising the gate, the ceiling of 1.0 enforces the
  // ONE-WAY safety contract: feedback can ONLY tighten the gate, never
  // relax it. min() then composes with the existing weight-based safety
  // floor so all defenses stack rather than override.
  const fbShrink = (Number.isFinite(feedbackShrinkage) && feedbackShrinkage > 0 && feedbackShrinkage <= 1.0)
    ? feedbackShrinkage : 1.0;
  const gateConfidence = Math.min(rawAvgConfidence, weightedConfidence) * fbShrink;

  // ---------------------------------------------------------------------
  // STEP 4 — Run the meta-reasoner synthesis. This is informational only;
  // failures swallow and return null.
  // ---------------------------------------------------------------------
  let meta = null;
  try {
    meta = await metaReasoner.synthesize({
      symbol, strategy: strategyName, regime, market,
      votes, weights: weightSnap, modelResults: results,
    });
    if (meta) metaReasoner.rememberLast(metaKey, meta);
  } catch (_) { /* swallow */ }

  return {
    // EXISTING contract — unchanged shape, used by riskManager.checkQuorum.
    consensus: rawConsensus,
    confidence: gateConfidence,
    agreement: agreementRatio,
    agreementCount,
    validCount: valid.length,
    totalModels: MODELS.length,
    votes,
    models: results,
    reason: `${agreementCount}/${valid.length} models agree on ${rawConsensus} (raw avg conf ${(rawAvgConfidence * 100).toFixed(0)}%, gate conf ${(gateConfidence * 100).toFixed(0)}%)`,
    // NEW informational fields — surfaced in audit + dashboard. Do NOT
    // gate trading; risk manager continues to read consensus + confidence.
    rawConfidence: rawAvgConfidence,
    weightedConsensus,
    weightedConfidence,
    weightedVotes: Object.fromEntries(Object.entries(weightedVotes).map(([k, v]) => [k, +v.toFixed(3)])),
    weights: weightSnap?.weights || null,
    weightContext: weightSnap ? { strategy: weightSnap.strategy, regime: weightSnap.regime, market: weightSnap.market } : null,
    feedbackShrinkage: fbShrink,
    meta, // { action, confidence, rationale, model, ts } | null
  };
}

function getProviderStatus() {
  return {
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    xai: Boolean(process.env.XAI_API_KEY || process.env.GROK_API_KEY),
    models: MODELS.map(m => ({ id: m.id, label: m.label, role: m.role, provider: m.provider })),
  };
}

module.exports = { getEnsembleDecision, getProviderStatus, MODELS };
