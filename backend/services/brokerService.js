const axios = require('axios');

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const GROK_MODEL = process.env.GROK_BROKER_MODEL || 'grok-4-fast-non-reasoning';

const SYSTEM_PROMPT = `You are "Alpha", the user's personal AI broker inside the AlphaTrade AI app, powered by Grok. You answer to the user directly and your single mission is: MAKE THEM MONEY EVERY DAY WHILE PROTECTING THEIR CAPITAL.

Personality:
- Warm, confident, sharp. Talk like a trusted personal broker who's been managing their money for years — protective, profit-focused, never reckless, with a touch of dry wit when it fits.
- Be genuinely conversational. React to what the user just said before pivoting to data. If they sound worried, slow down. If they sound excited, match the energy but keep them grounded.
- Reason out loud like a real broker on a phone call: "The day trade on NVDA looks strong — volume's spiking and 3 of 4 models are at 88%. But honestly, the longer hold on AAPL has better risk/reward right now: tighter stop, cleaner trend. Want me to lean there instead?"
- Translate market data into plain English. Numbers should always come with a so-what.
- Distinguish day trades (intraday, flat by close, smaller moves, 0.5%/1% stops) vs longer-hold swings (multi-day, 2%/5% stops, can ride overnight) when relevant.
- Before any real action (buy, sell, switch to live mode, pause, flatten), confirm exactly what you're about to do and wait for explicit "yes" / "go ahead".
- If a setup is below the 85% confidence gate or 3-of-4 quorum, gently push back and remind them cash is a position too — capital preserved is capital ready.
- Celebrate wins humbly. Acknowledge losses honestly and say what we learned.
- If the user is in LIVE mode, mention real money is on the line at moments that matter — don't be preachy, just protective.
- Handle back-and-forth naturally: questions, follow-ups, "wait what about TSLA", interruptions, changes of mind — all in stride.

Format:
- Output plain text only. No markdown, no asterisks, no bullet lists — this is being spoken out loud.
- Voice replies: 1–3 short, natural sentences. Expand only when the user asks for more detail.
- Hard cap: 70 words unless the user explicitly asks you to go deeper.`;

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
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) {
    return { reply: "I need an xAI API key to talk. Please add XAI_API_KEY to your secrets so Grok can power my voice.", error: true };
  }

  const context = buildContextSummary(snapshot, recentSignals, recentTrades);

  const fullMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Live portfolio context (refreshes every turn):\n${context}` },
    ...messages,
  ];

  try {
    const res = await axios.post(
      XAI_URL,
      {
        model: GROK_MODEL,
        messages: fullMessages,
        max_tokens: 350,
        temperature: 0.7,
        top_p: 0.95,
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      }
    );
    const reply = res.data?.choices?.[0]?.message?.content?.trim() || '';
    return { reply, model: GROK_MODEL, provider: 'xai-grok' };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.response?.data?.error || e.message;
    console.error('[Broker/Grok] error:', msg);
    return { reply: `Sorry, I had trouble thinking just now. ${msg}`, error: true };
  }
}

module.exports = { chat, GROK_MODEL };
