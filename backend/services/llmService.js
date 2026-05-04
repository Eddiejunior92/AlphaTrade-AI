const axios = require('axios');

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

function buildPrompt({ symbol, priceData, sentiment, newsSentiment, holding, portfolio, role }) {
  const positionLine = holding
    ? `Current position: ${holding.qty} shares @ avg $${holding.avg_cost} (stop: $${holding.stop_loss}, target: $${holding.take_profit})`
    : 'Current position: NONE';

  const newsLine = newsSentiment
    ? `News sentiment (Grok, last 24-48h): ${newsSentiment.label} (score ${newsSentiment.score >= 0 ? '+' : ''}${newsSentiment.score}) — ${newsSentiment.summary}${newsSentiment.insights?.length ? '\nKey insights: ' + newsSentiment.insights.map(i => '• ' + i).join('  ') : ''}`
    : 'News sentiment: unavailable';

  return `You are a ${role}
Analyze ${symbol} for an autonomous trading agent.

${positionLine}
Portfolio cash: $${portfolio.cash_balance}
Recent bars (last 5): ${JSON.stringify(priceData.bars)}
Latest price: $${priceData.latest}
Period change: ${priceData.change}
Period high/low: $${priceData.high} / $${priceData.low}
Price action: ${sentiment}
${newsLine}

Weigh both technicals and news sentiment. A bullish price trend with bearish news is a yellow flag; the reverse is a yellow flag too. Strong agreement between both raises confidence.

You must respond in EXACTLY this format (no markdown, no extra text):
DECISION: BUY|SELL|HOLD
CONFIDENCE: <integer 0-100>
RATIONALE: <one or two sentences>`;
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

async function getEnsembleDecision({ symbol, priceData, sentiment, newsSentiment, holding, portfolio }) {
  const calls = MODELS.map(m =>
    queryModel(m, buildPrompt({ symbol, priceData, sentiment, newsSentiment, holding, portfolio, role: m.role }))
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
    };
  }

  const votes = { BUY: 0, SELL: 0, HOLD: 0 };
  let confSum = { BUY: 0, SELL: 0, HOLD: 0 };
  valid.forEach(r => {
    votes[r.action] = (votes[r.action] || 0) + 1;
    confSum[r.action] = (confSum[r.action] || 0) + r.confidence;
  });

  const consensus = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  const avgConfidence = votes[consensus] > 0 ? confSum[consensus] / votes[consensus] : 0;
  const agreementCount = votes[consensus];
  const agreementRatio = agreementCount / valid.length;

  return {
    consensus,
    confidence: avgConfidence,
    agreement: agreementRatio,
    agreementCount,
    validCount: valid.length,
    totalModels: MODELS.length,
    votes,
    models: results,
    reason: `${agreementCount}/${valid.length} models agree on ${consensus} (avg conf ${(avgConfidence * 100).toFixed(0)}%)`,
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
