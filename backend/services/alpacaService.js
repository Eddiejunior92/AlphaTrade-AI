const axios = require('axios');

class AlpacaService {
  constructor() {
    this.apiKey = process.env.ALPACA_API_KEY || '';
    this.secretKey = process.env.ALPACA_SECRET_KEY || '';
    this.baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
    this.dataUrl = 'https://data.alpaca.markets';
  }

  get headers() {
    return {
      'APCA-API-KEY-ID': this.apiKey,
      'APCA-API-SECRET-KEY': this.secretKey,
      'Content-Type': 'application/json',
    };
  }

  isConfigured() {
    return Boolean(this.apiKey && this.secretKey);
  }

  async getAccount() {
    if (!this.isConfigured()) return this.mockAccount();
    try {
      const res = await axios.get(`${this.baseUrl}/v2/account`, { headers: this.headers, timeout: 10000 });
      return res.data;
    } catch (e) {
      console.error('[Alpaca] getAccount error:', e.message);
      return this.mockAccount();
    }
  }

  async getPositions() {
    if (!this.isConfigured()) return [];
    try {
      const res = await axios.get(`${this.baseUrl}/v2/positions`, { headers: this.headers, timeout: 10000 });
      return res.data;
    } catch (e) {
      console.error('[Alpaca] getPositions error:', e.message);
      return [];
    }
  }

  async getOrders(status = 'all', limit = 20) {
    if (!this.isConfigured()) return [];
    try {
      const res = await axios.get(`${this.baseUrl}/v2/orders`, {
        headers: this.headers,
        params: { status, limit },
        timeout: 10000,
      });
      return res.data;
    } catch (e) {
      console.error('[Alpaca] getOrders error:', e.message);
      return [];
    }
  }

  async placeOrder({ symbol, qty, side, type = 'market', time_in_force = 'day' }) {
    if (!this.isConfigured()) {
      console.log(`[Mock] Would place ${side} order: ${qty} ${symbol}`);
      return { id: `mock-${Date.now()}`, symbol, qty, side, status: 'mock_filled' };
    }
    try {
      const res = await axios.post(
        `${this.baseUrl}/v2/orders`,
        { symbol, qty: String(qty), side, type, time_in_force },
        { headers: this.headers, timeout: 10000 }
      );
      return res.data;
    } catch (e) {
      console.error('[Alpaca] placeOrder error:', e.message);
      throw e;
    }
  }

  async getBars(symbol, timeframe = '1Min', limit = 20) {
    try {
      const res = await axios.get(`${this.dataUrl}/v2/stocks/${symbol}/bars`, {
        headers: this.headers,
        params: { timeframe, limit, feed: 'iex' },
        timeout: 10000,
      });
      return res.data?.bars || [];
    } catch (e) {
      console.error('[Alpaca] getBars error:', e.message);
      return this.mockBars(symbol, limit);
    }
  }

  async getClock() {
    if (!this.isConfigured()) {
      return { is_open: false, timestamp: new Date().toISOString(), next_open: null, next_close: null };
    }
    try {
      const res = await axios.get(`${this.baseUrl}/v2/clock`, { headers: this.headers, timeout: 8000 });
      return res.data;
    } catch (e) {
      console.error('[Alpaca] getClock error:', e.message);
      return { is_open: false, timestamp: new Date().toISOString(), error: e.message };
    }
  }

  async closeAllPositions() {
    if (!this.isConfigured()) return [];
    try {
      const res = await axios.delete(`${this.baseUrl}/v2/positions`, {
        headers: this.headers,
        params: { cancel_orders: true },
        timeout: 15000,
      });
      return res.data || [];
    } catch (e) {
      console.error('[Alpaca] closeAllPositions error:', e.message);
      return [];
    }
  }

  async getLatestQuote(symbol) {
    try {
      const res = await axios.get(`${this.dataUrl}/v2/stocks/${symbol}/quotes/latest`, {
        headers: this.headers,
        params: { feed: 'iex' },
        timeout: 10000,
      });
      return res.data?.quote || null;
    } catch (e) {
      return null;
    }
  }

  mockAccount() {
    return {
      id: 'demo-account',
      status: 'ACTIVE',
      currency: 'USD',
      buying_power: '25000.00',
      cash: '25000.00',
      portfolio_value: '25000.00',
      equity: '25000.00',
      last_equity: '24800.00',
      daytrade_count: 0,
      trading_blocked: false,
      account_blocked: false,
    };
  }

  mockBars(symbol, limit) {
    const bars = [];
    let price = 150 + Math.random() * 50;
    const now = Date.now();
    for (let i = limit; i >= 0; i--) {
      price += (Math.random() - 0.48) * 2;
      bars.push({
        t: new Date(now - i * 60000).toISOString(),
        o: parseFloat(price.toFixed(2)),
        h: parseFloat((price + Math.random() * 1).toFixed(2)),
        l: parseFloat((price - Math.random() * 1).toFixed(2)),
        c: parseFloat((price + (Math.random() - 0.5)).toFixed(2)),
        v: Math.floor(Math.random() * 100000),
      });
    }
    return bars;
  }
}

module.exports = new AlpacaService();
