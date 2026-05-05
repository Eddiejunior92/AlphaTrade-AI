import { useState, useEffect } from 'react';
import { useAgent } from './hooks/useAgent';
import StatCard from './components/StatCard';
import SignalCard from './components/SignalCard';
import TradeLog from './components/TradeLog';
import HoldingsTable from './components/HoldingsTable';
import ReasoningFeed from './components/ReasoningFeed';
import VoiceChat from './components/VoiceChat';
import Tooltip from './components/Tooltip';
import MarketsTab from './components/MarketsTab';
import ErrorBoundary from './components/ErrorBoundary';
import MarketClocks from './components/MarketClocks';
import PreMarketBriefing from './components/PreMarketBriefing';
import BacktestPanel from './components/BacktestPanel';
import SafetySuggestionsPanel from './components/SafetySuggestionsPanel';
import StrategyProposalsPanel from './components/StrategyProposalsPanel';
import MarketFilter from './components/MarketFilter';
import SectorFilter, { buildSectorCounts } from './components/SectorFilter';
import CompaniesTab from './components/CompaniesTab';
import FxBadge from './components/FxBadge';
import { makeMarketOf, currencySymbolForMarket, toUsd } from './lib/markets';
import { makeSectorOf } from './lib/sectors';
import { useMemo } from 'react';

const TABS = [
  { id: 'home',       label: 'Home',      icon: '◐' },
  { id: 'markets',    label: 'Markets',   icon: '📈' },
  { id: 'companies',  label: 'Companies', icon: '🏢' },
  { id: 'strategies', label: 'Strategies', icon: '⚡' },
  { id: 'reason',     label: 'Reasoning', icon: '🧠' },
  { id: 'positions',  label: 'Positions', icon: '📊' },
  { id: 'trades',     label: 'Trades',    icon: '📜' },
  { id: 'backtest',   label: 'Backtest',  icon: '🔬' },
  { id: 'settings',   label: 'Settings',  icon: '⚙' },
];

function fmt(n) { return typeof n === 'number' ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }

