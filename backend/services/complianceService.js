// Compliance / regulatory-style audit reporting.
// Pulls a single trading day from the trades + audit_log tables and produces
// a structured report suitable for compliance review or external archival.
// JSON or CSV. No new external API calls; pure DB read.
//
// Shape (JSON):
//   { date, generated_at, mode, risk_scale,
//     summary: { trades, buys, sells, fills, flattens, blocked, kill_switches,
//                circuit_breakers, emergency_pauses, gross_pnl, net_pnl,
//                models_consulted, asset_classes },
//     trades:        [{ ts, symbol, side, qty, price, pnl, strategy, asset_class,
//                       confidence, consensus, status, reason, signal_models,
//                       order_id, audit_chain_verified }],
//     risk_events:   [{ ts, event_type, symbol, payload }],
//     blocked_trades:[{ ts, symbol, decision, confidence, payload }],
//     hash_chain:    { ok, total, verified, legacy, brokenAt[] } }
//
// CSV: a flat trades-only sheet with the most regulator-relevant columns.

const db = require('./db');

// Names must match the actual event_type strings emitted by agent.js /
// riskManager / hedgingService — verified against `rg event_type` at
// authoring time. Kept as an explicit allowlist (not a prefix match) so
// new event types are deliberately classified, not silently absorbed.
const RISK_EVENTS = new Set([
  'CIRCUIT_BREAKER', 'CIRCUIT_BREAKER_TRIPPED', 'CIRCUIT_BREAKER_RESET',
  'EMERGENCY_PAUSE', 'EMERGENCY_RESUME',
  'KILL_SWITCH_START', 'KILL_SWITCH_COMPLETE',
  'KILL_SWITCH_BLOCKED_ORDER', 'KILL_SWITCH_CANCEL_FAIL', 'KILL_SWITCH_DRAIN_TIMEOUT',
  'FORCE_FLATTEN_START', 'FORCE_FLATTEN', 'FORCE_FLATTEN_BROKER_FAIL',
  'CANCEL_ALL_ORDERS',
  'HEDGE_SIGNAL', 'HEDGE_EXECUTED', 'HEDGE_ERROR',
  'TRADING_MODE_CHANGED', 'RISK_SCALE_CHANGED', 'STRATEGY_TOGGLE',
  'AGENT_STARTED', 'AGENT_STOPPED', 'DAILY_RESET',
]);
const BLOCKED_EVENTS = new Set(['QUORUM_REJECTED', 'GATE_REJECTED', 'TRADE_BLOCKED']);

