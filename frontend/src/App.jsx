import { useState } from 'react';
import { useAgent } from './hooks/useAgent';
import StatCard from './components/StatCard';
import SignalCard from './components/SignalCard';
import TradeLog from './components/TradeLog';
import HoldingsTable from './components/HoldingsTable';
import ReasoningFeed from './components/ReasoningFeed';

const TABS = ['Dashboard', 'AI Reasoning', 'Holdings', 'Trade History', 'Signals'];

export default function App() {
  const [tab, setTab] = useState('Dashboard');
  const {
    state, trades, audit, connected, loading,
    startAgent, stopAgent, runNow,
    emergencyPause, resume, resetCircuitBreaker,
  } = useAgent();

  const equity = state ? state.equity.toFixed(2) : '—';
  const cash = state ? state.cash.toFixed(2) : '—';
  const dailyPnL = state?.dailyPnL || 0;
  const totalPnL = state?.totalPnL || 0;
  const dailyPct = state?.dailyPnLPct || 0;
  const signals = state?.signals ? Object.values(state.signals) : [];
  const holdings = state?.holdings || [];
  const isRunning = state?.running;
  const paused = state?.emergencyPause;
  const cbTripped = state?.circuitBreakerTripped;
  const providers = state?.providers || { openrouter: false, xai: false };
  const risk = state?.risk;

  return (
    <div className="min-h-screen bg-[#0d1117] text-[#e6edf3]">
      <header className="border-b border-[#30363d] bg-[#161b22] px-6 py-3 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <span className="text-2xl">📈</span>
          <div>
            <h1 className="font-bold text-lg leading-tight">AlphaTrade AI</h1>
            <div className="text-xs text-[#8b949e]">Multi-LLM Autonomous Trading Agent · v2</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs">
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-[#00c851] pulse-green' : 'bg-[#ff4444]'}`} />
            <span className="text-[#8b949e]">{connected ? 'Live' : 'Disconnected'}</span>
          </div>
          <div className={`text-xs px-2 py-1 rounded border font-mono ${
            state?.mode === 'paper'
              ? 'border-[#ffbb33]/40 text-[#ffbb33] bg-[#ffbb33]/5'
              : 'border-[#ff4444]/40 text-[#ff4444] bg-[#ff4444]/5'
          }`}>
            {state?.mode?.toUpperCase() || 'PAPER'}
          </div>
        </div>
      </header>

      {/* Banners */}
      {paused && (
        <div className="bg-[#ff4444]/10 border-b border-[#ff4444]/30 px-6 py-2 flex items-center justify-between">
          <div className="text-[#ff4444] text-sm font-semibold">⏸ Emergency Pause Active — All trading halted</div>
          <button onClick={resume} disabled={loading.resume}
            className="text-xs px-3 py-1 rounded border border-[#00c851]/50 text-[#00c851] hover:bg-[#00c851]/10 disabled:opacity-50">
            {loading.resume ? '...' : 'Resume Trading'}
          </button>
        </div>
      )}
      {cbTripped && (
        <div className="bg-[#ff4444]/10 border-b border-[#ff4444]/30 px-6 py-2 flex items-center justify-between">
          <div className="text-[#ff4444] text-sm font-semibold">🚨 Circuit Breaker Tripped — Daily drawdown exceeded</div>
          <button onClick={resetCircuitBreaker} disabled={loading.cbReset}
            className="text-xs px-3 py-1 rounded border border-[#ff4444]/50 text-[#ff4444] hover:bg-[#ff4444]/10 disabled:opacity-50">
            {loading.cbReset ? '...' : 'Reset'}
          </button>
        </div>
      )}
      {!providers.openrouter && !providers.xai && (
        <div className="bg-[#ffbb33]/10 border-b border-[#ffbb33]/30 px-6 py-2 text-[#ffbb33] text-sm">
          ⚠ No LLM providers configured. Add <span className="font-mono">OPENROUTER_API_KEY</span> and <span className="font-mono">XAI_API_KEY</span> to Replit Secrets.
        </div>
      )}

      {/* Controls */}
      <div className="px-6 py-4 border-b border-[#30363d] flex items-center gap-3 flex-wrap">
        {isRunning ? (
          <button onClick={stopAgent} disabled={loading.stop}
            className="px-4 py-2 rounded-lg bg-[#ff4444]/10 border border-[#ff4444]/40 text-[#ff4444] text-sm font-semibold hover:bg-[#ff4444]/20 disabled:opacity-50">
            {loading.stop ? '…' : '⏹ Stop Agent'}
          </button>
        ) : (
          <button onClick={startAgent} disabled={loading.start || paused}
            className="px-4 py-2 rounded-lg bg-[#00c851]/10 border border-[#00c851]/40 text-[#00c851] text-sm font-semibold hover:bg-[#00c851]/20 disabled:opacity-50">
            {loading.start ? '…' : '▶ Start Agent'}
          </button>
        )}
        <button onClick={runNow} disabled={loading.runNow || paused}
          className="px-4 py-2 rounded-lg bg-[#2196f3]/10 border border-[#2196f3]/40 text-[#2196f3] text-sm font-semibold hover:bg-[#2196f3]/20 disabled:opacity-50">
          {loading.runNow ? 'Running…' : '⚡ Run Cycle Now'}
        </button>
        {!paused && (
          <button onClick={emergencyPause} disabled={loading.pause}
            className="px-4 py-2 rounded-lg bg-[#ff4444]/10 border border-[#ff4444]/40 text-[#ff4444] text-sm font-semibold hover:bg-[#ff4444]/20 disabled:opacity-50">
            {loading.pause ? '…' : '🛑 Emergency Pause'}
          </button>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm text-[#8b949e]">
          {state?.lastRun && <span>Last run: {new Date(state.lastRun).toLocaleTimeString()}</span>}
          <span>Cycle #{state?.cycleCount ?? 0}</span>
          <span>Interval: {state?.intervalSeconds}s</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-6 border-b border-[#30363d] flex gap-0 overflow-x-auto">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              tab === t ? 'border-[#2196f3] text-white' : 'border-transparent text-[#8b949e] hover:text-white'
            }`}>{t}</button>
        ))}
      </div>

      <main className="p-6">
        {tab === 'Dashboard' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard label="Portfolio Value" value={`$${equity}`} icon="💼" />
              <StatCard label="Cash" value={`$${cash}`} icon="💵" color="text-[#00c851]" />
              <StatCard label="Daily P&L" icon="📊"
                value={`${dailyPnL >= 0 ? '+' : ''}$${dailyPnL.toFixed(2)}`}
                color={dailyPnL >= 0 ? 'text-[#00c851]' : 'text-[#ff4444]'}
                sub={`${dailyPct >= 0 ? '+' : ''}${dailyPct.toFixed(2)}% · stop at -${risk ? (risk.maxDailyDrawdownPct * 100).toFixed(0) : 5}%`} />
              <StatCard label="Total P&L" icon="📈"
                value={`${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`}
                color={totalPnL >= 0 ? 'text-[#00c851]' : 'text-[#ff4444]'}
                sub={`Start: $${state?.startingBalance?.toFixed(2) || '—'}`} />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard label="Agent Status" icon="🤖"
                value={paused ? 'Paused' : isRunning ? 'Running' : 'Stopped'}
                color={paused ? 'text-[#ff4444]' : isRunning ? 'text-[#00c851]' : 'text-[#8b949e]'} />
              <StatCard label="Open Positions" value={holdings.length} icon="📌"
                sub={`Max: ${risk?.maxHoldings || 8}`} />
              <StatCard label="Confidence Gate" icon="🎯"
                value={`${risk ? (risk.confidenceThreshold * 100).toFixed(0) : 85}%`}
                sub={`Max ${risk ? (risk.maxPositionPct * 100).toFixed(0) : 3}% per position`} />
              <StatCard label="LLM Ensemble" icon="🧠"
                value={`${(providers.openrouter ? 3 : 0) + (providers.xai ? 1 : 0)}/4`}
                sub="Gemini · Claude · GPT-4o · Grok"
                color="text-[#ffbb33]" />
            </div>

            {state?.lastError && (
              <div className="bg-[#ff4444]/10 border border-[#ff4444]/30 rounded-xl p-3 text-sm text-[#ff4444]">
                ⚠ Last cycle error: {state.lastError}
              </div>
            )}

            {signals.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider mb-3">Latest Signals</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {signals.slice(0, 8).map(s => <SignalCard key={s.symbol} signal={s} />)}
                </div>
              </div>
            )}

            {holdings.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider mb-3">Open Positions</h2>
                <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
                  <HoldingsTable holdings={holdings} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider mb-3">Recent Trades</h2>
                <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
                  <TradeLog trades={trades.slice(0, 8)} />
                </div>
              </div>
              <div>
                <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider mb-3">AI Reasoning Feed</h2>
                <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
                  <ReasoningFeed entries={audit.slice(0, 12)} />
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'AI Reasoning' && (
          <div>
            <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider mb-4">
              Live AI Decision Log — {audit.length} events
            </h2>
            <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
              <ReasoningFeed entries={audit} />
            </div>
          </div>
        )}

        {tab === 'Holdings' && (
          <div>
            <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider mb-4">
              Open Positions — {holdings.length} active
            </h2>
            <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
              <HoldingsTable holdings={holdings} />
            </div>
          </div>
        )}

        {tab === 'Trade History' && (
          <div>
            <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider mb-4">
              Trade History — {trades.length} entries
            </h2>
            <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
              <TradeLog trades={trades} />
            </div>
          </div>
        )}

        {tab === 'Signals' && (
          <div>
            <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider mb-4">
              Latest AI Signals — {signals.length} symbols
            </h2>
            {signals.length === 0 ? (
              <div className="text-center text-[#8b949e] py-16 text-sm">
                No signals yet. Click <strong>Run Cycle Now</strong> to generate.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {signals.map(s => <SignalCard key={s.symbol} signal={s} />)}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
