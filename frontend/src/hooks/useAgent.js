import { useState, useEffect, useCallback, useRef } from 'react';

const API = '/api';

async function apiPost(path) {
  const res = await fetch(`${API}${path}`, { method: 'POST' });
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
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState({});
  const wsRef = useRef(null);

  const setLoad = (key, val) => setLoading(l => ({ ...l, [key]: val }));

  const refreshLogs = useCallback(async () => {
    try {
      const [t, a] = await Promise.all([apiGet('/trades?limit=100'), apiGet('/audit?limit=100')]);
      setTrades(Array.isArray(t) ? t : []);
      setAudit(Array.isArray(a) ? a : []);
    } catch {}
  }, []);

  useEffect(() => {
    apiGet('/state').then(setState).catch(() => {});
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

  return {
    state, trades, audit, connected, loading,
    startAgent: wrap('start', () => apiPost('/agent/start')),
    stopAgent: wrap('stop', () => apiPost('/agent/stop')),
    runNow: wrap('runNow', () => apiPost('/agent/run-now')),
    emergencyPause: wrap('pause', () => apiPost('/agent/emergency-pause')),
    resume: wrap('resume', () => apiPost('/agent/resume')),
    resetCircuitBreaker: wrap('cbReset', () => apiPost('/agent/reset-circuit-breaker')),
  };
}
