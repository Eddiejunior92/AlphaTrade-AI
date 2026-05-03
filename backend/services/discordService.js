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
}

module.exports = new DiscordService();
