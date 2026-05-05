import { useState, useEffect, useMemo } from 'react';
import MarketFilter from './MarketFilter';

// Per-market defaults — the symbol field auto-switches when the operator
// flips the market chip so they never have to remember which tickers are
// in which watchlist.
const DEFAULT_SYMBOLS = {
  ALL: 'SPY,QQQ,AAPL',
  US:  'SPY,QQQ,AAPL',
  ASX: 'BHP,CBA,CSL',
};

const DEFAULTS = {
  symbols: DEFAULT_SYMBOLS.ALL,
  lookbackDays: 365,
  startCash: 100000,
  slippageBps: 5,
  commissionUSD: 1,
  rsiBuyMax: 55,
  rsiSellMin: 70,
  stopLossPct: 4,
  takeProfitPct: 10,
  trailingStopPct: 6,
  maxPositionPct: 20,
  requireUptrend: true,
};

function Stat({ label, value, color = 'text-white' }) {
  return (
    <div className="bg-white/5 rounded-xl p-3 border border-white/10">
      <div className="text-[11px] text-[var(--text-dim)] uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold mt-1 ${color}`}>{value}</div>
    </div>
  );
}

function MiniSparkline({ points }) {
  if (!points?.length) return null;
  const w = 600, h = 90, pad = 4;
  const xs = points.map((_, i) => pad + (i * (w - 2 * pad)) / Math.max(1, points.length - 1));
  const ys = points.map(p => p.equity);
  const min = Math.min(...ys), max = Math.max(...ys);
  const range = max - min || 1;
  const path = points.map((p, i) => {
    const y = h - pad - ((p.equity - min) / range) * (h - 2 * pad);
    return `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const last = ys[ys.length - 1], first = ys[0];
  const positive = last >= first;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-24">
      <path d={path} fill="none" stroke={positive ? 'var(--green)' : 'var(--red)'} strokeWidth="1.5" />
    </svg>
  );
}

export default function BacktestPanel({ marketOf }) {
  const [params, setParams] = useState(DEFAULTS);
  const [marketScope, setMarketScope] = useState('ALL');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState([]);
  const [recentFilter, setRecentFilter] = useState('ALL');

  const loadRecent = async () => {
    try { const r = await fetch('/api/backtest/recent').then(r => r.json()); setRecent(Array.isArray(r) ? r : []); } catch {}
  };
  useEffect(() => { loadRecent(); }, []);

  const update = (k, v) => setParams(p => ({ ...p, [k]: v }));

  // Switching market scope swaps the suggested symbols (only if the user
  // hasn't customized away from the previous default).
  const onScopeChange = (next) => {
    setMarketScope(next);
    setParams(p => {
      const wasDefault = Object.values(DEFAULT_SYMBOLS).includes(p.symbols);
      return wasDefault ? { ...p, symbols: DEFAULT_SYMBOLS[next] } : p;
    });
  };

  const run = async () => {
    setLoading(true); setError(''); setResult(null);
    try {
      const body = {
        symbols: params.symbols.split(',').map(s => s.trim()).filter(Boolean),
        market: marketScope === 'ALL' ? undefined : marketScope,
        lookbackDays: +params.lookbackDays,
        startCash: +params.startCash,
        slippageBps: +params.slippageBps,
        commissionUSD: +params.commissionUSD,
        rsiBuyMax: +params.rsiBuyMax,
        rsiSellMin: +params.rsiSellMin,
        stopLossPct: +params.stopLossPct / 100,
        takeProfitPct: +params.takeProfitPct / 100,
        trailingStopPct: +params.trailingStopPct / 100,
        maxPositionPct: +params.maxPositionPct / 100,
        requireUptrend: !!params.requireUptrend,
      };
      // /api/backtest is operator-gated (requireOperatorStrictGate). Pull the
      // token from localStorage — same key used by Settings + every other panel.
      let opToken = '';
      try { opToken = localStorage.getItem('operator_token') || ''; } catch {}
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(opToken ? { 'x-operator-token': opToken } : {}),
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Backtest failed');
      setResult(data);
      loadRecent();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  // Derive per-run market from the run's symbols. A run is "US" if all symbols
  // resolve to US, "ASX" if all are ASX, otherwise "MIX".
  const marketForRun = (r) => {
    const syms = r.symbols || [];
    if (!syms.length || !marketOf) return 'MIX';
    const ms = new Set(syms.map(s => marketOf(s)));
    if (ms.size === 1) return [...ms][0];
    return 'MIX';
  };
  const recentCounts = useMemo(() => {
    const c = { US: 0, ASX: 0 };
    for (const r of recent) {
      const m = marketForRun(r);
      if (m === 'US') c.US += 1;
      else if (m === 'ASX') c.ASX += 1;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent]);
  const filteredRecent = recentFilter === 'ALL'
    ? recent
    : recent.filter(r => marketForRun(r) === recentFilter);

  const fmt = n => typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
  const pctColor = n => n > 0 ? 'text-[var(--green)]' : n < 0 ? 'text-[var(--red)]' : 'text-white';

  return (
    <div className="space-y-4">
      <div className="bg-white/5 rounded-2xl border border-white/10 p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">Backtest engine</h2>
            <p className="text-[11px] text-[var(--text-dim)] mt-0.5">Rules-based proxy on daily bars (RSI + trend + MACD). Slippage, commission, trailing stop, regime filter all configurable. Not a full 4-LLM replay.</p>
          </div>
          <div className="flex items-center gap-2">
            <MarketFilter value={marketScope} onChange={onScopeChange} />
            <button onClick={run} disabled={loading}
              className="px-4 py-2 rounded-xl bg-[var(--green)] text-black font-semibold text-sm hover:bg-[var(--green)]/80 disabled:opacity-50 disabled:cursor-not-allowed">
              {loading ? 'Running…' : 'Run backtest'}
            </button>
          </div>
        </div>

        <div className="text-[11px] text-[var(--text-dim)] mb-3">
          Scope: <span className="text-white font-semibold">
            {marketScope === 'ALL' ? 'US + ASX' : marketScope}
          </span> · only watchlist symbols are accepted
          {marketScope === 'ASX' && <span className="ml-1.5 opacity-70">· P&L native AUD</span>}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {[
            ['symbols', 'Symbols (CSV, watchlist only)', 'text'],
            ['lookbackDays', 'Lookback days', 'number'],
            ['startCash', 'Start cash $', 'number'],
            ['slippageBps', 'Slippage (bps)', 'number'],
            ['commissionUSD', 'Commission $/trade', 'number'],
            ['rsiBuyMax', 'RSI buy max', 'number'],
            ['rsiSellMin', 'RSI sell min', 'number'],
            ['stopLossPct', 'Stop loss %', 'number'],
            ['takeProfitPct', 'Take profit %', 'number'],
            ['trailingStopPct', 'Trailing stop %', 'number'],
            ['maxPositionPct', 'Max position % equity', 'number'],
          ].map(([k, label, type]) => (
            <label key={k} className="flex flex-col gap-1">
              <span className="text-[10px] text-[var(--text-dim)] uppercase tracking-wide">{label}</span>
              <input type={type} value={params[k]} onChange={e => update(k, e.target.value)}
                className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white" />
            </label>
          ))}
          <label className="flex items-center gap-2 mt-5">
            <input type="checkbox" checked={!!params.requireUptrend}
              onChange={e => update('requireUptrend', e.target.checked)} />
            <span className="text-xs text-white">Require uptrend regime</span>
          </label>
        </div>
        {error && <div className="mt-3 text-sm text-[var(--red)]">⚠ {error}</div>}
      </div>

      {result && (
        <div className="bg-white/5 rounded-2xl border border-white/10 p-5 space-y-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-base font-bold text-white">Results</h3>
            <span className="text-[11px] text-[var(--text-dim)]">
              {result.symbols?.join(', ')} · {result.daysSimulated} days · run {result.id ? `#${result.id}` : '(unsaved)'}
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Final equity" value={`$${fmt(result.finalEquity)}`} />
            <Stat label="Total return" value={`${result.totalReturnPct > 0 ? '+' : ''}${result.totalReturnPct}%`} color={pctColor(result.totalReturnPct)} />
            <Stat label="Sharpe (annl)" value={result.sharpe} color={pctColor(result.sharpe)} />
            <Stat label="Max drawdown" value={`${result.maxDrawdownPct}%`} color="text-[var(--red)]" />
            <Stat label="Trades closed" value={result.nTrades} />
            <Stat label="Win rate" value={`${(result.winRate * 100).toFixed(0)}%`} color={result.winRate >= 0.5 ? 'text-[var(--green)]' : 'text-[var(--red)]'} />
            <Stat label="Gross P&L" value={`$${fmt(result.grossPnl)}`} color={pctColor(result.grossPnl)} />
            <Stat label="Buys placed" value={result.nBuys} />
          </div>

          {result.equityCurve?.length > 0 && (
            <div>
              <div className="text-[11px] text-[var(--text-dim)] mb-1">Equity curve</div>
              <MiniSparkline points={result.equityCurve} />
            </div>
          )}

          {result.trades?.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-[var(--text-dim)]">Last {Math.min(50, result.trades.length)} trades</summary>
              <div className="mt-2 max-h-64 overflow-auto">
                <table className="w-full text-left">
                  <thead className="text-[10px] uppercase text-[var(--text-dim)]">
                    <tr><th className="py-1">Date</th><th>Sym</th><th>Side</th><th>Qty</th><th>Price</th><th>P&L</th><th>Reason</th></tr>
                  </thead>
                  <tbody>
                    {result.trades.slice(-50).reverse().map((t, i) => (
                      <tr key={i} className="border-t border-white/5">
                        <td className="py-1 text-[var(--text-dim)]">{t.date}</td>
                        <td className="font-medium">{t.symbol}</td>
                        <td className={t.side === 'BUY' ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{t.side}</td>
                        <td>{t.qty}</td>
                        <td>${t.price}</td>
                        <td className={pctColor(t.pnl ?? 0)}>{t.pnl != null ? `$${fmt(t.pnl)}` : '—'}</td>
                        <td className="text-[var(--text-dim)]">{t.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div className="bg-white/5 rounded-2xl border border-white/10 p-5">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <h3 className="text-sm font-bold text-white">Recent runs</h3>
            <MarketFilter value={recentFilter} onChange={setRecentFilter} counts={recentCounts} />
          </div>
          <div className="space-y-1.5">
            {filteredRecent.map(r => {
              const m = marketForRun(r);
              return (
                <div key={r.id} className="flex items-center justify-between text-xs py-1.5 border-b border-white/5">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium">#{r.id}</span>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                      m === 'ASX' ? 'bg-[var(--purple)]/20 text-[var(--purple)]' :
                      m === 'US'  ? 'bg-[var(--blue)]/20 text-[var(--blue)]' :
                                    'bg-white/10 text-[var(--text-dim)]'
                    }`}>{m}</span>
                    <span className="text-[var(--text-dim)] ml-1">{(r.symbols || []).join(', ')}</span>
                    <span className="text-[var(--text-dim)] ml-2">{r.start_date} → {r.end_date}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={pctColor(r.results?.totalReturnPct)}>{r.results?.totalReturnPct}%</span>
                    <span className="text-[var(--text-dim)]">Sharpe {r.results?.sharpe}</span>
                    <span className="text-[var(--text-dim)]">{r.results?.nTrades} trades</span>
                  </div>
                </div>
              );
            })}
            {filteredRecent.length === 0 && (
              <div className="text-[12px] text-[var(--text-dim)] py-2">No runs in {recentFilter}.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
