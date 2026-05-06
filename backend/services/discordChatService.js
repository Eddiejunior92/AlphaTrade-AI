// =============================================================================
// Discord chat interface — talk to Alpha from Discord.
//
// What this is:
//   • A lightweight Discord bot (discord.js v14) that listens for messages in
//     a designated channel (DISCORD_CHAT_CHANNEL_ID) AND for direct messages.
//   • Each incoming message is routed through brokerService.chat() — the same
//     xAI/Grok pipeline that powers the in-app voice chat. The reply uses the
//     full live portfolio context (snapshot + recent trades + recent signals)
//     so Alpha answers from real state.
//   • Replies are posted back in the same channel/DM. Long replies are split
//     into ≤ 1900-char chunks (Discord's hard limit is 2000) so they always
//     send.
//
// Safety contract — read carefully:
//   • This service is read/info ONLY. It does NOT expose trading commands.
//     There is no path here that calls placeOrder, setTradingMode, killSwitch,
//     or any other state-mutating endpoint. Even if a user types "BUY NVDA",
//     Alpha will discuss it but cannot execute it. All trading actions still
//     require operator-token-gated REST endpoints from the dashboard.
//   • The bot only responds in (a) the configured channel id or (b) DMs from
//     anyone with read access to the bot. Other channels are ignored to keep
//     server-wide noise down.
//
// Required setup (the bot no-ops cleanly without these):
//   • DISCORD_BOT_TOKEN — bot token from the Discord Developer Portal.
//   • DISCORD_CHAT_CHANNEL_ID — text channel id where Alpha replies (DMs
//     always work). Optional; if unset, only DMs work.
//   • Bot intents needed: GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT,
//     DIRECT_MESSAGES — ensure "Message Content Intent" is ON in the
//     Developer Portal under Bot → Privileged Gateway Intents.
// =============================================================================

const brokerService = require('./brokerService');

let _client = null;
let _started = false;

// Discord max message length is 2000 chars. We chunk at 1900 to leave room for
// formatting and never silently truncate.
const MAX_MSG = 1900;

function chunkReply(text) {
  const out = [];
  let s = String(text || '').trim();
  if (!s) return ["I didn't get a reply just now — try again in a moment."];
  while (s.length > MAX_MSG) {
    // Prefer to split on a sentence boundary near the limit.
    let cut = s.lastIndexOf('. ', MAX_MSG);
    if (cut < MAX_MSG * 0.5) cut = s.lastIndexOf(' ', MAX_MSG);
    if (cut <= 0) cut = MAX_MSG;
    out.push(s.slice(0, cut + 1).trim());
    s = s.slice(cut + 1).trim();
  }
  if (s) out.push(s);
  return out;
}

