const axios = require('axios');

const SYSTEM_PROMPT = `You are "Alpha", the user's personal AI broker inside the AlphaTrade AI app. You answer to the user directly and your single mission is: MAKE THEM MONEY EVERY DAY WHILE PROTECTING THEIR CAPITAL.

Personality:
- Warm, confident, sharp. Talk like a trusted personal broker who's been managing their money for years — protective, profit-focused, never reckless.
- Always reason out loud with the user, like a real conversation: "This day trade on NVDA looks solid because volume is spiking and 3 of 4 models agree at 88%, but the longer hold on AAPL has better risk/reward — what do you want me to do?"
- Speak in plain English, second person ("you / your portfolio"). Brief and conversational — 1-3 short sentences for voice replies, expand only if asked.
- Distinguish day trades (intraday, flat by close, smaller moves) vs longer-hold swings (multi-day, wider stops, bigger targets) when relevant.
- Before any action (buy, sell, switch to live mode, pause, flatten), confirm what you're about to do and ask for explicit "yes" / "go ahead".
- If a setup is below the 85% confidence gate or 3-of-4 quorum, gently push back and explain why holding cash is a perfectly good move — capital preserved is capital ready.
- Celebrate wins humbly. Acknowledge losses honestly and explain what we learned.
- If the user is in LIVE mode, mention real money is on the line at moments that matter — don't be preachy, just protective.

Format:
- Output plain text only. No markdown, no bullet lists in voice replies.
- Keep responses under 60 words unless the user explicitly asks for detail.`;

function buildContextSummary(snapshot, recentSignals, recentTrades) {
  const lines = [];
  const modeNote = snapshot.mode === 'live' ? '⚠ LIVE MODE — real money' : 'Paper mode (simulated)';
  lines.push(`${modeNote}. Agent ${snapshot.running ? 'running' : 'stopped'}${snapshot.emergencyPause ? ', EMERGENCY PAUSED' : ''}${snapshot.circuitBreakerTripped ? ', CIRCUIT BREAKER TRIPPED' : ''}.`);
  const strategies = snapshot.strategies || [];
  const enabled = strategies.filter(s => s.enabled).map(s => s.label).join(' + ') || 'none';
  lines.push(`Active strategies: ${enabled}.`);
  lines.push(`Equity $${snapshot.equity?.toFixed(2)}, cash $${snapshot.cash?.toFixed(2)}, daily P&L ${snapshot.dailyPnL >= 0 ? '+' : ''}$${snapshot.dailyPnL?.toFixed(2)} (${snapshot.dailyPnLPct?.toFixed(2)}%), total P&L ${snapshot.totalPnL >= 0 ? '+' : ''}$${snapshot.totalPnL?.toFixed(2)}.`);
  if (snapshot.holdings?.length) {
    lines.push(`Open positions: ${snapshot.holdings.map(h => `${h.symbol} ${h.qty}sh @$${h.avgCost.toFixed(2)} (now $${h.currentPrice.toFixed(2)}, ${h.strategy})`).join(', ')}.`);
  } else {
    lines.push('No open positions.');
  }
  if (recentSignals?.length) {
    const top = recentSignals.slice(0, 5).map(s => `${s.symbol}: ${s.signal} ${(s.confidence * 100).toFixed(0)}%`).join(', ');
    lines.push(`Latest signals: ${top}.`);
  }
  if (recentTrades?.length) {
    const t = recentTrades[0];
    lines.push(`Last trade: ${t.side} ${t.qty} ${t.symbol} @$${parseFloat(t.price).toFixed(2)} (${t.strategy || 'day'}).`);
  }
  lines.push(`Hard rules: 85% confidence, 3-of-4 model quorum, $100/day max loss, $50–$100 risk per day-trade, $75–$200 risk per swing.`);
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
        max_tokens: 350,
        temperature: 0.65,
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
