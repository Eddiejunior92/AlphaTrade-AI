const axios = require('axios');

class DiscordService {
  constructor() {
    this.webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
  }

  isConfigured() {
    return Boolean(this.webhookUrl);
  }

  async sendAlert({ title, description, color = 0x00ff88, fields = [] }) {
    if (!this.isConfigured()) {
      console.log(`[Discord Mock] Alert: ${title} — ${description}`);
      return;
    }
    try {
      await axios.post(this.webhookUrl, {
        embeds: [{
          title,
          description,
          color,
          fields,
          timestamp: new Date().toISOString(),
          footer: { text: 'AlphaTrade AI' },
        }],
      }, { timeout: 8000 });
    } catch (e) {
      console.error('[Discord] Send error:', e.message);
    }
  }

  async sendTradeAlert({ symbol, action, qty, price, confidence, reason }) {
    const colorMap = { BUY: 0x00c851, SELL: 0xff4444, HOLD: 0xffbb33 };
    await this.sendAlert({
      title: `${action} Signal — ${symbol}`,
      description: reason || `AI consensus: ${action}`,
      color: colorMap[action] || 0x888888,
      fields: [
        { name: 'Symbol', value: symbol, inline: true },
        { name: 'Action', value: action, inline: true },
        { name: 'Qty', value: String(qty), inline: true },
        { name: 'Price', value: `$${price}`, inline: true },
        { name: 'Confidence', value: `${(confidence * 100).toFixed(1)}%`, inline: true },
      ],
    });
  }

  async sendCircuitBreakerAlert(reason) {
    await this.sendAlert({
      title: '🚨 Circuit Breaker Triggered',
      description: reason,
      color: 0xff0000,
    });
  }

  // Richer breaker-tripped alert with structured detail (drawdown %, dayStart,
  // current equity, threshold). Falls back to plain alert if any field missing.
  async sendBreakerTrippedAlert({ reason, drawdownPct, dayStartEquity, equity, thresholdPct, lossUSD, mode }) {
    const fields = [];
    if (Number.isFinite(drawdownPct))    fields.push({ name: 'Drawdown',  value: `${(drawdownPct * 100).toFixed(2)}%`, inline: true });
    if (Number.isFinite(thresholdPct))   fields.push({ name: 'Threshold', value: `${(thresholdPct * 100).toFixed(2)}%`, inline: true });
    if (Number.isFinite(lossUSD))        fields.push({ name: 'Loss',      value: `$${lossUSD.toFixed(2)}`, inline: true });
    if (Number.isFinite(dayStartEquity)) fields.push({ name: 'Day-start', value: `$${dayStartEquity.toFixed(2)}`, inline: true });
    if (Number.isFinite(equity))         fields.push({ name: 'Equity',    value: `$${equity.toFixed(2)}`, inline: true });
    if (mode)                            fields.push({ name: 'Mode',      value: String(mode).toUpperCase(), inline: true });
    await this.sendAlert({
      title: '🚨 Circuit Breaker TRIPPED — all positions flattened',
      description: reason || 'Daily loss budget exceeded.',
      color: 0xff0000,
      fields,
    });
  }

  async sendBreakerResetAlert({ newDayStartEquity, mode, source }) {
    const fields = [];
    if (Number.isFinite(newDayStartEquity)) fields.push({ name: 'New day-start', value: `$${newDayStartEquity.toFixed(2)}`, inline: true });
    if (mode)   fields.push({ name: 'Mode', value: String(mode).toUpperCase(), inline: true });
    if (source) fields.push({ name: 'Reset by', value: String(source), inline: true });
    await this.sendAlert({
      title: '✅ Circuit Breaker Reset — trading re-armed',
      description: 'The drawdown breaker has been cleared. The agent will resume trading on the next cycle, subject to all other safety gates.',
      color: 0x00c851,
      fields,
    });
  }
}

module.exports = new DiscordService();
