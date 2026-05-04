const axios = require('axios');

const SYSTEM_PROMPT = `You are "Alpha", the user's personal AI broker inside the AlphaTrade AI app.

Personality:
- Warm, trustworthy, protective. Talk like a seasoned mentor who genuinely cares about the user's money.
- Never aggressive, never reckless. Your #1 rule: never lose money. #2: capture profits, big or small.
- Speak in plain English, conversational, second person ("you / your portfolio"). Brief and clear — 1-3 short sentences for voice replies.
- When discussing a potential trade, always reason out loud: confidence level, what each model thinks, why you agree or disagree, and what could go wrong.
- If the user asks you to take an action (buy, sell, pause, resume), confirm what you're about to do before acting and ask for explicit "yes" / "go ahead".
- If a trade is risky or below the 85% confidence gate, gently push back and explain why holding cash is a perfectly good move.
- Celebrate wins humbly. Acknowledge losses honestly and explain what we learned.

Format:
- Output plain text only. No markdown, no bullet lists in voice replies.
- Keep responses under 60 words unless the user explicitly asks for detail.`;

function buildContextSummary(snapshot, recentSignals, recentTrades) {
  const lines = [];
  lines.push(`Mode: ${snapshot.mode}. Agent ${snapshot.running ? 'running' : 'stopped'}${snapshot.emergencyPause ? ', EMERGENCY PAUSED' : ''}${snapshot.circuitBreakerTripped ? ', CIRCUIT BREAKER TRIPPED' : ''}.`);
  lines.push(`Equity $${snapshot.equity?.toFixed(2)}, cash $${snapshot.cash?.toFixed(2)}, daily P&L ${snapshot.dailyPnL >= 0 ? '+' : ''}$${snapshot.dailyPnL?.toFixed(2)} (${snapshot.dailyPnLPct?.toFixed(2)}%), total P&L ${snapshot.totalPnL >= 0 ? '+' : ''}$${snapshot.totalPnL?.toFixed(2)}.`);
  if (snapshot.holdings?.length) {
    lines.push(`Open positions: ${snapshot.holdings.map(h => `${h.symbol} ${h.qty}sh @$${h.avgCost.toFixed(2)} (now $${h.currentPrice.toFixed(2)})`).join(', ')}.`);
  } else {
    lines.push('No open positions.');
  }
  if (recentSignals?.length) {
    const top = recentSignals.slice(0, 5).map(s =>
      `${s.symbol}: ${s.signal} ${(s.confidence * 100).toFixed(0)}%`
    ).join(', ');
    lines.push(`Latest signals: ${top}.`);
  }
  if (recentTrades?.length) {
    lines.push(`Last trade: ${recentTrades[0].side} ${recentTrades[0].qty} ${recentTrades[0].symbol} @$${parseFloat(recentTrades[0].price).toFixed(2)}.`);
  }
  lines.push(`Risk gates: 85% confidence required, max 3% per position, 5% daily drawdown stops everything.`);
  return lines.join('\n');
}

async function chat({ messages, snapshot, recentSignals, recentTrades }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return { reply: 'I need an OpenRouter API key to talk. Please add OPENROUTER_API_KEY to your secrets.', error: true };
  }

  const context = buildContextSummary(snapshot, recentSignals, recentTrades);

  const fullMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Live portfolio context:\n${context}` },
    ...messages,
  ];

  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'anthropic/claude-3.7-sonnet',
        messages: fullMessages,
        max_tokens: 300,
        temperature: 0.6,
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://alphatrade.replit.app',
          'X-Title': 'AlphaTrade AI Broker',
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      }
    );
    const reply = res.data?.choices?.[0]?.message?.content?.trim() || '';
    return { reply };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    return { reply: `Sorry, I had trouble thinking just now. ${msg}`, error: true };
  }
}

module.exports = { chat };
