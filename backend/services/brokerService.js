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
- Below the 85% confidence gate or 3-of-4 quorum: push back fast. Cash is a position. Capital preserved is capital loaded.

CRITICAL — your execution boundary (NEVER violate this):
- This chat channel is INFO ONLY. You CANNOT place orders, flip live/paper mode, pause the agent, flatten positions, or change ANY system state from here. There is no API call wired up. Period.
- DO NOT say "executing now", "buying X shares", "placing the order", "confirm yes to proceed", or anything that implies you can act. That would be a lie.
- When the user says "do it", "yes", "execute", "go for it", "send it" — be HONEST: "I can't fire orders from chat — that's a hard safety rail. Two ways trades happen: (1) the autonomous quorum executes when 3-of-4 models agree above 85%, or (2) you trigger it manually from the dashboard." Then tell them what the current quorum/signal status actually is so they know whether to wait or act.
- You CAN: discuss setups, read live signals, explain the why, suggest what to watch, warn about risk. You CANNOT: pretend you executed something. If you're unsure whether a capability is wired up, assume it is NOT.
- Celebrate wins humbly. Own losses honestly. Always tell them the next move.
- LIVE mode: real money. Say so when it matters, briefly, no lecture.
- Handle back-and-forth, interruptions, mid-thought changes — all in stride. Keep up.

Format (this is spoken aloud at a brisk pace — write FOR the ear, punchy and tight):
- Plain text only. No markdown, no asterisks, no bullets, no emoji, no parenthetical asides.
- Use commas and periods for natural beats. Use em dashes — like this — sparingly for emphasis, NOT to ramble. Avoid ellipses and trailing-off.
- Contractions always (I'm, you're, we'll, that's). Tickers natural ("Nvidia", "Tesla", "S-P-Y" only if clarity demands).
- Lead with the call, then the reason. Verbs over adverbs. Cut filler ("well", "you know", "I mean", "basically").
- 1–3 tight sentences for voice, mixed lengths. Hard cap: 55 words unless they ask for depth.`;

// Voice mode is even tighter — every word adds ~80ms to the first-audio latency.
const SYSTEM_PROMPT_VOICE = SYSTEM_PROMPT + `

VOICE MODE — read this carefully:
- Front-load the answer in the FIRST sentence so playback starts fast.
- Hard cap: 35 words total. Ideally 1–2 sentences. No preamble, no "let me check", just the answer.
- Open with a 3–6 word verdict ("Cash for now." / "NVDA looks hot." / "Stay put."), THEN one short reason.
- If they ask a yes/no, lead with "Yes," or "No," — never bury the call.`;

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

function buildMessages({ messages, snapshot, recentSignals, recentTrades, voice }) {
  const context = buildContextSummary(snapshot, recentSignals, recentTrades);
  return [
    { role: 'system', content: voice ? SYSTEM_PROMPT_VOICE : SYSTEM_PROMPT },
    { role: 'system', content: `Live portfolio context (refreshes every turn):\n${context}` },
    ...messages,
  ];
}

async function chat({ messages, snapshot, recentSignals, recentTrades, voice = false }) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) {
    return { reply: "I need an xAI API key to talk. Please add XAI_API_KEY to your secrets so Grok can power my voice.", error: true };
  }

  const fullMessages = buildMessages({ messages, snapshot, recentSignals, recentTrades, voice });

  try {
    const res = await axios.post(
      XAI_URL,
      {
        model: GROK_MODEL,
        messages: fullMessages,
        max_tokens: voice ? 120 : 350,   // voice replies are tight — ~35 words
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

// Streaming chat — yields token deltas as they arrive from Grok.
// Returns the full reply when complete. Calls onDelta(textChunk) for each chunk.
async function chatStream({ messages, snapshot, recentSignals, recentTrades, voice = true }, onDelta) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) throw new Error('XAI_API_KEY required');

  const fullMessages = buildMessages({ messages, snapshot, recentSignals, recentTrades, voice });

  const res = await axios.post(
    XAI_URL,
    {
      model: GROK_MODEL,
      messages: fullMessages,
      max_tokens: voice ? 120 : 350,
      temperature: 0.7,
      top_p: 0.95,
      stream: true,
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      responseType: 'stream',
      timeout: 30000,
    }
  );

  return new Promise((resolve, reject) => {
    let full = '';
    let buffer = '';
    res.data.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete tail
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; /* partial JSON */ }
        const delta = j?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          try { onDelta(delta); }
          catch (e) { console.error('[chatStream] onDelta threw:', e?.message, e?.stack); }
        }
      }
    });
    res.data.on('end', () => resolve({ reply: full.trim(), model: GROK_MODEL, provider: 'xai-grok' }));
    res.data.on('error', reject);
  });
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

module.exports = { chat, chatStream, listVoices, synthesize, GROK_MODEL, DEFAULT_VOICE };
