import { useState, useEffect, useCallback, useRef } from 'react';

const API_BASE = '/api';

export function useAgent() {
  const [state, setState] = useState(null);
  const [account, setAccount] = useState(null);
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState({});
  const wsRef = useRef(null);

  const setLoad = (key, val) => setLoading(l => ({ ...l, [key]: val }));

  const fetchAccount = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/account`);
      setAccount(await res.json());
    } catch {}
  }, []);

  const fetchPositions = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/positions`);
      setPositions(await res.json());
    } catch { setPositions([]); }
  }, []);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/orders`);
      setOrders(await res.json());
    } catch { setOrders([]); }
  }, []);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/state`);
      setState(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchState();
    fetchAccount();
    fetchPositions();
    fetchOrders();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:5000';
    const wsUrl = `${protocol}//${host}/ws`;
    let ws;

    const connect = () => {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'state') setState(msg.data);
        } catch {}
      };
    };

    connect();

    const interval = setInterval(() => {
      fetchAccount();
      fetchPositions();
      fetchOrders();
    }, 10000);

    return () => {
      clearInterval(interval);
      if (wsRef.current) wsRef.current.close();
    };
  }, [fetchState, fetchAccount, fetchPositions, fetchOrders]);

  const startAgent = async () => {
    setLoad('start', true);
    try {
      await fetch(`${API_BASE}/agent/start`, { method: 'POST' });
      await fetchState();
    } finally { setLoad('start', false); }
  };

  const stopAgent = async () => {
    setLoad('stop', true);
    try {
      await fetch(`${API_BASE}/agent/stop`, { method: 'POST' });
      await fetchState();
    } finally { setLoad('stop', false); }
  };

  const runNow = async () => {
    setLoad('runNow', true);
    try {
      await fetch(`${API_BASE}/agent/run-now`, { method: 'POST' });
      await fetchState();
      await fetchAccount();
      await fetchPositions();
      await fetchOrders();
    } finally { setLoad('runNow', false); }
  };

  const resetCircuitBreaker = async () => {
    await fetch(`${API_BASE}/agent/reset-circuit-breaker`, { method: 'POST' });
    await fetchState();
  };

  return {
    state, account, positions, orders, connected,
    loading, startAgent, stopAgent, runNow, resetCircuitBreaker,
  };
}
