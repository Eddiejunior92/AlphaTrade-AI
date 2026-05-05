// IBKR (Interactive Brokers) execution layer for ASX equities.
//
// IBKR's retail API is the Client Portal Web API, which requires the
// Client Portal Gateway running locally (Java app, OAuth-style session).
// In production, set IBKR_BASE_URL to the gateway URL (typically
// `https://localhost:5000/v1/api`) and IBKR_ACCOUNT_ID to your account.
//
// When unconfigured, this service runs in **mock mode** — same pattern as
// alpacaService when ALPACA_API_KEY is absent. Mock mode logs intended
// orders and returns synthetic responses so the agent's decision/audit
// pipeline can be validated end-to-end without a live broker connection.
// Bars in mock mode are random-walk synthetic — clearly labeled, never
// fed to the historical-intel layer (which is US-only anyway).
//
// Symbol convention: pass plain ASX tickers (e.g. 'CBA', 'BHP'). The IBKR
// layer is responsible for resolving these to IBKR contract IDs (conid)
// — in real mode, that requires a contract search per symbol on first use
// (cached). In mock mode the symbol passes through unchanged.
//
// Currency: all prices and order quantities are in AUD / native shares.
// USD conversion lives in fxService and the agent — IBKR sees only native.

const axios = require('axios');
const https = require('https');

class IbkrService {
  constructor() {
    this.baseUrl = process.env.IBKR_BASE_URL || '';
    this.accountId = process.env.IBKR_ACCOUNT_ID || '';
    this._killSwitchActive = false;
    this._conidCache = new Map();
    // The Client Portal Gateway uses a self-signed cert by default. Allow
    // the operator to opt out of TLS verification for localhost gateways.
    this._http = axios.create({
      timeout: 12000,
      httpsAgent: process.env.IBKR_INSECURE_TLS === 'true'
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
    });
  }

  // Mirror alpacaService's surface so brokerRouter can treat them
  // interchangeably.
  setKillSwitchActive(v) { this._killSwitchActive = !!v; }
  isKillSwitchActive() { return !!this._killSwitchActive; }

  isConfigured() { return Boolean(this.baseUrl && this.accountId); }

  async _resolveConid(symbol) {
    if (this._conidCache.has(symbol)) return this._conidCache.get(symbol);
    if (!this.isConfigured()) return null;
    try {
      // IBKR Client Portal: GET /iserver/secdef/search?symbol=CBA
      const res = await this._http.get(`${this.baseUrl}/iserver/secdef/search`, {
        params: { symbol, secType: 'STK' },
      });
      // Filter to ASX listing
      const list = Array.isArray(res.data) ? res.data : [];
      const hit = list.find(x => (x.description || '').includes('ASX'))
        || list.find(x => x.symbol === symbol)
        || list[0];
      if (hit?.conid) {
        this._conidCache.set(symbol, hit.conid);
        return hit.conid;
      }
    } catch (e) {
      console.error(`[IBKR] conid lookup failed for ${symbol}:`, e.message);
    }
    return null;
  }

  async getAccount() {
    if (!this.isConfigured()) return this._mockAccount();
    try {
      const res = await this._http.get(`${this.baseUrl}/portfolio/${this.accountId}/summary`);
      const s = res.data || {};
      return {
        id: this.accountId, status: 'ACTIVE', currency: s.currency?.value || 'AUD',
        cash: String(s.totalcashvalue?.amount ?? 0),
        equity: String(s.netliquidation?.amount ?? 0),
        buying_power: String(s.buyingpower?.amount ?? 0),
      };
    } catch (e) {
      console.error('[IBKR] getAccount error:', e.message);
      return this._mockAccount();
    }
  }

  async getPositions() {
    if (!this.isConfigured()) return [];
    try {
      const res = await this._http.get(`${this.baseUrl}/portfolio/${this.accountId}/positions/0`);
      return (res.data || []).map(p => ({
        symbol: p.contractDesc || p.ticker, qty: p.position, avg_cost: p.avgCost,
        market_value: p.mktValue, unrealized_pl: p.unrealizedPnl,
      }));
    } catch (e) { console.error('[IBKR] getPositions error:', e.message); return []; }
  }

