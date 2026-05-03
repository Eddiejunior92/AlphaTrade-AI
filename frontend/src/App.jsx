import { useState } from 'react';
import { useAgent } from './hooks/useAgent';
import StatCard from './components/StatCard';
import SignalCard from './components/SignalCard';
import TradeLog from './components/TradeLog';
import PositionsTable from './components/PositionsTable';

const TABS = ['Dashboard', 'Signals', 'Positions', 'Trade Log'];

export default function App() {
  const [tab, setTab] = useState('Dashboard');
  const {
    state, account, positions, orders, connected,
    loading, startAgent, stopAgent, runNow, resetCircuitBreaker,
  } = useAgent();

  const equity = account ? parseFloat(account.equity || 0).toFixed(2) : '—';
  const cash = account ? parseFloat(account.cash || 0).toFixed(2) : '—';
  const buyingPower = account ? parseFloat(account.buying_power || 0).toFixed(2) : '—';
  const signals = state?.signals ? Object.values(state.signals) : [];
  const isRunning = state?.running;
  const circuitTripped = state?.circuitBreakerTripped;

  return (
    <div className="min-h-screen bg-[#0d1117] text-[#e6edf3]">
      {/* Header */}
      <header className="border-b border-[#30363d] bg-[#161b22] px-6 py-3 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <span className="text-2xl">📈</span>
          <div>
            <h1 className="font-bold text-lg leading-tight">AlphaTrade AI</h1>
            <div className="text-xs text-[#8b949e]">Multi-LLM Autonomous Trading Agent</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs">
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-[#00c851] pulse-green' : 'bg-[#ff4444]'}`} />
            <span className="text-[#8b949e]">{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
          <div className={`text-xs px-2 py-1 rounded border font-mono ${
            state?.mode === 'paper'
              ? 'border-[#ffbb33]/40 text-[#ffbb33] bg-[#ffbb33]/5'
              : 'border-[#ff4444]/40 text-[#ff4444] bg-[#ff4444]/5'
          }`}>
            {state?.mode?.toUpperCase() || 'PAPER'} MODE
          </div>
        </div>
      </header>

      {/* Circuit Breaker Banner */}
      {circuitTripped && (
        <div className="bg-[#ff4444]/10 border-b border-[#ff4444]/30 px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-[#ff4444] text-sm">
            <span>🚨</span>
            <span className="font-semibold">Circuit Breaker Active</span>
            <span className="text-[#8b949e]">— Daily loss limit reached. Trading halted.</span>
          </div>
          <button
            onClick={resetCircuitBreaker}
            className="text-xs px-3 py-1 rounded border border-[#ff4444]/50 text-[#ff4444] hover:bg-[#ff4444]/10 transition-colors"
          >
            Reset
          </button>
        </div>
      )}

      {/* Controls */}
      <div className="px-6 py-4 border-b border-[#30363d] flex items-center gap-3 flex-wrap">
        {isRunning ? (
          <button
            onClick={stopAgent}
            disabled={loading.stop}
            className="px-4 py-2 rounded-lg bg-[#ff4444]/10 border border-[#ff4444]/40 text-[#ff4444] text-sm font-semibold hover:bg-[#ff4444]/20 transition-colors disabled:opacity-50"
          >
            {loading.stop ? 'Stopping…' : '⏹ Stop Agent'}
          </button>
        ) : (
          <button
            onClick={startAgent}
            disabled={loading.start}
            className="px-4 py-2 rounded-lg bg-[#00c851]/10 border border-[#00c851]/40 text-[#00c851] text-sm font-semibold hover:bg-[#00c851]/20 transition-colors disabled:opacity-50"
          >
            {loading.start ? 'Starting…' : '▶ Start Agent'}
          </button>
        )}
        <button
          onClick={runNow}
          disabled={loading.runNow}
          className="px-4 py-2 rounded-lg bg-[#2196f3]/10 border border-[#2196f3]/40 text-[#2196f3] text-sm font-semibold hover:bg-[#2196f3]/20 transition-colors disabled:opacity-50"
        >
          {loading.runNow ? 'Running…' : '⚡ Run Now'}
        </button>
        <div className="ml-auto flex items-center gap-4 text-sm text-[#8b949e]">
          {state?.lastRun && (
            <span>Last run: {new Date(state.lastRun).toLocaleTimeString()}</span>
          )}
          <span>Trades today: <span className="text-white font-mono">{state?.tradesCount ?? 0}</span></span>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-6 border-b border-[#30363d] flex gap-0">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? 'border-[#2196f3] text-white'
                : 'border-transparent text-[#8b949e] hover:text-white'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <main className="p-6">
        {/* Dashboard Tab */}
        {tab === 'Dashboard' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard
                label="Portfolio Value"
                value={`$${equity}`}
                icon="💼"
                color="text-white"
              />
              <StatCard
                label="Cash"
                value={`$${cash}`}
                icon="💵"
                color="text-[#00c851]"
              />
              <StatCard
                label="Buying Power"
                value={`$${buyingPower}`}
                icon="⚡"
                color="text-[#2196f3]"
              />
              <StatCard
                label="Daily P&L"
                value={`$${(state?.dailyPnL || 0).toFixed(2)}`}
                icon="📊"
                color={state?.dailyPnL >= 0 ? 'text-[#00c851]' : 'text-[#ff4444]'}
                sub="Limit: $500"
              />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard
                label="Agent Status"
                value={isRunning ? 'Running' : 'Stopped'}
                icon="🤖"
                color={isRunning ? 'text-[#00c851]' : 'text-[#ff4444]'}
              />
              <StatCard
                label="Active Signals"
                value={signals.length}
                icon="📡"
              />
              <StatCard
                label="Open Positions"
                value={positions.length}
                icon="📌"
              />
              <StatCard
                label="LLM Ensemble"
                value="4 Models"
                icon="🧠"
                sub="Gemini · Claude · GPT-4o · Grok"
                color="text-[#ffbb33]"
              />
            </div>

            {/* Recent signals preview */}
            {signals.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider mb-3">Latest Signals</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {signals.slice(0, 4).map(s => (
                    <SignalCard key={s.symbol} signal={s} />
                  ))}
                </div>
              </div>
            )}

            {/* Recent trades */}
            {state?.tradeLog?.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider mb-3">Recent Trades</h2>
                <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
                  <TradeLog trades={state.tradeLog.slice(0, 5)} />
                </div>
              </div>
            )}

            {/* Setup guide if no keys */}
            {signals.length === 0 && !state?.running && (
              <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-6">
                <h2 className="font-bold text-lg mb-3">🚀 Quick Setup</h2>
                <ol className="space-y-2 text-sm text-[#8b949e] list-decimal list-inside">
                  <li>Add your API keys as environment secrets (Gemini, Claude, GPT-4o, Grok)</li>
                  <li>Set your Alpaca paper trading credentials</li>
                  <li>Optionally add a Discord webhook for mobile alerts</li>
                  <li>Click <strong className="text-white">Start Agent</strong> or <strong className="text-white">Run Now</strong> to begin</li>
                </ol>
                <div className="mt-4 p-3 bg-[#0d1117] rounded-lg border border-[#30363d] text-xs font-mono text-[#8b949e]">
                  GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GROK_API_KEY<br />
                  ALPACA_API_KEY, ALPACA_SECRET_KEY<br />
                  DISCORD_WEBHOOK_URL (optional)
                </div>
              </div>
            )}
          </div>
        )}

        {/* Signals Tab */}
        {tab === 'Signals' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider">
                AI Signals — {signals.length} symbols analyzed
              </h2>
              <button
                onClick={runNow}
                disabled={loading.runNow}
                className="text-xs px-3 py-1.5 rounded border border-[#2196f3]/40 text-[#2196f3] hover:bg-[#2196f3]/10 transition-colors disabled:opacity-50"
              >
                {loading.runNow ? 'Running…' : 'Refresh Signals'}
              </button>
            </div>
            {signals.length === 0 ? (
              <div className="text-center text-[#8b949e] py-16 text-sm">
                No signals yet. Run the agent to generate AI analysis.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {signals.map(s => (
                  <SignalCard key={s.symbol} signal={s} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Positions Tab */}
        {tab === 'Positions' && (
          <div>
            <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider mb-4">
              Open Positions — {positions.length} active
            </h2>
            <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
              <PositionsTable positions={positions} />
            </div>
          </div>
        )}

        {/* Trade Log Tab */}
        {tab === 'Trade Log' && (
          <div>
            <h2 className="text-sm font-semibold text-[#8b949e] uppercase tracking-wider mb-4">
              Trade Log — {state?.tradeLog?.length ?? 0} entries
            </h2>
            <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
              <TradeLog trades={state?.tradeLog || []} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
