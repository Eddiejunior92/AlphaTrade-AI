import { useState, useEffect, useCallback, useRef } from 'react';

const API = '/api';

async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function apiGet(path) {
  const res = await fetch(`${API}${path}`);
  return res.json();
}

export function useAgent() {
  const [state, setState] = useState(null);
  const [trades, setTrades] = useState([]);
  const [audit, setAudit] = useState([]);
  // Two separate briefings so the dashboard can render both cards. Either may
  // be null if that market has never produced one (e.g. no XAI key, empty WL).
  const [premarket, setPremarket] = useState({ us: null, asx: null });
  const [connected, setConnected] = useState(false);
  const [liveAuditAt, setLiveAuditAt] = useState(0);
  const [loading, setLoading] = useState({});
  const wsRef = useRef(null);

  const setLoad = (key, val) => setLoading(l => ({ ...l, [key]: val }));

  // Merge fetched audit rows with the in-memory list (which may already contain
  // newer rows pushed live over WS). Dedupe by id, keep newest-first, cap 200.
  const mergeAudit = (incoming) => {
    if (!Array.isArray(incoming)) return;
    setAudit(prev => {
      const seen = new Set();
      const merged = [];
      for (const row of [...prev, ...incoming]) {
        if (!row || row.id == null || seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push(row);
      }
      merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return merged.slice(0, 200);
    });
  };

  const refreshLogs = useCallback(async () => {
    try {
      const [t, a] = await Promise.all([apiGet('/trades?limit=100'), apiGet('/audit?limit=100')]);
      setTrades(Array.isArray(t) ? t : []);
      mergeAudit(a);
    } catch {}
  }, []);

  useEffect(() => {
    apiGet('/state').then(setState).catch(() => {});
    apiGet('/premarket/latest').then(b => {
      if (!b || b.empty) return;
      setPremarket({ us: b.us || null, asx: b.asx || null });
    }).catch(() => {});
    refreshLogs();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    let ws;
    let reconnectTimer;

    const connect = () => {
      ws = new WebSocket(`${protocol}//${host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'state') setState(msg.data);
          else if (msg.type === 'premarket' && msg.data) {
            // Server pushes a single market's briefing per event (with a
            // `market` field). Slot it into the right side without disturbing
            // the other.
            const m = (msg.data.market || 'US').toLowerCase();
            const key = m === 'asx' ? 'asx' : 'us';
            setPremarket(prev => ({ ...prev, [key]: msg.data }));
          }
          else if (msg.type === 'audit' && msg.data) {
            setAudit(prev => {
              // Dedupe by id, prepend newest, cap at 200 entries.
              if (prev.some(r => r.id === msg.data.id)) return prev;
              return [msg.data, ...prev].slice(0, 200);
            });
            setLiveAuditAt(Date.now());
          }
        } catch {}
      };
    };
    connect();

    const logInterval = setInterval(refreshLogs, 8000);
    return () => {
      clearInterval(logInterval);
      clearTimeout(reconnectTimer);
      if (wsRef.current) wsRef.current.close();
    };
  }, [refreshLogs]);

  const wrap = (key, fn) => async () => {
    setLoad(key, true);
    try { await fn(); await refreshLogs(); }
    finally { setLoad(key, false); }
  };

  const brokerChat = useCallback(async (messages) => {
    const res = await fetch(`${API}/broker/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    return res.json();
  }, []);

  // Regenerate one market's briefing. `market` is 'US' or 'ASX'. Loading flag
  // is namespaced per market so the two refresh buttons spin independently.
  const refreshPremarket = useCallback(async (market = 'US') => {
    const m = String(market).toUpperCase();
    const key = m === 'ASX' ? 'premarketAsx' : 'premarketUs';
    setLoad(key, true);
    try {
      const r = await apiPost(`/agent/premarket-refresh?market=${m}`);
      if (r && r.ok) {
        const slot = m === 'ASX' ? 'asx' : 'us';
        setPremarket(prev => ({ ...prev, [slot]: r }));
      }
      return r;
    } finally { setLoad(key, false); }
  }, []);

  return {
    state, trades, audit, premarket, refreshPremarket, connected, liveAuditAt, loading, brokerChat,
    startAgent: wrap('start', () => apiPost('/agent/start')),
    stopAgent: wrap('stop', () => apiPost('/agent/stop')),
    runNow: wrap('runNow', () => apiPost('/agent/run-now')),
    emergencyPause: wrap('pause', () => apiPost('/agent/emergency-pause')),
    resume: wrap('resume', () => apiPost('/agent/resume')),
    resetCircuitBreaker: wrap('cbReset', () => apiPost('/agent/reset-circuit-breaker')),
    flatten: wrap('flatten', () => apiPost('/agent/flatten', { reason: 'Manual flatten via dashboard' })),
    toggleStrategy: async (name, enabled) => {
      setLoad(`strat:${name}`, true);
      try {
        const r = await apiPost(`/agent/strategy/${name}/toggle`, { enabled });
        await refreshLogs();
        return r;
      } finally { setLoad(`strat:${name}`, false); }
    },
    setTradingMode: async (mode, confirm) => {
      setLoad('mode', true);
      try {
        const r = await apiPost('/agent/trading-mode', { mode, confirm });
        await refreshLogs();
        return r;
      } finally { setLoad('mode', false); }
    },
    setRiskScale: async (scale) => {
      setLoad(`risk:${scale}`, true);
      try {
        const r = await apiPost('/agent/risk-scale', { scale });
        await refreshLogs();
        return r;
      } finally { setLoad(`risk:${scale}`, false); }
    },
  };
}