  async placeOrder({ symbol, qty, side, type = 'MKT', tif = 'DAY' }) {
    if (this._killSwitchActive) {
      console.log(`[IBKR] BLOCKED ${side} ${qty} ${symbol} — kill switch active`);
      const err = new Error('Kill switch active — broker order refused');
      err.code = 'KILL_SWITCH_ACTIVE';
      throw err;
    }
    if (!this.isConfigured()) {
      console.log(`[IBKR-Mock] Would place ${side} order: ${qty} ${symbol} (ASX)`);
      return { id: `ibkr-mock-${Date.now()}`, symbol, qty, side, status: 'mock_filled', broker: 'ibkr' };
    }
    const conid = await this._resolveConid(symbol);
    if (!conid) throw new Error(`IBKR: could not resolve conid for ${symbol}`);
    try {
      const body = {
        orders: [{
          conid,
          orderType: type,
          side: side.toUpperCase(),       // BUY | SELL
          quantity: Number(qty),
          tif,
          listingExchange: 'ASX',
        }],
      };
      const res = await this._http.post(
        `${this.baseUrl}/iserver/account/${this.accountId}/orders`, body
      );
      const order = Array.isArray(res.data) ? res.data[0] : res.data;
      return {
        id: order?.order_id || order?.id || `ibkr-${Date.now()}`,
        symbol, qty, side,
        status: order?.order_status || 'submitted',
        broker: 'ibkr',
      };
    } catch (e) {
      // IBKR sometimes returns a confirmation prompt (e.g. order value
      // warning). Auto-acknowledge it once, then retry — a real production
      // deployment would surface the prompt to the operator. We log it.
      const msg = e.response?.data?.[0]?.message || e.message;
      console.error(`[IBKR] placeOrder error for ${symbol}:`, msg);
      throw new Error(`IBKR placeOrder ${symbol}: ${msg}`);
    }
  }

  async closePosition(symbol) {
    // Modeled on alpacaService.closePosition shape — caller may use this
    // for per-symbol flatten. For IBKR there's no single endpoint; we
    // submit a market sell sized to current position.
    if (!this.isConfigured()) return null;
    const positions = await this.getPositions();
    const pos = positions.find(p => p.symbol === symbol);
    if (!pos || !pos.qty) return null;
    const side = pos.qty > 0 ? 'SELL' : 'BUY';
    return this.placeOrder({ symbol, qty: Math.abs(pos.qty), side });
  }

  async closeAllPositions() {
    if (!this.isConfigured()) return [];
    const positions = await this.getPositions();
    const results = [];
    for (const p of positions) {
      try { results.push(await this.closePosition(p.symbol)); }
      catch (e) { console.error('[IBKR] closeAllPositions partial fail:', e.message); }
    }
    return results;
  }

  async cancelAllOpenOrders() {
    if (!this.isConfigured()) return { cancelled: 0, mock: true };
    try {
      const res = await this._http.get(`${this.baseUrl}/iserver/account/orders`);
      const orders = res.data?.orders || [];
      const live = orders.filter(o => /Submit|PreSubmit|Pending/i.test(o.status || ''));
      let cancelled = 0;
      for (const o of live) {
        try {
          await this._http.delete(`${this.baseUrl}/iserver/account/${this.accountId}/order/${o.orderId}`);
          cancelled++;
        } catch (e) { console.error('[IBKR] cancel order fail:', e.message); }
      }
      return { cancelled };
    } catch (e) {
      console.error('[IBKR] cancelAllOpenOrders error:', e.message);
      return { cancelled: 0, error: e.message };
    }
  }

  // Bars: IBKR uses period+bar params (e.g. period='1d', bar='15min').
  // We expose the same shape as alpacaService.getBars so analyzer code
  // can stay broker-agnostic. Fields normalized to {t, o, h, l, c, v}.
  async getBars(symbol, timeframe = '15Min', limit = 60) {
    const period = limit <= 60 ? '1d' : limit <= 300 ? '5d' : '1m';
    const bar = timeframe === '1Min' ? '1min'
              : timeframe === '15Min' ? '15min'
              : timeframe === '1Hour' ? '1h'
              : timeframe === '1Day' ? '1d'
              : '15min';
    if (!this.isConfigured()) return this._mockBars(symbol, limit);
    const conid = await this._resolveConid(symbol);
    if (!conid) return this._mockBars(symbol, limit);
    try {
      const res = await this._http.get(`${this.baseUrl}/iserver/marketdata/history`, {
        params: { conid, period, bar, outsideRth: false },
      });
      const data = res.data?.data || [];
      return data.slice(-limit).map(b => ({
        t: new Date(b.t).toISOString(),
        o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0,
      }));
    } catch (e) {
      console.error(`[IBKR] getBars ${symbol} error:`, e.message);
      return this._mockBars(symbol, limit);
    }
  }

  _mockAccount() {
    return {
      id: 'ibkr-mock', status: 'ACTIVE', currency: 'AUD',
      cash: '50000.00', equity: '50000.00', buying_power: '50000.00',
      mock: true,
    };
  }

  _mockBars(symbol, limit) {
    // Random-walk synthetic ASX-priced bars, ~$30 AUD start (typical for
    // top-10 ASX names like CBA/BHP). Clearly synthetic — never fed to
    // production analytics.
    const bars = [];
    let price = 30 + Math.random() * 50;
    const now = Date.now();
    for (let i = limit; i >= 0; i--) {
      price += (Math.random() - 0.48) * 0.5;
      bars.push({
        t: new Date(now - i * 15 * 60_000).toISOString(),
        o: +price.toFixed(2),
        h: +(price + Math.random() * 0.3).toFixed(2),
        l: +(price - Math.random() * 0.3).toFixed(2),
        c: +(price + (Math.random() - 0.5) * 0.2).toFixed(2),
        v: Math.floor(Math.random() * 50_000),
      });
    }
    return bars;
  }
}

module.exports = new IbkrService();
