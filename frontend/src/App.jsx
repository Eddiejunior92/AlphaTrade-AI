import { useState } from 'react';
import { useAgent } from './hooks/useAgent';
import StatCard from './components/StatCard';
import SignalCard from './components/SignalCard';
import TradeLog from './components/TradeLog';
import HoldingsTable from './components/HoldingsTable';
import ReasoningFeed from './components/ReasoningFeed';
import VoiceChat from './components/VoiceChat';
import Tooltip from './components/Tooltip';

const TABS = [
  { id: 'home',    label: 'Home',     icon: '◐' },
  { id: 'reason',  label: 'Reasoning', icon: '🧠' },
  { id: 'positions', label: 'Positions', icon: '📊' },
  { id: 'trades',  label: 'Trades',   icon: '📜' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

function fmt(n) { return typeof n === 'number' ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }

export default function App() {
  const [tab, setTab] = useState('home');
  const [chatOpen, setChatOpen] = useState(false);
  const {
    state, trades, audit, connected, loading, brokerChat,
    startAgent, stopAgent, runNow,
    emergencyPause, resume, resetCircuitBreaker,
  } = useAgent();

  const equity = state?.equity || 0;
  const cash = state?.cash || 0;
  const dailyPnL = state?.dailyPnL || 0;
  const totalPnL = state?.totalPnL || 0;
  const dailyPct = state?.dailyPnLPct || 0;
  const signals = state?.signals ? Object.values(state.signals) : [];
  const holdings = state?.holdings || [];
  const isRunning = state?.running;
  const paused = state?.emergencyPause;
  const cbTripped = state?.circuitBreakerTripped;
  const providers = state?.providers || { openrouter: false, xai: false };
  const activeModels = (providers.openrouter ? 3 : 0) + (providers.xai ? 1 : 0);
  const risk = state?.risk;
  const mode = state?.mode || 'paper';

  return (
    <div className="min-h-screen pb-28 sm:pb-24">
      {/* Top bar */}
      <header className="sticky top-0 z-40 px-4 sm:px-6 py-3 backdrop-blur-xl bg-black/40 border-b border-white/5">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-gradient-to-br from-[var(--blue)] to-[var(--purple)] flex items-center justify-center text-base font-bold">α</div>
            <div>
              <div className="font-semibold text-[15px] tracking-tight">AlphaTrade</div>
              <div className="text-[10px] text-[var(--text-dim)] flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-[var(--green)] pulse-live' : 'bg-[var(--red)]'}`} />
                {connected ? 'Live' : 'Reconnecting…'} · Cycle #{state?.cycleCount ?? 0}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip text={`Currently ${mode === 'paper' ? 'paper trading (simulated, safe)' : 'LIVE trading with real money'}`}>
              <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${
                mode === 'paper' ? 'bg-[var(--yellow)]/15 text-[var(--yellow)]' : 'bg-[var(--red)]/15 text-[var(--red)]'
              }`}>{mode.toUpperCase()}</span>
            </Tooltip>
            <Tooltip text="Talk to Alpha — your AI broker">
              <button onClick={() => setChatOpen(true)}
                className="w-9 h-9 rounded-full bg-gradient-to-br from-[var(--blue)] to-[var(--purple)] flex items-center justify-center text-sm">💬</button>
            </Tooltip>
          </div>
        </div>
      </header>

      {/* Banners */}
      {paused && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 mt-3">
          <div className="glass p-3.5 flex items-center justify-between border border-[var(--red)]/30">
            <div className="flex items-center gap-3">
              <div className="text-xl">⏸</div>
              <div>
                <div className="text-sm font-semibold text-[var(--red)]">Emergency Pause Active</div>
                <div className="text-[11px] text-[var(--text-dim)]">All trading halted by you. Resume when ready.</div>
              </div>
            </div>
            <button onClick={resume} disabled={loading.resume} className="ios-btn ios-btn-success text-xs">
              {loading.resume ? '…' : 'Resume'}
            </button>
          </div>
        </div>
      )}
      {cbTripped && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 mt-3">
          <div className="glass p-3.5 flex items-center justify-between border border-[var(--red)]/30">
            <div className="flex items-center gap-3">
              <div className="text-xl">🚨</div>
              <div>
                <div className="text-sm font-semibold text-[var(--red)]">Circuit Breaker Tripped</div>
                <div className="text-[11px] text-[var(--text-dim)]">Daily drawdown exceeded {(risk?.maxDailyDrawdownPct * 100).toFixed(0)}%. Reset to resume.</div>
              </div>
            </div>
            <button onClick={resetCircuitBreaker} disabled={loading.cbReset} className="ios-btn ios-btn-danger text-xs">
              {loading.cbReset ? '…' : 'Reset'}
            </button>
          </div>
        </div>
      )}
      {!providers.openrouter && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 mt-3">
          <div className="glass p-3.5 border border-[var(--yellow)]/30 text-[var(--yellow)] text-[12px]">
            ⚠ Add <span className="font-mono">OPENROUTER_API_KEY</span> to enable the AI ensemble and broker chat.
          </div>
        </div>
      )}

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-5 anim-fade">
        {tab === 'home' && (
          <div className="space-y-6">
            {/* Hero portfolio card */}
            <div className="glass-strong p-6 sm:p-8">
              <div className="text-[11px] text-[var(--text-dim)] uppercase tracking-wider mb-1">Portfolio Value</div>
              <div className="text-4xl sm:text-5xl font-semibold tracking-tight">${fmt(equity)}</div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3">
                <div className={`text-sm font-medium ${dailyPnL >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                  {dailyPnL >= 0 ? '↑' : '↓'} ${fmt(Math.abs(dailyPnL))} ({dailyPct >= 0 ? '+' : ''}{dailyPct.toFixed(2)}%) today
                </div>
                <div className="text-[12px] text-[var(--text-dim)]">
                  All-time: <span className={totalPnL >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>
                    {totalPnL >= 0 ? '+' : ''}${fmt(totalPnL)}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 mt-6">
                <div>
                  <div className="text-[10px] text-[var(--text-dim)] uppercase">Cash</div>
                  <div className="text-base font-semibold">${fmt(cash)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-[var(--text-dim)] uppercase">Positions</div>
                  <div className="text-base font-semibold">{holdings.length} <span className="text-[var(--text-dim)] text-[11px] font-normal">/ {risk?.maxHoldings || 8}</span></div>
                </div>
                <div>
                  <div className="text-[10px] text-[var(--text-dim)] uppercase">AI Models</div>
                  <div className="text-base font-semibold">{activeModels} <span className="text-[var(--text-dim)] text-[11px] font-normal">/ 4</span></div>
                </div>
              </div>
            </div>

            {/* Quick actions */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Tooltip text={isRunning ? 'Stop the autonomous trading loop' : 'Start the AI agent — it will analyze the market every 5 minutes'}>
                {isRunning ? (
                  <button onClick={stopAgent} disabled={loading.stop} className="ios-btn ios-btn-ghost w-full">
                    <span>⏹</span> {loading.stop ? '…' : 'Stop Agent'}
                  </button>
                ) : (
                  <button onClick={startAgent} disabled={loading.start || paused} className="ios-btn ios-btn-success w-full">
                    <span>▶</span> {loading.start ? '…' : 'Start Agent'}
                  </button>
                )}
              </Tooltip>
              <Tooltip text="Run one analysis cycle right now without waiting">
                <button onClick={runNow} disabled={loading.runNow || paused} className="ios-btn ios-btn-primary w-full">
                  <span>⚡</span> {loading.runNow ? 'Running…' : 'Run Now'}
                </button>
              </Tooltip>
              <Tooltip text="Instantly halt all trading. Use this if anything feels off.">
                <button onClick={paused ? resume : emergencyPause} disabled={loading.pause || loading.resume}
                  className={`ios-btn w-full ${paused ? 'ios-btn-success' : 'ios-btn-danger'}`}>
                  <span>{paused ? '▶' : '🛑'}</span> {paused ? 'Resume' : 'Pause'}
                </button>
              </Tooltip>
              <Tooltip text="Open chat with Alpha — your personal AI broker. Use voice or text.">
                <button onClick={() => setChatOpen(true)} className="ios-btn ios-btn-ghost w-full">
                  <span>🎙</span> Talk to Alpha
                </button>
              </Tooltip>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Confidence Gate" icon="🎯" value={`${(risk?.confidenceThreshold * 100).toFixed(0) || 85}%`}
                sub="Below this, no trade fires" color="text-[var(--blue)]" />
              <StatCard label="Max Per Trade" icon="🛡" value={`${(risk?.maxPositionPct * 100).toFixed(0) || 3}%`}
                sub="Of portfolio per position" />
              <StatCard label="Daily Stop" icon="🚨" value={`${(risk?.maxDailyDrawdownPct * 100).toFixed(0) || 5}%`}
                sub="Auto-halt on drawdown" color="text-[var(--red)]" />
              <StatCard label="Status" icon="🤖"
                value={paused ? 'Paused' : isRunning ? 'Active' : 'Idle'}
                color={paused ? 'text-[var(--red)]' : isRunning ? 'text-[var(--green)]' : 'text-[var(--text-dim)]'}
                sub={state?.lastRun ? `Last run ${new Date(state.lastRun).toLocaleTimeString()}` : 'Never run'} />
            </div>

            {/* Live signals */}
            {signals.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-[15px] font-semibold tracking-tight">Live Signals</h2>
                  <span className="text-[11px] text-[var(--text-dim)]">{signals.length} symbols</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {signals.slice(0, 8).map(s => <SignalCard key={s.symbol} signal={s} />)}
                </div>
              </section>
            )}

            {/* Reasoning preview */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[15px] font-semibold tracking-tight flex items-center gap-2">
                  <span>🧠</span> Alpha's Latest Thinking
                </h2>
                <button onClick={() => setTab('reason')} className="text-[11px] text-[var(--blue)] font-medium">See all →</button>
              </div>
              <ReasoningFeed entries={audit.slice(0, 5)} compact />
            </section>
          </div>
        )}

        {tab === 'reason' && (
          <div className="space-y-4">
            <div className="glass-strong p-5 bg-gradient-to-br from-[var(--blue)]/10 to-transparent">
              <div className="flex items-center gap-3">
                <div className="text-3xl">🧠</div>
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">AI Reasoning</h2>
                  <div className="text-[12px] text-[var(--text-dim)]">Every decision Alpha makes is logged here in real time. Each model votes independently — Alpha only acts when 3+ agree at high confidence.</div>
                </div>
              </div>
            </div>
            <ReasoningFeed entries={audit} />
          </div>
        )}

        {tab === 'positions' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold tracking-tight">Open Positions <span className="text-[var(--text-dim)] text-sm font-normal">· {holdings.length}</span></h2>
            <HoldingsTable holdings={holdings} />
          </div>
        )}

        {tab === 'trades' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold tracking-tight">Trade History <span className="text-[var(--text-dim)] text-sm font-normal">· {trades.length}</span></h2>
            <TradeLog trades={trades} />
          </div>
        )}

        {tab === 'settings' && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold tracking-tight">Settings & Account</h2>

            {/* Mode toggle */}
            <div className="glass p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="font-semibold text-[14px]">Trading Mode</div>
                  <div className="text-[11px] text-[var(--text-dim)]">Paper = simulated · Live = real money</div>
                </div>
                <Tooltip text="Set TRADING_MODE=live in your environment to switch. Restart required.">
                  <span className={`text-[10px] font-bold px-3 py-1.5 rounded-full ${
                    mode === 'paper' ? 'bg-[var(--yellow)]/15 text-[var(--yellow)]' : 'bg-[var(--red)]/15 text-[var(--red)]'
                  }`}>{mode.toUpperCase()}</span>
                </Tooltip>
              </div>
              <div className="text-[11px] text-[var(--text-dim)] bg-white/3 rounded-xl p-3">
                Currently in <strong>{mode}</strong> mode. {mode === 'paper'
                  ? 'All orders simulated through Alpaca paper account — your real money is safe.'
                  : 'Orders will execute with real capital. Use extreme caution.'}
              </div>
            </div>

            {/* Funds */}
            <div className="glass p-5">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="font-semibold text-[14px]">Connected Account</div>
                  <div className="text-[11px] text-[var(--text-dim)]">Alpaca {mode === 'paper' ? 'Paper' : 'Live'} brokerage</div>
                </div>
                <Tooltip text="Manage funding directly in your Alpaca dashboard">
                  <a href="https://app.alpaca.markets" target="_blank" rel="noreferrer" className="ios-btn ios-btn-primary text-xs">
                    Add / Manage Funds
                  </a>
                </Tooltip>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div className="bg-white/3 rounded-xl p-3">
                  <div className="text-[10px] text-[var(--text-dim)] uppercase">Cash Balance</div>
                  <div className="text-lg font-semibold">${fmt(cash)}</div>
                </div>
                <div className="bg-white/3 rounded-xl p-3">
                  <div className="text-[10px] text-[var(--text-dim)] uppercase">Total Equity</div>
                  <div className="text-lg font-semibold">${fmt(equity)}</div>
                </div>
              </div>
            </div>

            {/* Agent control */}
            <div className="glass p-5 space-y-3">
              <div>
                <div className="font-semibold text-[14px] mb-1">Agent Control</div>
                <div className="text-[11px] text-[var(--text-dim)]">Start, stop, or pause Alpha at any time</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {isRunning ? (
                  <button onClick={stopAgent} disabled={loading.stop} className="ios-btn ios-btn-ghost">⏹ Stop Agent</button>
                ) : (
                  <button onClick={startAgent} disabled={loading.start || paused} className="ios-btn ios-btn-success">▶ Start Agent</button>
                )}
                <button onClick={runNow} disabled={loading.runNow || paused} className="ios-btn ios-btn-primary">⚡ Run Now</button>
                {paused ? (
                  <button onClick={resume} disabled={loading.resume} className="ios-btn ios-btn-success col-span-2">▶ Resume from Pause</button>
                ) : (
                  <button onClick={emergencyPause} disabled={loading.pause} className="ios-btn ios-btn-danger col-span-2">🛑 Emergency Pause</button>
                )}
                {cbTripped && (
                  <button onClick={resetCircuitBreaker} disabled={loading.cbReset} className="ios-btn ios-btn-danger col-span-2">↻ Reset Circuit Breaker</button>
                )}
              </div>
            </div>

            {/* Risk config */}
            <div className="glass p-5">
              <div className="font-semibold text-[14px] mb-3">Risk Guardrails</div>
              <div className="space-y-2 text-[12px]">
                <Row label="Confidence required" value={`${(risk?.confidenceThreshold * 100).toFixed(0)}%`} />
                <Row label="Max position size" value={`${(risk?.maxPositionPct * 100).toFixed(0)}% of portfolio`} />
                <Row label="Daily drawdown stop" value={`${(risk?.maxDailyDrawdownPct * 100).toFixed(0)}%`} />
                <Row label="Stop-loss / take-profit" value={`-${(risk?.stopLossPct * 100).toFixed(0)}% / +${(risk?.takeProfitPct * 100).toFixed(0)}%`} />
                <Row label="Max holdings" value={risk?.maxHoldings} />
                <Row label="Cycle interval" value={`${state?.intervalSeconds}s`} />
                <Row label="Watchlist" value={state?.watchlist?.join(', ')} />
              </div>
            </div>

            {/* AI Models */}
            <div className="glass p-5">
              <div className="font-semibold text-[14px] mb-3">AI Ensemble</div>
              <div className="space-y-2">
                {(providers.models || []).map(m => {
                  const active = (m.provider === 'openrouter' && providers.openrouter) || (m.provider === 'xai' && providers.xai);
                  return (
                    <div key={m.id} className="flex items-center justify-between bg-white/3 rounded-xl p-3">
                      <div>
                        <div className="text-[13px] font-semibold">{m.label}</div>
                        <div className="text-[10px] text-[var(--text-dim)]">{m.role}</div>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${
                        active ? 'bg-[var(--green)]/15 text-[var(--green)]' : 'bg-white/5 text-[var(--text-dim)]'
                      }`}>{active ? 'ACTIVE' : 'OFFLINE'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Bottom nav (mobile-first) */}
      <nav className="fixed bottom-0 inset-x-0 z-50 px-3 pb-3 safe-bottom">
        <div className="max-w-md mx-auto glass-strong px-2 py-2 flex items-center justify-between">
          {TABS.map(t => (
            <Tooltip key={t.id} text={
              t.id === 'home' ? 'Dashboard overview' :
              t.id === 'reason' ? "See Alpha's reasoning live" :
              t.id === 'positions' ? 'Your open positions' :
              t.id === 'trades' ? 'Trade history' :
              'Settings, funds, mode toggle'
            }>
              <button onClick={() => setTab(t.id)}
                className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-2xl transition-all ${
                  tab === t.id ? 'bg-white/10 text-white' : 'text-[var(--text-dim)] hover:text-white'
                }`}>
                <span className="text-base leading-none">{t.icon}</span>
                <span className="text-[9px] font-medium">{t.label}</span>
              </button>
            </Tooltip>
          ))}
        </div>
      </nav>

      {/* Floating voice button */}
      <Tooltip text="Tap to talk with Alpha — your AI broker">
        <button onClick={() => setChatOpen(true)}
          className="fixed bottom-24 right-4 sm:bottom-6 sm:right-6 z-40 w-14 h-14 rounded-full bg-gradient-to-br from-[var(--blue)] to-[var(--purple)] flex items-center justify-center text-2xl shadow-2xl pulse-live">
          🎙
        </button>
      </Tooltip>

      <VoiceChat open={chatOpen} onClose={() => setChatOpen(false)} brokerChat={brokerChat} />
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
      <span className="text-[var(--text-dim)]">{label}</span>
      <span className="font-medium text-right">{value}</span>
    </div>
  );
}