async function start({ getSnapshot, getRecentTrades }) {
  if (_started) return { ok: true, alreadyStarted: true };
  const token = (process.env.DISCORD_BOT_TOKEN || '').trim();
  if (!token) {
    console.log('[DiscordChat] DISCORD_BOT_TOKEN not set — chat bot disabled. (Daily P&L webhook still works.)');
    return { ok: false, reason: 'no_token' };
  }
  // Lazy require so the dependency cost is only paid when the token is set.
  let DiscordPkg;
  try { DiscordPkg = require('discord.js'); }
  catch (e) {
    console.error('[DiscordChat] discord.js not installed — run `npm install discord.js`. Chat disabled.');
    return { ok: false, reason: 'no_pkg' };
  }
  const { Client, GatewayIntentBits, Partials, Events, ChannelType } = DiscordPkg;

  const channelId = (process.env.DISCORD_CHAT_CHANNEL_ID || '').trim() || null;

  _client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Partials needed so DM channels created lazily still fire messageCreate.
    partials: [Partials.Channel, Partials.Message],
  });

  _client.once(Events.ClientReady, async (c) => {
    console.log(`[DiscordChat] Logged in as ${c.user.tag}. Listening on ${channelId ? `channel ${channelId} + DMs` : 'DMs only (set DISCORD_CHAT_CHANNEL_ID for a server channel)'}`);
    // Diagnostic: enumerate every guild + visible text channel so we can
    // see exactly where the bot ended up. If the configured channelId
    // doesn't appear in this list, the bot is in the wrong server (or
    // doesn't have View Channel permission for that channel).
    try {
      const guilds = c.guilds.cache;
      console.log(`[DiscordChat] In ${guilds.size} server(s):`);
      for (const [, g] of guilds) {
        const textChannels = g.channels.cache.filter(ch => typeof ch.send === 'function');
        console.log(`[DiscordChat]   • ${g.name} (id=${g.id}) — ${textChannels.size} text channel(s):`);
        for (const [, ch] of textChannels) {
          const marker = ch.id === channelId ? '  ← CONFIGURED' : '';
          console.log(`[DiscordChat]       #${ch.name} (id=${ch.id})${marker}`);
        }
      }
    } catch (e) { console.error('[DiscordChat] guild enumeration failed:', e.message); }
    // Diagnostic heartbeat: try to fetch the configured channel and post a
    // boot message. This proves (a) the bot is in the server, (b) it can see
    // the channel, and (c) it has Send Messages permission. If any of those
    // fail, the error tells us exactly which one.
    if (channelId) {
      try {
        const ch = await c.channels.fetch(channelId);
        if (!ch) console.error(`[DiscordChat] channel ${channelId} not found — is the bot invited to that server and can it see this channel?`);
        else if (typeof ch.send !== 'function') console.error(`[DiscordChat] channel ${channelId} is type ${ch.type} — not a text channel.`);
        else {
          await ch.send('🤖 Alpha online — try saying hi.');
          console.log(`[DiscordChat] Heartbeat posted to channel ${channelId}.`);
        }
      } catch (e) {
        console.error(`[DiscordChat] could not access channel ${channelId}: ${e.message}. Check: (1) bot is in the server, (2) bot has View Channel + Send Messages perms here, (3) channel id is correct.`);
      }
    }
  });

  _client.on(Events.MessageCreate, async (msg) => {
    try {
      // Diagnostic: log EVERY incoming message before any filter so we can
      // tell the difference between "Discord isn't sending events" (no log
      // line at all → Message Content Intent likely off, or bot lacks
      // channel access) and "events arrive but get filtered" (line appears).
      const chType = msg.channel?.type;
      const chId = msg.channel?.id;
      const author = msg.author?.tag || msg.author?.id || 'unknown';
      const contentPreview = (msg.content || '').slice(0, 60);
      console.log(`[DiscordChat] msg received: author=${author} chType=${chType} chId=${chId} contentLen=${(msg.content || '').length} preview="${contentPreview}"`);

      // Ignore bot messages (incl. self) AND webhook messages — prevents
      // echo loops with the outbound webhook used for daily P&L / trade
      // alerts. Belt-and-suspenders: webhook posts have webhookId set even
      // when their author isn't flagged as a bot.
      if (msg.author?.bot) { console.log('[DiscordChat] skip: bot author'); return; }
      if (msg.webhookId)   { console.log('[DiscordChat] skip: webhook'); return; }
      const isDM = msg.channel?.type === ChannelType.DM;
      const isTargetChannel = channelId && msg.channel?.id === channelId;
      if (!isDM && !isTargetChannel) { console.log(`[DiscordChat] skip: wrong channel (got ${msg.channel?.id}, want ${channelId} or DM)`); return; }
      const text = String(msg.content || '').trim();
      if (!text) { console.log('[DiscordChat] skip: empty content (Message Content Intent may be OFF in Developer Portal)'); return; }
      console.log(`[DiscordChat] handling: routing to brokerService.chat()`);

      // Show "typing…" while Grok thinks. Best-effort — ignore failures.
      try { await msg.channel.sendTyping(); } catch {}

      // Build the same context the in-app /api/broker/chat endpoint uses.
      const [snapshot, recentTrades] = await Promise.all([
        Promise.resolve(getSnapshot ? getSnapshot() : null),
        Promise.resolve(getRecentTrades ? getRecentTrades() : []),
      ]).catch(() => [null, []]);
      const recentSignals = Object.values(snapshot?.signals || {});

      const result = await brokerService.chat({
        messages: [{ role: 'user', content: text }],
        snapshot, recentSignals, recentTrades,
        voice: false, // Discord = text replies, not TTS
      });

      const reply = result?.reply || "Sorry, I couldn't form a reply.";
      for (const part of chunkReply(reply)) {
        try { await msg.reply(part); }
        catch (e) {
          // Fall back to channel.send if reply (which references the source
          // message) fails — e.g., the source was deleted mid-flight.
          try { await msg.channel.send(part); } catch {}
        }
      }
    } catch (e) {
      console.error('[DiscordChat] handler error:', e.message);
      try { await msg.reply(`Sorry, something went wrong on my end: ${e.message}`); } catch {}
    }
  });

  _client.on(Events.Error, (e) => console.error('[DiscordChat] client error:', e?.message || e));

  try {
    await _client.login(token);
    _started = true;
    return { ok: true };
  } catch (e) {
    console.error('[DiscordChat] login failed — token may be invalid or bot may need privileged intents enabled. Error:', e.message);
    _client = null;
    return { ok: false, reason: 'login_failed', error: e.message };
  }
}

function isReady() { return _started && !!_client; }

module.exports = { start, isReady };
