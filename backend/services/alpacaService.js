const axios = require('axios');

const PAPER_URL = 'https://paper-api.alpaca.markets';
const LIVE_URL = 'https://api.alpaca.markets';

class AlpacaService {
  constructor() {
    this.dataUrl = 'https://data.alpaca.markets';
    this._killSwitchActive = false;
    this.setMode(process.env.TRADING_MODE === 'live' ? 'live' : 'paper');
  }

  // Set by agent.js when the kill switch is engaged. All placeOrder() calls
  // are refused until the process restarts. Sticky by design — kill means
  // kill, not pause.
  setKillSwitchActive(v) { this._killSwitchActive = !!v; }
  isKillSwitchActive() { return !!this._killSwitchActive; }

  setMode(mode) {
    this.mode = mode === 'live' ? 'live' : 'paper';
    if (this.mode === 'live') {
      this.apiKey = process.env.ALPACA_LIVE_API_KEY || process.env.ALPACA_API_KEY || '';
      this.secretKey = process.env.ALPACA_LIVE_SECRET_KEY || process.env.ALPACA_SECRET_KEY || '';
      this.baseUrl = LIVE_URL;
    } else {
      this.apiKey = process.env.ALPACA_API_KEY || '';
      this.secretKey = process.env.ALPACA_SECRET_KEY || '';
      this.baseUrl = PAPER_URL;
    }
  }

  hasLiveCredentials() {
    return Boolean(process.env.ALPACA_LIVE_API_KEY && process.env.ALPACA_LIVE_SECRET_KEY);
  }

  get headers() {
    return {
      'APCA-API-KEY-ID': this.apiKey,
      'APCA-API-SECRET-KEY': this.secretKey,
      'Content-Type': 'application/json',
    };
  }

  isConfigured() { return Boolean(this.apiKey && this.secretKey); }

  async getAccount() {
    if (!this.isConfigured()) return this.mockAccount();
    try {
      const res = await axios.get(`${this.baseUrl}/v2/account`, { headers: this.headers, timeout: 10000 });
      return { ...res.data, mode: this.mode };
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
    } catch (e) { console.error('[Alpaca] getPositions error:', e.message); return []; }
  }

  async getOrders(status = 'all', limit = 20) {
    if (!this.isConfigured()) return [];
    try {
      const res = await axios.get(`${this.baseUrl}/v2/orders`, {
        headers: this.headers, params: { status, limit }, timeout: 10000,
      });
      return res.data;
    } catch (e) { console.error('[Alpaca] getOrders error:', e.message); return []; }
  }

  async placeOrder({ symbol, qty, side, type = 'market', time_in_force = 'day' }) {
    // Last-line kill-switch defense — global guard at the broker sink itself.
    // executeOrder() in agent.js also guards, but hedgingService and any
    // future call site that uses placeOrder directly will be caught here too.
    // The kill-switch flag is exposed via a setter so we don't create a
    // circular require with agent.js.
    if (this._killSwitchActive) {
      console.log(`[Alpaca] BLOCKED ${side} ${qty} ${symbol} — kill switch active`);
      const err = new Error('Kill switch active — broker order refused');
      err.code = 'KILL_SWITCH_ACTIVE';
      throw err;
    }
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
    } catch (e) { console.error('[Alpaca] placeOrder error:', e.message); throw e; }
  }

  async closePosition(symbol) {
    if (!this.isConfigured()) return null;
    try {
      const res = await axios.delete(`${this.baseUrl}/v2/positions/${symbol}`, {
        headers: this.headers, timeout: 10000,
      });
      return res.data;
    } catch (e) { console.error('[Alpaca] closePosition error:', e.message); throw e; }
  }

  async getBars(symbol, timeframe = '1Min', limit = 20, opts = {}) {
    // Without `start`, Alpaca IEX returns the most-recent bars only — which is
    // usually empty after-hours / over weekends. Pass a start window so we
    // always get historical data even when the market is closed.
    //
    // When `opts.paginate === true` (used by the historical intelligence layer
    // for 20Y of daily bars), we follow `next_page_token` until exhausted —
    // staying under a hard cap so a runaway response can't melt memory.
    // `raw` is correct for intraday (last-60-min) bars where splits don't
    // matter. For multi-year historical analysis the caller MUST pass
    // adjustment: 'all' so split/dividend events don't masquerade as crashes
    // (e.g. NVDA's 10:1 split would otherwise show as a -90% drawdown).
    const baseParams = { timeframe, limit, feed: 'iex', adjustment: opts.adjustment || 'raw' };
    if (opts.start) baseParams.start = opts.start;
    if (opts.end)   baseParams.end   = opts.end;
    const HARD_CAP = 50000;

    try {
      let all = [];
      let pageToken = null;
      let pages = 0;
      do {
        const params = { ...baseParams };
        if (pageToken) params.page_token = pageToken;
        const res = await axios.get(`${this.dataUrl}/v2/stocks/${symbol}/bars`, {
          headers: this.headers, params, timeout: 15000,
        });
        const bars = res.data?.bars || [];
        all = all.concat(bars);
        pageToken = opts.paginate ? (res.data?.next_page_token || null) : null;
        pages++;
        if (all.length >= HARD_CAP) break;
      } while (pageToken && pages < 25);
      return all;
    } catch (e) {
      console.error('[Alpaca] getBars error:', e.message);
      // Fail-closed for callers that can't tolerate synthetic data (e.g. the
      // historical-intelligence layer, where caching mock 20Y bars would
      // produce convincing-looking but fabricated CAGR/regime numbers).
      if (opts.noMock) throw e;
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
        headers: this.headers, params: { cancel_orders: true }, timeout: 15000,
      });
      return res.data || [];
    } catch (e) { console.error('[Alpaca] closeAllPositions error:', e.message); return []; }
  }

  // Cancel every open/working order without touching positions. Used by the
  // kill switch and the standalone "cancel all orders" operator action.
  async cancelAllOpenOrders() {
    if (!this.isConfigured()) return { cancelled: 0, mock: true };
    try {
      const res = await axios.delete(`${this.baseUrl}/v2/orders`, {
        headers: this.headers, timeout: 15000,
      });
      const list = Array.isArray(res.data) ? res.data : [];
      return { cancelled: list.length, details: list };
    } catch (e) { console.error('[Alpaca] cancelAllOpenOrders error:', e.message); return { cancelled: 0, error: e.message }; }
  }

  mockAccount() {
    return {
      id: 'demo-account', status: 'ACTIVE', currency: 'USD', mode: this.mode,
      buying_power: '25000.00', cash: '25000.00', portfolio_value: '25000.00',
      equity: '25000.00', last_equity: '24800.00', daytrade_count: 0,
      trading_blocked: false, account_blocked: false,
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
        h: parseFloat((price + Math.random()).toFixed(2)),
        l: parseFloat((price - Math.random()).toFixed(2)),
        c: parseFloat((price + (Math.random() - 0.5)).toFixed(2)),
        v: Math.floor(Math.random() * 100000),
      });
    }
    return bars;
  }
}

module.exports = new AlpacaService();