function LiveBadge({ connected, pulseAt }) {
  // Briefly flash brighter for 1.2s after each new live entry arrives.
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!pulseAt) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [pulseAt]);

  if (!connected) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-[11px] font-semibold text-[var(--text-dim)]">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-dim)]" />
        OFFLINE
      </div>
    );
  }
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold transition-colors ${flash ? 'bg-[var(--green)]/25 border-[var(--green)]/50 text-[var(--green)]' : 'bg-[var(--green)]/10 border-[var(--green)]/30 text-[var(--green)]'}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] pulse-live" />
      LIVE
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState('home');
  const [chatOpen, setChatOpen] = useState(false);
  const [modeModal, setModeModal] = useState(null); // 'paper' | 'live' | null
  const [modeError, setModeError] = useState('');
  const [modeConfirmText, setModeConfirmText] = useState('');
  // Per-tab market filters — separate state so a user filtering Trades to ASX
  // doesn't also narrow the Live Signals strip on Home.
  const [signalsMarket, setSignalsMarket] = useState('ALL');
  const [posMarket, setPosMarket] = useState('ALL');
  const [tradesMarket, setTradesMarket] = useState('ALL');
  const [reasonMarket, setReasonMarket] = useState('ALL');
  // Sector filters mirror the market filters — separate state per surface so
  // a user pinning Positions to "Healthcare" doesn't also narrow live signals.
  const [signalsSector, setSignalsSector] = useState('ALL');
  const [posSector, setPosSector] = useState('ALL');
  // Companies catalog — fetched once on mount, shared with every surface that
  // needs symbol→sector lookup (signals, positions, etc.). Cheap because the
  // endpoint just merges a static map with the existing fundamentals cache.
  const [companies, setCompanies] = useState([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/companies').then(r => r.json()).then(j => {
      if (!cancelled) setCompanies(j?.companies || []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const sectorOf = useMemo(() => makeSectorOf(companies), [companies]);
  // When the user clicks "Markets" on a Company card we set this to the
  // ticker; MarketsTab consumes it (then clears via onConsumed) to scroll to
  // and briefly highlight the matching card.
  const [focusSymbol, setFocusSymbol] = useState(null);
  const {
    state, trades, audit, premarket, refreshPremarket,
    connected, liveAuditAt, loading, brokerChat,
    startAgent, stopAgent, runNow,
    emergencyPause, resume, resetCircuitBreaker, flatten,
    toggleStrategy, setTradingMode, setRiskScale, setRecoveryBuffer, setDayCadence,
    authStatus, setOperatorToken, getStoredOperatorToken,
    setBreakerAutoReset,
  } = useAgent();
  // Operator token entry — UI lives in Settings, but the saved value is also
  // shown as a top-of-page red banner whenever the token is required but
  // missing/wrong, since otherwise every control button silently 401s.
  const [tokenInput, setTokenInput] = useState('');
  const [tokenSaved, setTokenSaved] = useState(false);
  useEffect(() => { setTokenInput(getStoredOperatorToken() || ''); }, [getStoredOperatorToken]);
  const saveOperatorToken = async () => {
    await setOperatorToken(tokenInput);
    setTokenSaved(true);
    setTimeout(() => setTokenSaved(false), 1800);
  };
  // Breaker auto-reset confirm modal: null | { nextEnabled: boolean }
  const [breakerToggleConfirm, setBreakerToggleConfirm] = useState(null);
  const breakerCfg = state?.breakerConfig;
  const tokenMissing = authStatus?.tokenRequired && !authStatus?.authenticated;

  const equity = state?.equity || 0;
  const cash = state?.cash || 0;
  const dailyPnL = state?.dailyPnL || 0;
  const totalPnL = state?.totalPnL || 0;
  const dailyPct = state?.dailyPnLPct || 0;
  const signals = state?.signals ? Object.values(state.signals) : [];
  const holdings = state?.holdings || [];
  const fx = state?.fx;
  // Single market resolver derived from the live ASX watchlist. Audit rows
  // and any signal missing `market` go through this.
  const marketOf = useMemo(
    () => makeMarketOf(state?.asxWatchlist || []),
    [state?.asxWatchlist]
  );
  const usMarket  = state?.markets?.US  || state?.market || { open: false };
  const asxMarket = state?.markets?.ASX || { open: false };

  // Counts for the tab filters — kept memoized so the chip count doesn't
  // recompute on every keystroke elsewhere.
  const signalCounts = useMemo(() => ({
    US:  signals.filter(s => (s.market || marketOf(s.symbol)) === 'US').length,
    ASX: signals.filter(s => (s.market || marketOf(s.symbol)) === 'ASX').length,
  }), [signals, marketOf]);
  const holdingCounts = useMemo(() => ({
    US:  holdings.filter(h => (h.market || 'US') === 'US').length,
    ASX: holdings.filter(h => h.market === 'ASX').length,
  }), [holdings]);
  const tradeCounts = useMemo(() => ({
    US:  trades.filter(t => (t.market || marketOf(t.symbol)) === 'US').length,
    ASX: trades.filter(t => (t.market || marketOf(t.symbol)) === 'ASX').length,
  }), [trades, marketOf]);
  const auditCounts = useMemo(() => ({
    US:  audit.filter(r => !r.symbol || marketOf(r.symbol) === 'US').length,
    ASX: audit.filter(r => !r.symbol || marketOf(r.symbol) === 'ASX').length,
  }), [audit, marketOf]);

  const filteredSignals = signals.filter(s => {
    const m = s.market || marketOf(s.symbol);
    if (signalsMarket !== 'ALL' && m !== signalsMarket) return false;
    if (signalsSector !== 'ALL' && sectorOf(s.symbol) !== signalsSector) return false;
    return true;
  });
  const filteredHoldings = holdings.filter(h => {
    const m = h.market || 'US';
    if (posMarket !== 'ALL' && m !== posMarket) return false;
    if (posSector !== 'ALL' && sectorOf(h.symbol) !== posSector) return false;
    return true;
  });
  const filteredTrades = tradesMarket === 'ALL'
    ? trades
    : trades.filter(t => (t.market || marketOf(t.symbol)) === tradesMarket);
  const filteredAudit = reasonMarket === 'ALL'
    ? audit
    : audit.filter(r => !r.symbol || marketOf(r.symbol) === reasonMarket);

  // Sector chip counts. Apply the *market* filter first so the sector counts
  // shown on a chip row reflect what's actually selectable under the current
  // market scope.
  const signalsSectorCounts = useMemo(() => {
    const scoped = signalsMarket === 'ALL' ? signals
      : signals.filter(s => (s.market || marketOf(s.symbol)) === signalsMarket);
    return buildSectorCounts(scoped, s => sectorOf(s.symbol));
  }, [signals, signalsMarket, marketOf, sectorOf]);
  const posSectorCounts = useMemo(() => {
    const scoped = posMarket === 'ALL' ? holdings
      : holdings.filter(h => (h.market || 'US') === posMarket);
    return buildSectorCounts(scoped, h => sectorOf(h.symbol));
  }, [holdings, posMarket, sectorOf]);

  // Per-market totals for the Positions tab. Native is in each market's own
  // currency; USD-equiv applies the live FX rate so the operator can compare
  // total exposure across markets at a glance.
  const marketTotals = useMemo(() => {
    const out = { US: { native: 0, pnl: 0, n: 0 }, ASX: { native: 0, pnl: 0, n: 0 } };
    for (const h of holdings) {
      const m = h.market || 'US';
      if (!out[m]) continue;
      out[m].native += h.marketValue || 0;
      out[m].pnl    += h.unrealizedPnL || 0;
      out[m].n      += 1;
    }
    return out;
  }, [holdings]);
  const isRunning = state?.running;
  const paused = state?.emergencyPause;
  const cbTripped = state?.circuitBreakerTripped;
  const providers = state?.providers || { openrouter: false, xai: false };
  const activeModels = (providers.openrouter ? 3 : 0) + (providers.xai ? 1 : 0);
  const risk = state?.risk;
  const riskScale = state?.riskScale;
  const riskScales = state?.riskScales || [];
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
    if (r?.success) { setModeModal(null); setModeConfirmText(''); }
    else setModeError(r?.error || 'Switch failed');
  };
  const closeModeModal = () => { setModeModal(null); setModeConfirmText(''); setModeError(''); };
  const liveConfirmOk = modeConfirmText.trim().toUpperCase() === 'LIVE';

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
              <div className="text-[10px] text-[var(--text-dim)] flex items-center gap-1.5 flex-wrap">
                <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-[var(--green)] pulse-live' : 'bg-[var(--red)]'}`} />
                {connected ? 'Live' : 'Reconnecting…'} · Cycle #{state?.cycleCount ?? 0}
                <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold ${usMarket.open ? 'bg-[var(--green)]/20 text-[var(--green)]' : 'bg-white/10 text-[var(--text-dim)]'}`}>
                  🇺🇸 {usMarket.open ? 'OPEN' : 'CLOSED'}
                </span>
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${asxMarket.open ? 'bg-[var(--green)]/20 text-[var(--green)]' : 'bg-white/10 text-[var(--text-dim)]'}`}>
                  🇦🇺 {asxMarket.open ? 'OPEN' : 'CLOSED'}
                </span>
                {fx && <FxBadge fx={fx} compact />}
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
      {tokenMissing && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 mt-3">
          <div className="rounded-2xl p-4 border-2 border-[var(--red)]/60 bg-[var(--red)]/10 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="text-2xl">🔐</div>
              <div>
                <div className="text-sm font-bold text-[var(--red)]">Operator token required</div>
                <div className="text-[11px] text-[var(--text-dim)]">All control buttons (start, stop, reset breaker, mode switch) will fail until you paste the token in Settings.</div>
              </div>
            </div>
            <button onClick={() => setTab('settings')} className="ios-btn ios-btn-danger text-xs whitespace-nowrap">Open Settings</button>
          </div>
        </div>
      )}
      {cbTripped && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 mt-3">
          <div className="rounded-2xl p-5 border-2 border-[var(--red)]/70 bg-gradient-to-r from-[var(--red)]/20 via-[var(--red)]/15 to-[var(--red)]/20 shadow-lg shadow-[var(--red)]/20 anim-fade">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-4">
                <div className="text-3xl pulse-live">🚨</div>
                <div>
                  <div className="text-base sm:text-lg font-bold text-[var(--red)] tracking-tight">Circuit Breaker Tripped — trading halted</div>
                  <div className="text-[12px] text-[var(--text-dim)] mt-0.5">
                    All positions were flattened. New trades are blocked until you reset the breaker.
                    {breakerCfg && (
                      <> Drawdown <span className="font-semibold text-[var(--red)]">{(breakerCfg.currentDrawdownPct * 100).toFixed(2)}%</span> of <span className="font-semibold">{(breakerCfg.maxDailyDrawdownPct * 100).toFixed(0)}%</span> · day-start ${fmt(breakerCfg.dayStartEquity)}.</>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={resetCircuitBreaker}
                  disabled={loading.cbReset || tokenMissing}
                  title={tokenMissing ? 'Set the operator token in Settings first' : 'Clear the breaker — re-arms day-start equity to current and resumes trading'}
                  className="ios-btn ios-btn-danger text-sm font-semibold px-5">
                  {loading.cbReset ? 'Resetting…' : '↻ Reset Breaker'}
                </button>
              </div>
            </div>
            {breakerCfg?.autoResetEnabled && breakerCfg?.autoResetActiveInMode && (
              <div className="mt-3 pt-3 border-t border-[var(--red)]/20 text-[11px] text-[var(--text-dim)]">
                ℹ Paper-mode auto-reset is enabled — the breaker will clear automatically at the next daily roll (~13:30 UTC). Toggle in Settings.
              </div>
            )}
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

            {/* Live market clocks. ASX panel renders only when master switch
                (ASX_ENABLED env) is on — otherwise solo full-width US clock. */}
            <MarketClocks asxEnabled={!!state?.asxEnabled} />

            {/* FX rate — only relevant for ASX risk sizing. Hide when ASX is off. */}
            {fx && state?.asxEnabled && <FxBadge fx={fx} />}

            {/* Pre-market briefings — separate cards per market. ASX runs at
                09:00 Sydney (1h before ASX open), US at 08:00 ET (90min
                before NYSE open). ASX card hidden when master switch is off. */}
            <PreMarketBriefing
              market="US"
              briefing={premarket?.us}
              onRefresh={() => refreshPremarket('US')}
              loading={loading.premarketUs}
            />
            {state?.asxEnabled && (
              <PreMarketBriefing
                market="ASX"
                briefing={premarket?.asx}
                onRefresh={() => refreshPremarket('ASX')}
                loading={loading.premarketAsx}
              />
            )}

            {/* Risk Scale — prominent user control */}
            <RiskScaleSelector
              scales={riskScales}
              current={riskScale?.current}
              loading={loading}
              onChange={setRiskScale}
            />

            {/* Day-trading recovery buffer — operator-tunable cooldown
                between same-symbol re-entries on the day strategy. */}
            <RecoveryBufferControl
              recoveryBuffer={state?.recoveryBuffer}
              onChange={setRecoveryBuffer}
              loading={loading.recoveryBuffer}
            />

            {/* Day-trading cycle cadence — operator-tunable interval between
                day-strategy ticks. Pacing only; quorum/confidence/dip-buy/
                recovery-buffer all unchanged. */}
            <DayCadenceControl
              dayCadence={state?.dayCadence}
              onChange={setDayCadence}
              loading={loading.dayCadence}
            />

            {/* Dynamic Sizing — compounding × confidence × performance */}
            <DynamicSizingPanel riskScale={riskScale} />

            {/* Intelligent Safety Suggestions — pending recommendations the
                user can apply or dismiss. Bounded; never auto-applied. */}
            <SafetySuggestionsPanel />

            {/* Automated Strategy Discovery — pending rule variations the
                backtest engine surfaced. Apply / Dismiss are operator-only;
                nothing is ever auto-applied. */}
            <StrategyProposalsPanel />

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
              <StatCard label="Confidence Gate" icon="🎯"
                value={`${Math.round((riskScale?.confidenceThreshold ?? 0.85) * 100)}%`}
                sub={`${riskScale?.label || 'Balanced'} · below this, no trade`} color="text-[var(--blue)]" />
              <StatCard label="Daily Risk Cap" icon="💵" value={`$${risk?.maxDailyLossUSD ?? 200}`}
                sub={`$${(state?.dailyLossUSD || 0).toFixed(2)} used today`} color="text-[var(--red)]" />
              <StatCard label="Mode" icon={mode === 'live' ? '🔴' : '🟡'}
                value={mode.toUpperCase()}
                color={mode === 'live' ? 'text-[var(--red)]' : 'text-[var(--yellow)]'}
                sub={mode === 'live' ? 'Real money on the line' : 'Simulated, your money is safe'} />
              <StatCard label="Status" icon="🤖"
                value={paused ? 'Paused' : isRunning ? ((usMarket.open || asxMarket.open) ? 'Trading' : 'Waiting') : 'Idle'}
                color={paused ? 'text-[var(--red)]' : isRunning ? ((usMarket.open || asxMarket.open) ? 'text-[var(--green)]' : 'text-[var(--yellow)]') : 'text-[var(--text-dim)]'}
                sub={
                  usMarket.open && asxMarket.open ? 'US + ASX open' :
                  usMarket.open ? 'US open' :
                  asxMarket.open ? 'ASX open' :
                  'Both markets closed'
                } />
            </div>

            {/* Live signals — filterable by market so day-traders watching US
                aren't distracted by ASX swing signals (and vice versa). */}
            {signals.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                  <h2 className="text-[15px] font-semibold tracking-tight">Live Signals</h2>
                  <div className="flex items-center gap-2 flex-wrap">
                    <MarketFilter value={signalsMarket} onChange={setSignalsMarket} counts={signalCounts} asxEnabled={!!state?.asxEnabled} />
                    <SectorFilter value={signalsSector} onChange={setSignalsSector} counts={signalsSectorCounts} />
                    <span className="text-[11px] text-[var(--text-dim)]">{filteredSignals.length} shown</span>
                  </div>
                </div>
                {filteredSignals.length === 0 ? (
                  <div className="glass p-4 text-center text-[12px] text-[var(--text-dim)]">No signals in {signalsMarket} yet.</div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    {filteredSignals.slice(0, 8).map(s => <SignalCard key={`${s.strategy || 'd'}-${s.symbol}`} signal={s} />)}
                  </div>
                )}
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

        {tab === 'markets' && (
          <ErrorBoundary>
            <MarketsTab fx={fx} sectorOf={sectorOf}
              focusSymbol={focusSymbol}
              onFocusConsumed={() => setFocusSymbol(null)} />
          </ErrorBoundary>
        )}

        {tab === 'companies' && (
          <ErrorBoundary>
            <CompaniesTab
              companies={companies}
              onJumpToMarkets={(sym) => { setFocusSymbol(sym); setTab('markets'); }}
              onJumpToBriefing={() => setTab('home')}
            />
          </ErrorBoundary>
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
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="text-3xl">🧠</div>
                  <div>
                    <h2 className="text-lg font-semibold tracking-tight">AI Reasoning</h2>
                    <div className="text-[12px] text-[var(--text-dim)]">Every decision Alpha makes streams here in real time. Each model votes independently — Alpha only acts when 3+ agree at the confidence threshold.</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <MarketFilter value={reasonMarket} onChange={setReasonMarket} counts={auditCounts} asxEnabled={!!state?.asxEnabled} />
                  <LiveBadge connected={connected} pulseAt={liveAuditAt} />
                </div>
              </div>
              <div className="text-[10px] text-[var(--text-dim)] mt-2">
                Showing {filteredAudit.length} of {audit.length} entries
                {reasonMarket !== 'ALL' && ' · platform-wide events (no symbol) are always visible'}
              </div>
            </div>
            <ReasoningFeed entries={filteredAudit} autoScroll />
          </div>
        )}

        {tab === 'positions' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-lg font-semibold tracking-tight">
                Open Positions <span className="text-[var(--text-dim)] text-sm font-normal">· {filteredHoldings.length} of {holdings.length}</span>
              </h2>
              <div className="flex items-center gap-2 flex-wrap">
                <MarketFilter value={posMarket} onChange={setPosMarket} counts={holdingCounts} asxEnabled={!!state?.asxEnabled} />
                <SectorFilter value={posSector} onChange={setPosSector} counts={posSectorCounts} />
              </div>
            </div>

            {/* Per-market subtotals — native + USD-equivalent. Keeps US and ASX
                P&L visually separated so AUD never gets added to USD. Only
                renders when ASX master switch is on (otherwise it's just a
                redundant "US (USD)" tile that duplicates the equity card). */}
            {state?.asxEnabled && (holdingCounts.US > 0 || holdingCounts.ASX > 0) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {['US', 'ASX'].map(m => {
                  const t = marketTotals[m];
                  if (!t.n) return null;
                  const csym = currencySymbolForMarket(m);
                  const usdMV = m === 'US' ? t.native : toUsd(t.native, m, fx);
                  const isPos = t.pnl >= 0;
                  return (
                    <div key={m} className={`glass p-4 ${m === posMarket || posMarket === 'ALL' ? '' : 'opacity-50'}`}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-[12px] font-semibold flex items-center gap-1.5">
                          <span aria-hidden>{m === 'ASX' ? '🇦🇺' : '🇺🇸'}</span>
                          {m === 'ASX' ? 'ASX (AUD)' : 'US (USD)'}
                          <span className="text-[var(--text-dim)] font-normal">· {t.n} pos</span>
                        </div>
                        <div className={`text-[12px] font-semibold ${isPos ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                          {isPos ? '+' : ''}{csym}{t.pnl.toFixed(2)}
                        </div>
                      </div>
                      <div className="flex items-baseline justify-between">
                        <div className="text-lg font-semibold">{csym}{t.native.toFixed(2)}</div>
                        {m === 'ASX' && (
                          <div className="text-[11px] text-[var(--text-dim)]">
                            ≈ {usdMV != null ? `$${usdMV.toFixed(2)} USD` : 'FX unavailable'}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {strategies.map(s => {
              const sh = filteredHoldings.filter(h => h.strategy === s.name);
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
            {!filteredHoldings.length && (
              <div className="glass p-6 text-center text-[var(--text-dim)] text-sm">
                {holdings.length === 0 ? 'No open positions.' : `No open positions in ${posMarket}.`}
              </div>
            )}
            {holdings.length > 0 && (
              <Tooltip text="Sell every open position immediately at market price (both markets)">
                <button onClick={flatten} disabled={loading.flatten} className="ios-btn ios-btn-danger w-full mt-2">
                  {loading.flatten ? 'Flattening…' : '🛑 Flatten All Positions'}
                </button>
              </Tooltip>
            )}
          </div>
        )}

        {tab === 'trades' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-lg font-semibold tracking-tight">
                Trade History <span className="text-[var(--text-dim)] text-sm font-normal">· {filteredTrades.length} of {trades.length}</span>
              </h2>
              <MarketFilter value={tradesMarket} onChange={setTradesMarket} counts={tradeCounts} asxEnabled={!!state?.asxEnabled} />
            </div>
            <TradeLog trades={filteredTrades} marketOf={marketOf} />
          </div>
        )}

        {tab === 'backtest' && (
          <ErrorBoundary>
            <BacktestPanel marketOf={marketOf} />
          </ErrorBoundary>
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
                  <button onClick={resetCircuitBreaker} disabled={loading.cbReset || tokenMissing} className="ios-btn ios-btn-danger col-span-2">↻ Reset Circuit Breaker</button>
                )}
              </div>
            </div>

            {/* Operator token */}
            <div className="glass p-5">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="font-semibold text-[14px]">Operator Token</div>
                  <div className="text-[11px] text-[var(--text-dim)]">
                    {authStatus?.tokenRequired
                      ? (authStatus?.authenticated
                          ? '✅ Token saved — control endpoints unlocked.'
                          : '⚠ Required by the server. Without it, every control button will return 401.')
                      : 'Server has no OPERATOR_TOKEN set — control endpoints are open. Set OPERATOR_TOKEN in Secrets to require authentication.'}
                  </div>
                </div>
                <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${
                  !authStatus?.tokenRequired ? 'bg-white/10 text-[var(--text-dim)]'
                  : authStatus?.authenticated ? 'bg-[var(--green)]/15 text-[var(--green)]'
                                              : 'bg-[var(--red)]/15 text-[var(--red)]'
                }`}>
                  {!authStatus?.tokenRequired ? 'OPEN' : authStatus?.authenticated ? 'AUTHED' : 'BLOCKED'}
                </span>
              </div>
              {authStatus?.tokenRequired && (
                <div className="flex items-center gap-2 mt-3">
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={e => setTokenInput(e.target.value)}
                    placeholder="Paste OPERATOR_TOKEN value"
                    className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-[13px] font-mono outline-none focus:border-[var(--blue)]/50"
                  />
                  <button onClick={saveOperatorToken} className="ios-btn ios-btn-primary text-xs whitespace-nowrap">
                    {tokenSaved ? '✓ Saved' : 'Save'}
                  </button>
                </div>
              )}
              <div className="text-[10px] text-[var(--text-dim)] mt-2">
                Stored locally in your browser only. Sent as <span className="font-mono">x-operator-token</span> header on every protected request.
              </div>
            </div>

            {/* Circuit Breaker config */}
            <div className="glass p-5 space-y-3">
              <div>
                <div className="font-semibold text-[14px] mb-1">Circuit Breaker</div>
                <div className="text-[11px] text-[var(--text-dim)]">Drawdown threshold + auto-reset behaviour. Core trip logic is unchanged — this only configures how it recovers.</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-white/3 rounded-xl p-3">
                  <div className="text-[10px] text-[var(--text-dim)] uppercase">Drawdown threshold</div>
                  <div className="text-lg font-semibold">{breakerCfg ? `${(breakerCfg.maxDailyDrawdownPct * 100).toFixed(2)}%` : '—'}</div>
                  <div className="text-[10px] text-[var(--text-dim)] mt-1">via <span className="font-mono">MAX_DAILY_DRAWDOWN_PCT</span> secret · default 5%</div>
                </div>
                <div className="bg-white/3 rounded-xl p-3">
                  <div className="text-[10px] text-[var(--text-dim)] uppercase">Daily $ loss budget</div>
                  <div className="text-lg font-semibold">{breakerCfg ? `$${fmt(breakerCfg.maxDailyLossUSD)}` : '—'}</div>
                  <div className="text-[10px] text-[var(--text-dim)] mt-1">{breakerCfg?.envCapUSD ? <>capped by <span className="font-mono">MAX_DAILY_LOSS_USD</span></> : 'from active risk scale'}</div>
                </div>
                <div className="bg-white/3 rounded-xl p-3">
                  <div className="text-[10px] text-[var(--text-dim)] uppercase">Current drawdown</div>
                  <div className={`text-lg font-semibold ${breakerCfg && breakerCfg.currentDrawdownPct >= breakerCfg.maxDailyDrawdownPct * 0.5 ? 'text-[var(--yellow)]' : ''}`}>
                    {breakerCfg ? `${(breakerCfg.currentDrawdownPct * 100).toFixed(2)}%` : '—'}
                  </div>
                  <div className="text-[10px] text-[var(--text-dim)] mt-1">{breakerCfg ? `loss $${fmt(breakerCfg.currentLossUSD)}` : ''}</div>
                </div>
                <div className="bg-white/3 rounded-xl p-3">
                  <div className="text-[10px] text-[var(--text-dim)] uppercase">Day-start equity</div>
                  <div className="text-lg font-semibold">{breakerCfg ? `$${fmt(breakerCfg.dayStartEquity)}` : '—'}</div>
                  <div className="text-[10px] text-[var(--text-dim)] mt-1">anchor for the daily PnL math</div>
                </div>
              </div>
              <div className="flex items-center justify-between bg-white/3 rounded-xl p-3 mt-1">
                <div>
                  <div className="text-[13px] font-semibold">Auto-reset at daily roll</div>
                  <div className="text-[10px] text-[var(--text-dim)]">
                    {mode === 'paper'
                      ? 'When ON, a tripped breaker clears automatically at the next 13:30 UTC roll. Paper mode only.'
                      : 'Disabled in LIVE mode — operator must reset explicitly.'}
                  </div>
                </div>
                <button
                  disabled={loading.cbAuto || mode !== 'paper' || tokenMissing}
                  onClick={() => setBreakerToggleConfirm({ nextEnabled: !breakerCfg?.autoResetEnabled })}
                  className={`text-[10px] font-bold px-3 py-1.5 rounded-full transition-colors ${
                    breakerCfg?.autoResetEnabled && mode === 'paper'
                      ? 'bg-[var(--green)]/15 text-[var(--green)] hover:bg-[var(--green)]/25'
                      : 'bg-white/10 text-[var(--text-dim)] hover:bg-white/15'
                  } ${(mode !== 'paper' || tokenMissing) ? 'opacity-50 cursor-not-allowed' : ''}`}>
                  {loading.cbAuto ? '…' : (breakerCfg?.autoResetEnabled ? 'ON' : 'OFF')}
                </button>
              </div>
              <button onClick={resetCircuitBreaker} disabled={!cbTripped || loading.cbReset || tokenMissing}
                className={`ios-btn w-full ${cbTripped ? 'ios-btn-danger' : 'ios-btn-ghost'}`}>
                {loading.cbReset ? 'Resetting…' : (cbTripped ? '↻ Reset Breaker Now' : 'Breaker not tripped')}
              </button>
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
              t.id === 'markets' ? 'Live charts, AI signals, news sentiment per stock' :
              t.id === 'companies' ? 'Browse every stock by sector with description + fundamentals' :
              t.id === 'strategies' ? 'Toggle day & swing strategies' :
              t.id === 'reason' ? "See Alpha's reasoning live" :
              t.id === 'positions' ? 'Your open positions' :
              t.id === 'trades' ? 'Trade history' :
              t.id === 'backtest' ? 'Backtest strategies on historical data' :
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

      {/* Breaker auto-reset confirm modal */}
      {breakerToggleConfirm && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 anim-fade">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={() => setBreakerToggleConfirm(null)} />
          <div className="relative glass-strong w-full max-w-md p-6 anim-slide-up">
            <div className="text-3xl mb-2">{breakerToggleConfirm.nextEnabled ? '🔁' : '⏸'}</div>
            <h3 className="text-xl font-semibold tracking-tight mb-2">
              {breakerToggleConfirm.nextEnabled ? 'Enable daily auto-reset?' : 'Disable daily auto-reset?'}
            </h3>
            <div className="text-[13px] text-[var(--text-dim)] space-y-2">
              {breakerToggleConfirm.nextEnabled ? (
                <>
                  <p>If the breaker trips during a paper-trading session, it will be cleared automatically at the next daily roll (~13:30 UTC) so testing resumes the next day.</p>
                  <p className="text-[var(--yellow)]">This setting is ignored in LIVE mode — live operators must always reset manually.</p>
                </>
              ) : (
                <p>The breaker will stay tripped across the daily roll until you explicitly reset it. Recommended for stricter testing.</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-5">
              <button onClick={() => setBreakerToggleConfirm(null)} disabled={loading.cbAuto} className="ios-btn ios-btn-ghost">Cancel</button>
              <button
                onClick={async () => {
                  await setBreakerAutoReset(breakerToggleConfirm.nextEnabled);
                  setBreakerToggleConfirm(null);
                }}
                disabled={loading.cbAuto}
                className={`ios-btn ${breakerToggleConfirm.nextEnabled ? 'ios-btn-success' : 'ios-btn-danger'}`}>
                {loading.cbAuto ? '…' : (breakerToggleConfirm.nextEnabled ? 'Enable' : 'Disable')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mode-switch confirmation modal */}
      {modeModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 anim-fade">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={closeModeModal} />
          <div className="relative glass-strong w-full max-w-md p-6 anim-slide-up">
            <div className="text-3xl mb-2">{modeModal === 'live' ? '🔴' : '🟡'}</div>
            <h3 className="text-xl font-semibold tracking-tight mb-2">
              Switch to {modeModal === 'live' ? 'LIVE Trading' : 'Paper Trading'}?
            </h3>
            {modeModal === 'live' ? (
              <div className="text-[13px] text-[var(--text-dim)] space-y-2">
                <p><strong className="text-[var(--red)]">This uses REAL money.</strong> Every trade executes on your live Alpaca brokerage account immediately and losses are permanent.</p>
                <p>All safety gates stay active — 85% confidence, 3-of-4 model quorum, $100/day loss budget, circuit breaker, dynamic sizing, force-flatten before close — but actual losses will be real.</p>
                <div className={`mt-2 rounded-xl p-2.5 text-[12px] ${liveAvailable ? 'bg-[var(--green)]/10 text-[var(--green)]' : 'bg-[var(--red)]/10 text-[var(--red)]'}`}>
                  {liveAvailable
                    ? '✓ Live API keys detected on the server.'
                    : '✗ Live API keys NOT detected. Add ALPACA_LIVE_API_KEY and ALPACA_LIVE_SECRET_KEY in Secrets first.'}
                </div>
                <p className="text-[var(--yellow)] pt-1">To confirm, type <span className="font-mono font-bold text-white">LIVE</span> below.</p>
                <input
                  type="text"
                  autoFocus
                  value={modeConfirmText}
                  onChange={e => setModeConfirmText(e.target.value)}
                  placeholder="Type LIVE to confirm"
                  className="w-full mt-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--red)]/50"
                />
              </div>
            ) : (
              <div className="text-[13px] text-[var(--text-dim)]">
                Switching back to paper mode. All future trades will be simulated through your Alpaca paper account. Any open live positions stay on the broker — they will not be touched by this switch.
              </div>
            )}
            {modeError && (
              <div className="mt-3 text-[12px] text-[var(--red)] bg-[var(--red)]/10 rounded-xl p-3">
                {modeError}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 mt-5">
              <button onClick={closeModeModal} disabled={loading.mode} className="ios-btn ios-btn-ghost">
                Cancel
              </button>
              <button
                onClick={handleModeSwitch}
                disabled={loading.mode || (modeModal === 'live' && (!liveConfirmOk || !liveAvailable))}
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

function DynamicSizingPanel({ riskScale }) {
  if (!riskScale?.dynamic) return null;
  const { dynamic, effectiveBand, minRiskUSD, maxRiskUSD, label } = riskScale;
  const growthPct = ((dynamic.growthMult - 1) * 100);
  const perfPct = ((dynamic.perfMult - 1) * 100);
  const compoundPct = ((dynamic.compoundMult - 1) * 100);
  const growthColor = growthPct >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]';
  const perfColor = perfPct >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]';
  const compoundColor = compoundPct >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]';
  const equityChangePct = (dynamic.growthRatio * 100);
  return (
    <Tooltip text="Position size auto-scales with account growth, recent performance, and per-signal confidence. Quorum, circuit breaker, and daily loss cap are unchanged.">
      <section className="glass p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-dim)]">Dynamic Sizing · {label}</div>
            <div className="text-[10px] text-[var(--text-dim)] mt-0.5">
              Compounding · Confidence-Weighted · Performance-Curved
            </div>
          </div>
          <div className="text-right">
            <div className={`text-[11px] font-bold ${compoundColor}`}>
              {compoundPct >= 0 ? '+' : ''}{compoundPct.toFixed(1)}%
            </div>
            <div className="text-[9px] text-[var(--text-dim)]">vs base sizing</div>
          </div>
        </div>

        {/* Effective risk band (after growth × performance multipliers) */}
        <div className="bg-white/3 rounded-xl p-3 mb-3">
          <div className="flex items-center justify-between text-[10px] text-[var(--text-dim)] uppercase tracking-wider">
            <span>Effective $ risk per trade</span>
            <span>Base ${minRiskUSD}–${maxRiskUSD}</span>
          </div>
          <div className="text-base font-semibold mt-1">
            ${effectiveBand?.minRiskUSD?.toFixed(0) ?? minRiskUSD}
            <span className="text-[var(--text-dim)] mx-1">–</span>
            ${effectiveBand?.maxRiskUSD?.toFixed(0) ?? maxRiskUSD}
            <span className="text-[10px] text-[var(--text-dim)] ml-2 font-normal">
              · ceiling ${effectiveBand?.ceilingUSD?.toFixed(0)}
            </span>
          </div>
          <div className="text-[10px] text-[var(--text-dim)] mt-1">
            Higher-confidence signals trade nearer the top of this band; lower-confidence near the bottom.
          </div>
        </div>

        {/* Three multipliers */}
        <div className="grid grid-cols-3 gap-2">
          <MultBadge
            icon="📈" label="Growth"
            value={`×${dynamic.growthMult.toFixed(2)}`}
            sub={`${equityChangePct >= 0 ? '+' : ''}${equityChangePct.toFixed(1)}% equity · ${dynamic.growthSteps} step${Math.abs(dynamic.growthSteps) === 1 ? '' : 's'}`}
            color={growthColor}
          />
          <MultBadge
            icon="🎯" label="Confidence"
            value="band"
            sub={`Lerp ${(riskScale.confidenceThreshold*100).toFixed(0)}–100% conf → min–max risk`}
            color="text-[var(--blue)]"
          />
          <MultBadge
            icon="🔥" label="Performance"
            value={`×${dynamic.perfMult.toFixed(2)}`}
            sub={`${dynamic.perfNetPnL >= 0 ? '+' : ''}$${dynamic.perfNetPnL.toFixed(0)} · last ${dynamic.perfTradesUsed} trade${dynamic.perfTradesUsed === 1 ? '' : 's'}`}
            color={perfColor}
          />
        </div>
      </section>
    </Tooltip>
  );
}

function MultBadge({ icon, label, value, sub, color }) {
  return (
    <div className="bg-white/3 rounded-xl p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-dim)] uppercase tracking-wider">
        <span>{icon}</span><span>{label}</span>
      </div>
      <div className={`text-[13px] font-semibold mt-0.5 ${color}`}>{value}</div>
      <div className="text-[9px] text-[var(--text-dim)] leading-tight mt-0.5">{sub}</div>
    </div>
  );
}

function RiskScaleSelector({ scales, current, loading, onChange }) {
  if (!scales?.length) return null;
  const ACCENT = {
    conservative: { ring: 'border-[var(--green)]/60', glow: 'from-[var(--green)]/20', text: 'text-[var(--green)]' },
    balanced:     { ring: 'border-[var(--blue)]/60',  glow: 'from-[var(--blue)]/20',  text: 'text-[var(--blue)]' },
    aggressive:   { ring: 'border-[var(--red)]/60',   glow: 'from-[var(--red)]/20',   text: 'text-[var(--red)]' },
  };
  return (
    <section>
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-dim)]">Risk Scale</div>
        <div className="text-[10px] text-[var(--text-dim)]">Quorum 3-of-4 stays locked · CB always armed</div>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {scales.map(s => {
          const active = current === s.name;
          const a = ACCENT[s.name] || ACCENT.balanced;
          const isLoading = loading[`risk:${s.name}`];
          return (
            <Tooltip key={s.name} text={s.description}>
              <button onClick={() => !active && onChange(s.name)} disabled={isLoading}
                className={`w-full glass p-3 sm:p-4 text-left transition-all relative overflow-hidden ${
                  active ? `border ${a.ring} bg-gradient-to-br ${a.glow} to-transparent` : 'border border-white/5 hover:border-white/15 opacity-80 hover:opacity-100'
                }`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-base sm:text-lg">{s.emoji}</span>
                  {active && <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-white/10 ${a.text}`}>ACTIVE</span>}
                  {isLoading && <span className="text-[9px] text-[var(--text-dim)]">…</span>}
                </div>
                <div className={`text-[12px] sm:text-[13px] font-semibold ${active ? a.text : ''}`}>{s.label}</div>
                <div className="text-[9px] sm:text-[10px] text-[var(--text-dim)] mt-1 leading-tight">
                  {Math.round(s.confidenceThreshold * 100)}% gate · ${s.minRiskUSD}–${s.maxRiskUSD} · ${s.maxDailyLossUSD}/day cap
                </div>
              </button>
            </Tooltip>
          );
        })}
      </div>
    </section>
  );
}

// Day-trading recovery buffer control. Numeric input + Apply button. Bounds
// come from /api/state (recoveryBuffer.{min,max,default}). The component
// stays in sync with the live setting whenever the dashboard re-renders so
// an external change (e.g. another operator) is reflected here too. The
// Apply button only enables when the local draft differs from the live
// value AND falls within bounds — guards against accidental no-op writes
// and out-of-range submits before the backend even sees them.
function RecoveryBufferControl({ recoveryBuffer, onChange, loading }) {
  const live = Number.isFinite(parseInt(recoveryBuffer?.seconds))
    ? parseInt(recoveryBuffer.seconds)
    : (recoveryBuffer?.default ?? 75);
  const min  = recoveryBuffer?.min ?? 0;
  const max  = recoveryBuffer?.max ?? 3600;
  const def  = recoveryBuffer?.default ?? 75;
  const [draft, setDraft] = useState(String(live));
  const [err, setErr] = useState('');
  // Re-sync whenever the live value changes (and we're not actively editing
  // a different value the user already typed).
  useEffect(() => { setDraft(String(live)); }, [live]);
  const n = parseInt(draft, 10);
  const valid = Number.isFinite(n) && n >= min && n <= max;
  const dirty = valid && n !== live;
  const apply = async () => {
    setErr('');
    if (!valid) { setErr(`Must be ${min}–${max}`); return; }
    const r = await onChange(n);
    if (!r?.success) setErr(r?.error || 'Failed');
  };
  return (
    <section>
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-dim)]">
          Day-Trading Recovery Buffer
        </div>
        <div className="text-[10px] text-[var(--text-dim)]">
          Day strategy only · {min}–{max}s · default {def}s
        </div>
      </div>
      <div className="glass p-3 sm:p-4 border border-white/5 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[160px]">
          <div className="text-[10px] text-[var(--text-dim)] mb-1">
            Min seconds between same-symbol re-entries after a close. Live: <span className="text-[var(--text)] font-semibold">{live}s</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number" min={min} max={max} step={5} value={draft}
              onChange={e => setDraft(e.target.value)}
              disabled={loading}
              className="w-24 bg-black/30 border border-white/10 rounded px-2 py-1 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--blue)]/60"
            />
            <span className="text-[11px] text-[var(--text-dim)]">seconds</span>
            <button
              onClick={apply}
              disabled={!dirty || loading}
              className={`text-[11px] font-semibold px-3 py-1 rounded transition-colors ${
                dirty && !loading
                  ? 'bg-[var(--blue)]/20 text-[var(--blue)] border border-[var(--blue)]/40 hover:bg-[var(--blue)]/30'
                  : 'bg-white/5 text-[var(--text-dim)] border border-white/10 cursor-not-allowed'
              }`}
            >{loading ? '…' : 'Apply'}</button>
            {live !== def && (
              <button
                onClick={() => { setDraft(String(def)); }}
                disabled={loading}
                className="text-[10px] text-[var(--text-dim)] hover:text-[var(--text)] underline"
              >reset to {def}s</button>
            )}
          </div>
          {err && <div className="text-[10px] text-[var(--red)] mt-1">{err}</div>}
        </div>
      </div>
    </section>
  );
}

// Day-trading cycle cadence control. Mirrors RecoveryBufferControl —
// bounds + presets come from /api/state (`dayCadence.{min,max,default,presets}`)
// so the UI can never submit an out-of-range value the backend would reject.
// Preset chips give one-click access to the requested cadences (15/20/30/60/
// 90/120s); the numeric input still allows any value in [min, max] for
// fine-tuning. Apply enables only when the draft differs from live AND is
// in-range, preventing accidental no-op writes.
function DayCadenceControl({ dayCadence, onChange, loading }) {
  const live = Number.isFinite(parseInt(dayCadence?.seconds))
    ? parseInt(dayCadence.seconds)
    : (dayCadence?.default ?? 60);
  const min  = dayCadence?.min ?? 5;
  const max  = dayCadence?.max ?? 600;
  const def  = dayCadence?.default ?? 60;
  const presets = Array.isArray(dayCadence?.presets) && dayCadence.presets.length
    ? dayCadence.presets
    : [15, 20, 30, 60, 90, 120];
  const [draft, setDraft] = useState(String(live));
  const [err, setErr] = useState('');
  useEffect(() => { setDraft(String(live)); }, [live]);
  const n = parseInt(draft, 10);
  const valid = Number.isFinite(n) && n >= min && n <= max;
  const dirty = valid && n !== live;
  const apply = async (override) => {
    setErr('');
    const target = Number.isFinite(override) ? override : n;
    if (!Number.isFinite(target) || target < min || target > max) { setErr(`Must be ${min}–${max}`); return; }
    if (target === live) return;
    const r = await onChange(target);
    if (!r?.success) setErr(r?.error || 'Failed');
  };
  return (
    <section>
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-dim)]">
          Day-Trading Cycle Cadence
        </div>
        <div className="text-[10px] text-[var(--text-dim)]">
          Day strategy only · {min}–{max}s · default {def}s
        </div>
      </div>
      <div className="glass p-3 sm:p-4 border border-white/5">
        <div className="text-[10px] text-[var(--text-dim)] mb-2">
          How often the day strategy ticks (faster = more chances per minute, but
          more API calls). Live: <span className="text-[var(--text)] font-semibold">{live}s</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap mb-2">
          {presets.map(p => {
            const active = p === live;
            return (
              <button
                key={p}
                onClick={() => apply(p)}
                disabled={loading || active}
                className={`text-[11px] font-semibold px-2.5 py-1 rounded-xl border transition-colors ${
                  active
                    ? 'bg-[var(--blue)]/25 border-[var(--blue)]/50 text-[var(--blue)] cursor-default'
                    : 'bg-white/5 border-white/10 text-[var(--text-dim)] hover:text-white hover:border-white/30'
                }`}
              >{p}s</button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="number" min={min} max={max} step={5} value={draft}
            onChange={e => setDraft(e.target.value)}
            disabled={loading}
            className="w-24 bg-black/30 border border-white/10 rounded px-2 py-1 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--blue)]/60"
          />
          <span className="text-[11px] text-[var(--text-dim)]">seconds</span>
          <button
            onClick={() => apply()}
            disabled={!dirty || loading}
            className={`text-[11px] font-semibold px-3 py-1 rounded transition-colors ${
              dirty && !loading
                ? 'bg-[var(--blue)]/20 text-[var(--blue)] border border-[var(--blue)]/40 hover:bg-[var(--blue)]/30'
                : 'bg-white/5 text-[var(--text-dim)] border border-white/10 cursor-not-allowed'
            }`}
          >{loading ? '…' : 'Apply'}</button>
          {live !== def && (
            <button
              onClick={() => apply(def)}
              disabled={loading}
              className="text-[10px] text-[var(--text-dim)] hover:text-[var(--text)] underline"
            >reset to {def}s</button>
          )}
        </div>
        {err && <div className="text-[10px] text-[var(--red)] mt-1">{err}</div>}
      </div>
    </section>
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
