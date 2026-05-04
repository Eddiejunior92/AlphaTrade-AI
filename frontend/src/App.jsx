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
  { id: 'home',      label: 'Home',      icon: '◐' },
  { id: 'strategies', label: 'Strategies', icon: '⚡' },
  { id: 'reason',    label: 'Reasoning', icon: '🧠' },
  { id: 'positions', label: 'Positions', icon: '📊' },
  { id: 'trades',    label: 'Trades',    icon: '📜' },
  { id: 'settings',  label: 'Settings',  icon: '⚙' },
];

function fmt(n) { return typeof n === 'number' ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }

export default function App() {
  const [tab, setTab] = useState('home');
  const [chatOpen, setChatOpen] = useState(false);
  const [modeModal, setModeModal] = useState(null); // 'paper' | 'live' | null
  const [modeError, setModeError] = useState('');
  const {
    state, trades, audit, connected, loading, brokerChat,
    startAgent, stopAgent, runNow,
    emergencyPause, resume, resetCircuitBreaker, flatten,
    toggleStrategy, setTradingMode,
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
  const liveAvailable = state?.liveAvailable;
  const strategies = state?.strategies || [];
  const dayStrat = strategies.find(s => s.name === 'day');
  const swingStrat = strategies.find(s => s.name === 'swing');
  const enabledStrategies = strategies.filter(s => s.enabled);

  const handleModeSwitch = async () => {
    setModeError('');
    const target = modeModal;
    const r = await setTradingMode(target, target === 'live' ? 'I_UNDERSTAND_LIVE' : undefined);
    if (r?.success) setModeModal(null);
    else setModeError(r?.error || 'Switch failed');
  };

  return (
    <div className="min-h-screen pb-28 sm:pb-24">
      {/* Top bar */}
      <header className="sticky top-0 z-40 px-4 sm:px-6 py-3 backdrop-blur-xl bg-black/40 border-b border-white/5">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-gradient-to-br from-[var(--blue)] to-[var(--purple)] flex items-center justify-center text-base font-bold">α</div>
            <div>
              <div className="font-semibold text-[15px] tracking-tight flex items-center gap-1.5">
                AlphaTrade
                <span className="text-[10px] font-medium text-[var(--blue)]">·</span>
                <span className="text-[10px] font-medium text-[var(--text-dim)]">{enabledStrategies.map(s => s.label).join(' + ') || 'No strategy'}</span>
              </div>
              <div className="text-[10px] text-[var(--text-dim)] flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-[var(--green)] pulse-live' : 'bg-[var(--red)]'}`} />
                {connected ? 'Live' : 'Reconnecting…'} · Cycle #{state?.cycleCount ?? 0}
                {state?.market && (
                  <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold ${state.market.open ? 'bg-[var(--green)]/20 text-[var(--green)]' : 'bg-white/10 text-[var(--text-dim)]'}`}>
                    {state.market.open ? 'MKT OPEN' : 'MKT CLOSED'}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip text={`Tap to switch to ${mode === 'paper' ? 'LIVE (real money)' : 'paper (simulated)'} mode`}>
              <button
                onClick={() => { setModeError(''); setModeModal(mode === 'paper' ? 'live' : 'paper'); }}
                className={`text-[10px] font-bold px-2.5 py-1 rounded-full transition-colors ${
                  mode === 'paper' ? 'bg-[var(--yellow)]/15 text-[var(--yellow)] hover:bg-[var(--yellow)]/25'
                                   : 'bg-[var(--red)]/15 text-[var(--red)] hover:bg-[var(--red)]/25'
                }`}>
                {mode.toUpperCase()}
              </button>
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
                <div className="text-[11px] text-[var(--text-dim)]">Daily loss budget exceeded. All positions flattened. Reset to resume.</div>
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
                  <div className="text-base font-semibold">{holdings.length}</div>
                </div>
                <div>
                  <div className="text-[10px] text-[var(--text-dim)] uppercase">AI Models</div>
                  <div className="text-base font-semibold">{activeModels} <span className="text-[var(--text-dim)] text-[11px] font-normal">/ 4</span></div>
                </div>
              </div>
            </div>

            {/* Strategy mini-toggles */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[dayStrat, swingStrat].filter(Boolean).map(s => (
                <StrategyMini key={s.name} s={s} loading={loading[`strat:${s.name}`]}
                  onToggle={() => toggleStrategy(s.name, !s.enabled)} />
              ))}
            </div>

            {/* Quick actions */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Tooltip text={isRunning ? 'Stop the autonomous trading loop' : 'Start Alpha — runs all enabled strategies on their own cadence during market hours'}>
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
              <StatCard label="Confidence Gate" icon="🎯" value="85%"
                sub="Below this, no trade fires" color="text-[var(--blue)]" />
              <StatCard label="Daily Risk Cap" icon="💵" value={`$${risk?.maxDailyLossUSD ?? 100}`}
                sub={`$${(state?.dailyLossUSD || 0).toFixed(2)} used today`} color="text-[var(--red)]" />
              <StatCard label="Mode" icon={mode === 'live' ? '🔴' : '🟡'}
                value={mode.toUpperCase()}
                color={mode === 'live' ? 'text-[var(--red)]' : 'text-[var(--yellow)]'}
                sub={mode === 'live' ? 'Real money on the line' : 'Simulated, your money is safe'} />
              <StatCard label="Status" icon="🤖"
                value={paused ? 'Paused' : isRunning ? (state?.market?.open ? 'Trading' : 'Waiting') : 'Idle'}
                color={paused ? 'text-[var(--red)]' : isRunning ? (state?.market?.open ? 'text-[var(--green)]' : 'text-[var(--yellow)]') : 'text-[var(--text-dim)]'}
                sub={state?.market?.open ? 'Market open' : state?.market?.nextOpen ? `Opens ${new Date(state.market.nextOpen).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}` : 'Market closed'} />
            </div>

            {/* Live signals */}
            {signals.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-[15px] font-semibold tracking-tight">Live Signals</h2>
                  <span className="text-[11px] text-[var(--text-dim)]">{signals.length} symbols</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {signals.slice(0, 8).map(s => <SignalCard key={`${s.strategy || 'd'}-${s.symbol}`} signal={s} />)}
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

        {tab === 'strategies' && (
          <div className="space-y-5">
            <div className="glass-strong p-5 bg-gradient-to-br from-[var(--blue)]/10 to-transparent">
              <div className="flex items-center gap-3">
                <div className="text-3xl">⚡</div>
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">Trading Strategies</h2>
                  <div className="text-[12px] text-[var(--text-dim)]">Run day trading and longer-hold swings in parallel — independently or together. Each has its own risk profile, holding rules, and watchlist behavior.</div>
                </div>
              </div>
            </div>
            {strategies.map(s => (
              <StrategyCard key={s.name} s={s} loading={loading[`strat:${s.name}`]}
                holdings={holdings.filter(h => h.strategy === s.name)}
                onToggle={() => toggleStrategy(s.name, !s.enabled)} />
            ))}
          </div>
        )}

        {tab === 'reason' && (
          <div className="space-y-4">
            <div className="glass-strong p-5 bg-gradient-to-br from-[var(--blue)]/10 to-transparent">
              <div className="flex items-center gap-3">
                <div className="text-3xl">🧠</div>
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">AI Reasoning</h2>
                  <div className="text-[12px] text-[var(--text-dim)]">Every decision Alpha makes is logged here in real time. Each model votes independently — Alpha only acts when 3+ agree at 85%+ confidence.</div>
                </div>
              </div>
            </div>
            <ReasoningFeed entries={audit} />
          </div>
        )}

        {tab === 'positions' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold tracking-tight">Open Positions <span className="text-[var(--text-dim)] text-sm font-normal">· {holdings.length}</span></h2>
            {strategies.map(s => {
              const sh = holdings.filter(h => h.strategy === s.name);
              if (!sh.length) return null;
              return (
                <div key={s.name} className="space-y-2">
                  <div className="text-[12px] font-semibold text-[var(--text-dim)] uppercase tracking-wider px-1">
                    {s.label} <span className="font-normal">({sh.length})</span>
                  </div>
                  <HoldingsTable holdings={sh} />
                </div>
              );
            })}
            {!holdings.length && <div className="glass p-6 text-center text-[var(--text-dim)] text-sm">No open positions.</div>}
            {holdings.length > 0 && (
              <Tooltip text="Sell every open position immediately at market price">
                <button onClick={flatten} disabled={loading.flatten} className="ios-btn ios-btn-danger w-full mt-2">
                  {loading.flatten ? 'Flattening…' : '🛑 Flatten All Positions'}
                </button>
              </Tooltip>
            )}
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
                  <div className="text-[11px] text-[var(--text-dim)]">Paper = simulated · Live = real money via Alpaca</div>
                </div>
                <span className={`text-[10px] font-bold px-3 py-1.5 rounded-full ${
                  mode === 'paper' ? 'bg-[var(--yellow)]/15 text-[var(--yellow)]' : 'bg-[var(--red)]/15 text-[var(--red)]'
                }`}>{mode.toUpperCase()}</span>
              </div>
              <div className="text-[11px] text-[var(--text-dim)] bg-white/3 rounded-xl p-3 mb-3">
                {mode === 'paper'
                  ? 'All orders simulated through the Alpaca paper account — your real money is safe.'
                  : '⚠ Real capital is at risk. All risk gates and circuit breakers still apply, but losses are real.'}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Tooltip text="Switch to paper trading (safe, simulated)">
                  <button onClick={() => { setModeError(''); setModeModal('paper'); }} disabled={mode === 'paper' || loading.mode}
                    className={`ios-btn w-full ${mode === 'paper' ? 'ios-btn-ghost' : 'ios-btn-success'}`}>
                    🟡 Paper
                  </button>
                </Tooltip>
                <Tooltip text={liveAvailable ? 'Switch to LIVE — requires confirmation' : 'Add ALPACA_LIVE_API_KEY + SECRET to enable'}>
                  <button onClick={() => { setModeError(''); setModeModal('live'); }}
                    disabled={mode === 'live' || !liveAvailable || loading.mode}
                    className={`ios-btn w-full ${mode === 'live' ? 'ios-btn-ghost' : 'ios-btn-danger'}`}>
                    🔴 Live
                  </button>
                </Tooltip>
              </div>
              {!liveAvailable && (
                <div className="text-[10px] text-[var(--text-dim)] mt-2">
                  Add <span className="font-mono">ALPACA_LIVE_API_KEY</span> and <span className="font-mono">ALPACA_LIVE_SECRET_KEY</span> in Secrets to unlock live trading.
                </div>
              )}
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

            <div className="glass p-5">
              <div className="font-semibold text-[14px] mb-2">Watchlist</div>
              <div className="text-[12px] text-[var(--text-dim)]">{state?.watchlist?.join(', ')}</div>
            </div>
          </div>
        )}
      </main>

      {/* Bottom nav */}
      <nav className="fixed bottom-0 inset-x-0 z-50 px-3 pb-3 safe-bottom">
        <div className="max-w-md mx-auto glass-strong px-2 py-2 flex items-center justify-between">
          {TABS.map(t => (
            <Tooltip key={t.id} text={
              t.id === 'home' ? 'Dashboard overview' :
              t.id === 'strategies' ? 'Toggle day & swing strategies' :
              t.id === 'reason' ? "See Alpha's reasoning live" :
              t.id === 'positions' ? 'Your open positions' :
              t.id === 'trades' ? 'Trade history' :
              'Settings, funds, mode toggle'
            }>
              <button onClick={() => setTab(t.id)}
                className={`flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-2xl transition-all ${
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

      {/* Mode-switch confirmation modal */}
      {modeModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 anim-fade">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={() => setModeModal(null)} />
          <div className="relative glass-strong w-full max-w-md p-6 anim-slide-up">
            <div className="text-3xl mb-2">{modeModal === 'live' ? '🔴' : '🟡'}</div>
            <h3 className="text-xl font-semibold tracking-tight mb-2">
              Switch to {modeModal === 'live' ? 'LIVE Trading' : 'Paper Trading'}?
            </h3>
            {modeModal === 'live' ? (
              <div className="text-[13px] text-[var(--text-dim)] space-y-2">
                <p><strong className="text-[var(--red)]">This uses real money.</strong> All trades will execute on your live Alpaca brokerage account immediately.</p>
                <p>All risk gates remain active — 85% confidence, 3-of-4 quorum, $100/day loss budget — but actual losses will be real.</p>
                <p className="text-[var(--yellow)]">Make sure you understand your strategy and risk before continuing.</p>
              </div>
            ) : (
              <div className="text-[13px] text-[var(--text-dim)]">
                Switching back to paper mode. All future trades will be simulated through your Alpaca paper account. Your live positions will remain untouched on the broker side.
              </div>
            )}
            {modeError && (
              <div className="mt-3 text-[12px] text-[var(--red)] bg-[var(--red)]/10 rounded-xl p-3">
                {modeError}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 mt-5">
              <button onClick={() => setModeModal(null)} disabled={loading.mode} className="ios-btn ios-btn-ghost">
                Cancel
              </button>
              <button onClick={handleModeSwitch} disabled={loading.mode}
                className={`ios-btn ${modeModal === 'live' ? 'ios-btn-danger' : 'ios-btn-success'}`}>
                {loading.mode ? '…' : modeModal === 'live' ? 'Yes, Go Live' : 'Switch to Paper'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StrategyMini({ s, loading, onToggle }) {
  return (
    <Tooltip text={`${s.description} Tap to ${s.enabled ? 'disable' : 'enable'}.`}>
      <button onClick={onToggle} disabled={loading}
        className={`w-full glass p-4 text-left transition-all ${s.enabled ? 'border-[var(--green)]/40' : 'border-white/5 opacity-70'}`}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold flex items-center gap-2">
              {s.label}
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                s.enabled ? 'bg-[var(--green)]/20 text-[var(--green)]' : 'bg-white/5 text-[var(--text-dim)]'
              }`}>{s.enabled ? 'ON' : 'OFF'}</span>
            </div>
            <div className="text-[10px] text-[var(--text-dim)] mt-0.5">
              {s.timeframe} bars · {s.holdings} held · stop {(s.stopLossPct * 100).toFixed(1)}% / target {(s.takeProfitPct * 100).toFixed(1)}%
            </div>
          </div>
          <div className={`w-10 h-6 rounded-full p-0.5 transition-colors ${s.enabled ? 'bg-[var(--green)]' : 'bg-white/10'}`}>
            <div className={`w-5 h-5 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-4' : ''}`} />
          </div>
        </div>
      </button>
    </Tooltip>
  );
}

function StrategyCard({ s, loading, holdings, onToggle }) {
  return (
    <div className={`glass p-5 ${s.enabled ? '' : 'opacity-70'}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-[15px] font-semibold tracking-tight">{s.label}</h3>
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
              s.enabled ? 'bg-[var(--green)]/20 text-[var(--green)]' : 'bg-white/5 text-[var(--text-dim)]'
            }`}>{s.enabled ? 'RUNNING' : 'PAUSED'}</span>
          </div>
          <div className="text-[11px] text-[var(--text-dim)]">{s.description}</div>
        </div>
        <Tooltip text={s.enabled ? `Pause ${s.label}` : `Enable ${s.label}`}>
          <button onClick={onToggle} disabled={loading}
            className={`w-12 h-7 rounded-full p-0.5 transition-colors flex-shrink-0 ${s.enabled ? 'bg-[var(--green)]' : 'bg-white/10'}`}>
            <div className={`w-6 h-6 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-5' : ''}`} />
          </button>
        </Tooltip>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <Spec label="Timeframe" value={s.timeframe} />
        <Spec label="Cadence" value={`${s.intervalSeconds}s`} />
        <Spec label="Stop / Target" value={`${(s.stopLossPct * 100).toFixed(1)}% / ${(s.takeProfitPct * 100).toFixed(1)}%`} />
        <Spec label="Risk per trade" value={`$${s.minRiskUSD}–$${s.maxRiskUSD}`} />
        <Spec label="Max holdings" value={s.maxHoldings} />
        <Spec label="Position cap" value={`${(s.maxPositionPct * 100).toFixed(1)}%`} />
        <Spec label="Hold overnight" value={s.holdOvernight ? 'Yes' : 'No'} />
        <Spec label="Auto-flatten" value={s.forceFlattenBeforeClose ? 'Before close' : 'Never'} />
      </div>
      <div className="text-[11px] text-[var(--text-dim)] flex items-center justify-between border-t border-white/5 pt-3">
        <span>{holdings.length} open · {s.cycles} cycles run</span>
        <span>{s.lastRun ? `Last: ${new Date(s.lastRun).toLocaleTimeString()}` : 'Not yet run'}</span>
      </div>
    </div>
  );
}

function Spec({ label, value }) {
  return (
    <div className="bg-white/3 rounded-xl px-3 py-2">
      <div className="text-[9px] text-[var(--text-dim)] uppercase tracking-wider">{label}</div>
      <div className="text-[12px] font-semibold mt-0.5">{value}</div>
    </div>
  );
}