function dayBounds(dateStr) {
  // Treat date as a UTC calendar day. Caller passes YYYY-MM-DD.
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${dateStr}`);
  const start = new Date(d); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(d); end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

async function buildReport(dateStr) {
  const { start, end } = dayBounds(dateStr);
  const portfolio = await db.getPortfolio();
  const tradesQ = await db.query(
    `SELECT * FROM trades WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at ASC`,
    [start, end]
  );
  const auditQ = await db.query(
    `SELECT * FROM audit_log WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at ASC`,
    [start, end]
  );
  const trades = tradesQ.rows;
  const audit = auditQ.rows;

  // Index SIGNAL events by symbol+nearest-time so we can attach the model
  // ensemble that decided each trade. Pair each trade with the most recent
  // SIGNAL for that symbol within the previous 5 minutes.
  const signalsBySymbol = new Map();
  for (const r of audit) {
    if (r.event_type !== 'SIGNAL') continue;
    const key = r.symbol || '';
    if (!signalsBySymbol.has(key)) signalsBySymbol.set(key, []);
    signalsBySymbol.get(key).push(r);
  }
  // Two-pass match: prefer a SIGNAL whose payload.strategy matches the
  // trade's strategy (avoids cross-attribution when day + swing both fire on
  // the same symbol within the 5-min window). Fall back to any-strategy
  // match only if no strategy-aligned signal exists, which preserves
  // backward compatibility for legacy SIGNAL rows that lacked a strategy
  // tag.
  function attachSignal(trade) {
    const list = signalsBySymbol.get(trade.symbol) || [];
    const t = new Date(trade.created_at).getTime();
    let bestStrict = null, bestLoose = null;
    for (const s of list) {
      const st = new Date(s.created_at).getTime();
      if (st > t || t - st > 5 * 60 * 1000) continue;
      const sigStrategy = s.payload?.strategy;
      if (trade.strategy && sigStrategy && sigStrategy === trade.strategy) {
        if (!bestStrict || st > new Date(bestStrict.created_at).getTime()) bestStrict = s;
      }
      if (!bestLoose || st > new Date(bestLoose.created_at).getTime()) bestLoose = s;
    }
    return bestStrict || bestLoose;
  }

  const enrichedTrades = trades.map(t => {
    const sig = attachSignal(t);
    return {
      ts: t.created_at,
      symbol: t.symbol,
      side: t.side,
      qty: +t.qty,
      price: +t.price,
      pnl: t.pnl != null ? +t.pnl : null,
      strategy: t.strategy,
      asset_class: t.asset_class || 'equity',
      confidence: t.confidence != null ? +t.confidence : null,
      consensus: t.consensus,
      status: t.status,
      reason: t.reason,
      order_id: t.order_id,
      signal_models: sig?.models || null,
      signal_audit_id: sig?.id || null,
    };
  });

  const riskEvents = audit
    .filter(r => RISK_EVENTS.has(r.event_type))
    .map(r => ({ ts: r.created_at, id: r.id, event_type: r.event_type, symbol: r.symbol, payload: r.payload }));
  const blockedTrades = audit
    .filter(r => BLOCKED_EVENTS.has(r.event_type))
    .map(r => ({ ts: r.created_at, id: r.id, symbol: r.symbol, decision: r.decision, confidence: r.confidence, payload: r.payload }));

  const buys = enrichedTrades.filter(t => t.side === 'BUY').length;
  const sells = enrichedTrades.filter(t => t.side === 'SELL').length;
  const fills = enrichedTrades.filter(t => /fill|complete|flatten/i.test(t.status || '')).length;
  const flattens = enrichedTrades.filter(t => t.status === 'flattened').length;
  const grossPnl = enrichedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const modelsSet = new Set();
  enrichedTrades.forEach(t => (t.signal_models || []).forEach(m => modelsSet.add(m.id || m.model_id || m.name || m)));
  const assetClasses = [...new Set(enrichedTrades.map(t => t.asset_class))];

  const chain = await db.verifyAuditChain({ since: start });

  return {
    date: dateStr,
    generated_at: new Date().toISOString(),
    mode: portfolio?.trading_mode || 'paper',
    risk_scale: portfolio?.risk_scale || 'balanced',
    summary: {
      trades: enrichedTrades.length,
      buys, sells, fills, flattens,
      blocked: blockedTrades.length,
      kill_switches: riskEvents.filter(r => r.event_type.startsWith('KILL_SWITCH')).length,
      circuit_breakers: riskEvents.filter(r => r.event_type.startsWith('CIRCUIT_BREAKER')).length,
      emergency_pauses: riskEvents.filter(r => r.event_type === 'EMERGENCY_PAUSE').length,
      hedge_signals: riskEvents.filter(r => r.event_type === 'HEDGE_SIGNAL').length,
      hedge_executed: riskEvents.filter(r => r.event_type === 'HEDGE_EXECUTED').length,
      hedge_errors: riskEvents.filter(r => r.event_type === 'HEDGE_ERROR').length,
      gross_pnl: +grossPnl.toFixed(2),
      models_consulted: [...modelsSet],
      asset_classes: assetClasses,
    },
    trades: enrichedTrades,
    risk_events: riskEvents,
    blocked_trades: blockedTrades,
    hash_chain: chain,
  };
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function reportToCSV(report) {
  const cols = [
    'timestamp', 'symbol', 'asset_class', 'side', 'qty', 'price',
    'pnl', 'strategy', 'consensus', 'confidence', 'status', 'reason',
    'order_id', 'signal_models', 'signal_audit_id',
    'mode', 'risk_scale',
  ];
  const head = cols.join(',');
  const rows = (report.trades || []).map(t => [
    new Date(t.ts).toISOString(), t.symbol, t.asset_class, t.side, t.qty, t.price,
    t.pnl, t.strategy, t.consensus, t.confidence, t.status, t.reason,
    t.order_id,
    Array.isArray(t.signal_models) ? t.signal_models.map(m => m.id || m.name || m).join('|') : '',
    t.signal_audit_id, report.mode, report.risk_scale,
  ].map(csvEscape).join(','));
  // Footer summary as comments — most spreadsheet apps ignore lines starting with #
  const summary = report.summary || {};
  const footer = [
    `# date,${report.date}`,
    `# generated_at,${report.generated_at}`,
    `# mode,${report.mode},risk_scale,${report.risk_scale}`,
    `# trades,${summary.trades},buys,${summary.buys},sells,${summary.sells},fills,${summary.fills},flattens,${summary.flattens}`,
    `# blocked,${summary.blocked},kill_switches,${summary.kill_switches},circuit_breakers,${summary.circuit_breakers},emergency_pauses,${summary.emergency_pauses}`,
    `# hedge_signals,${summary.hedge_signals},hedge_executed,${summary.hedge_executed},hedge_errors,${summary.hedge_errors}`,
    `# gross_pnl,${summary.gross_pnl}`,
    `# hash_chain_ok,${report.hash_chain?.ok},verified,${report.hash_chain?.verified},legacy,${report.hash_chain?.legacy},broken,${report.hash_chain?.brokenAt?.length || 0}`,
  ].join('\n');
  return [head, ...rows, '', footer].join('\n');
}

module.exports = { buildReport, reportToCSV };
