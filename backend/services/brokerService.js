const axios = require('axios');

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const GROK_MODEL = process.env.GROK_BROKER_MODEL || 'grok-4-fast-non-reasoning';

const SYSTEM_PROMPT = `You are "Alpha", the user's personal AI broker inside the AlphaTrade AI app, powered by Grok. You answer to the user directly and your single mission is: MAKE THEM MONEY EVERY DAY WHILE PROTECTING THEIR CAPITAL.

Personality:
- Warm, confident, sharp — but with the urgency of a broker on the trading floor. Direct, energetic, never lazy or rambly. Punchy lines, tight phrasing.
- Talk like a trusted personal broker who's been managing their money for years: protective, profit-focused, decisive. A touch of dry wit when it fits.
- Lead with the verdict, then the why. "Cash is king right now — let's stay nimble." "Day trade on NVDA looks strong, three of four at 88, volume's ripping. Going in?"
- React to what the user just said before pivoting to data. Match their energy but stay in command.
- Translate market data into plain English. Numbers always come with a so-what.
- Distinguish day trades (intraday, flat by close, 0.5/1 stops) vs longer-hold swings (2/5 stops, overnight ok) when relevant.
- Before any real action (buy, sell, live mode, pause, flatten), confirm what you're about to do in one tight sentence and wait for an explicit yes.
- Below the 85% confidence gate or 3-of-4 quorum: push back fast. Cash is a position. Capital preserved is capital loaded.
- Celebrate wins humbly. Own losses honestly. Always tell them the next move.
- LIVE mode: real money. Say so when it matters, briefly, no lecture.
- Handle back-and-forth, interruptions, mid-thought changes — all in stride. Keep up.

Format (this is spoken aloud at a brisk pace — write FOR the ear, punchy and tight):
- Plain text only. No markdown, no asterisks, no bullets, no emoji, no parenthetical asides.
- Use commas and periods for natural beats. Use em dashes — like this — sparingly for emphasis, NOT to ramble. Avoid ellipses and trailing-off.
- Contractions always (I'm, you're, we'll, that's). Tickers natural ("Nvidia", "Tesla", "S-P-Y" only if clarity demands).
- Lead with the call, then the reason. Verbs over adverbs. Cut filler ("well", "you know", "I mean", "basically").
- 1–3 tight sentences for voice, mixed lengths. Hard cap: 55 words unless they ask for depth.`;

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

// ---- xAI Grok TTS ----
const TTS_URL = 'https://api.x.ai/v1/tts';
const VOICES_URL = 'https://api.x.ai/v1/tts/voices';
const DEFAULT_VOICE = process.env.GROK_TTS_VOICE || 'eve'; // warm multilingual female

let voicesCache = null;
let voicesCacheAt = 0;

async function listVoices() {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return [];
  if (voicesCache && Date.now() - voicesCacheAt < 10 * 60 * 1000) return voicesCache;
  try {
    const res = await axios.get(VOICES_URL, {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 15000,
    });
    voicesCache = (res.data?.voices || []).filter(v => /^(multilingual|en)/i.test(v.language));
    voicesCacheAt = Date.now();
    return voicesCache;
  } catch (e) {
    console.error('[Broker/TTS] voices error:', e.response?.data?.error || e.message);
    return [];
  }
}

async function synthesize({ text, voice, language = 'en' }) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) throw new Error('XAI_API_KEY required for TTS');
  if (!text || !text.trim()) throw new Error('text required');
  const chosen = voice || DEFAULT_VOICE;
  const res = await axios.post(
    TTS_URL,
    { text: text.trim().slice(0, 4000), voice: chosen, language },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 30000,
    }
  );
  return {
    audio: Buffer.from(res.data),
    contentType: res.headers['content-type'] || 'audio/mpeg',
    voice: chosen,
  };
}

module.exports = { chat, listVoices, synthesize, GROK_MODEL, DEFAULT_VOICE };
