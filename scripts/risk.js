#!/usr/bin/env node
/**
 * AlphaTrade risk-scale CLI — for pre-market sanity checks.
 *
 * Usage:
 *   node scripts/risk.js test conservative   # switch + print + verify
 *   node scripts/risk.js test balanced
 *   node scripts/risk.js test aggressive
 *   node scripts/risk.js status              # show live multipliers + band
 *
 * Reads OPERATOR_TOKEN from env if set; talks to API_URL (default http://localhost:3001).
 */

const API_URL = process.env.API_URL || 'http://localhost:3001';
const TOKEN = process.env.OPERATOR_TOKEN || '';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', blue: '\x1b[34m',
};
const c = (col, s) => `${C[col]}${s}${C.reset}`;

const SCALE_COLORS = { conservative: 'cyan', balanced: 'yellow', aggressive: 'red' };
const SCALE_EMOJI  = { conservative: '🛡️ ', balanced: '⚖️ ', aggressive: '🔥' };

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['x-operator-token'] = TOKEN;
  const res = await fetch(`${API_URL}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data : data.error || text}`);
  return data;
}

function printScaleSettings(scale, label) {
  const col = SCALE_COLORS[scale.current || scale.name] || 'cyan';
  const emoji = SCALE_EMOJI[scale.current || scale.name] || '•';
  console.log();
  console.log(c(col, c('bold', `${emoji} ${label || scale.label}`)));
  console.log(c('dim', '  ' + (scale.description || scale.short || '')));
  console.log();
  console.log(c('bold', '  EXACT SETTINGS THAT WILL BE USED:'));
  console.log(`    ${c('dim', 'Confidence gate     ')}  ${c(col, (scale.confidenceThreshold * 100).toFixed(0) + '%')}  ${c('dim', '(min avg confidence across 4 models)')}`);
  console.log(`    ${c('dim', 'Quorum requirement  ')}  ${c(col, '3-of-4')}  ${c('dim', 'models must agree on direction (hard floor)')}`);
  console.log(`    ${c('dim', 'Risk per trade band ')}  ${c(col, '$' + scale.minRiskUSD + ' – $' + scale.maxRiskUSD)}  ${c('dim', '(low → high confidence)')}`);
  console.log(`    ${c('dim', 'Stop multiplier     ')}  ${c(col, '×' + scale.stopMultiplier)}  ${c('dim', '(applied to base strategy stop %)')}`);
  console.log(`    ${c('dim', 'Target multiplier   ')}  ${c(col, '×' + scale.targetMultiplier)}  ${c('dim', '(applied to base strategy take-profit %)')}`);
  console.log(`    ${c('dim', 'Daily loss cap      ')}  ${c(col, '$' + scale.maxDailyLossUSD)}  ${c('dim', '→ trips circuit breaker, auto-flatten')}`);
  console.log(`    ${c('dim', 'Hard ceiling        ')}  ${c(col, '$' + (scale.maxRiskUSD * 2))}  ${c('dim', '(2× max risk — never exceeded by dynamic sizing)')}`);
}

function printDynamic(scale) {
  if (!scale.dynamic) return;
  const d = scale.dynamic;
  const eb = scale.effectiveBand || {};
  const fmtMult = (m) => {
    const pct = ((m - 1) * 100);
    const col = pct > 0 ? 'green' : pct < 0 ? 'red' : 'dim';
    return c(col, `×${m.toFixed(2)}`) + ' ' + c('dim', `(${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
  };
  console.log();
  console.log(c('bold', '  LIVE DYNAMIC MULTIPLIERS:'));
  console.log(`    ${c('dim', 'Growth     ')}  ${fmtMult(d.growthMult)}   ${c('dim', `equity ${d.growthRatio >= 0 ? '+' : ''}${(d.growthRatio*100).toFixed(1)}% · ${d.growthSteps} step(s)`)}`);
  console.log(`    ${c('dim', 'Performance')}  ${fmtMult(d.perfMult)}   ${c('dim', `${d.perfNetPnL >= 0 ? '+' : ''}$${d.perfNetPnL.toFixed(0)} net · last ${d.perfTradesUsed} closed trade(s)`)}`);
  console.log(`    ${c('dim', 'Compound   ')}  ${fmtMult(d.compoundMult)}   ${c('dim', '(growth × performance)')}`);
  console.log();
  console.log(c('bold', '  EFFECTIVE $ RISK BAND:'));
  console.log(`    ${c('green', '$' + (eb.minRiskUSD ?? scale.minRiskUSD).toFixed(0))} – ${c('green', '$' + (eb.maxRiskUSD ?? scale.maxRiskUSD).toFixed(0))}    ${c('dim', `floor $${eb.floorUSD?.toFixed(0)} · ceiling $${eb.ceilingUSD?.toFixed(0)}`)}`);
  console.log(`    ${c('dim', 'Per-signal confidence then lerps inside this band.')}`);
}

function printSafetyFloors(state) {
  console.log();
  console.log(c('bold', '  SAFETY FLOORS (unchanged by scale):'));
  console.log(`    ${c('dim', 'Quorum gate         ')}  ${c('green', '3-of-4 models')}`);
  console.log(`    ${c('dim', 'Daily drawdown CB   ')}  ${c('green', (state.risk.maxDailyDrawdownPct * 100).toFixed(0) + '%')}`);
  console.log(`    ${c('dim', 'Daily $ loss budget ')}  ${c('green', '$' + state.risk.maxDailyLossUSD)}${state.risk.envCapUSD ? c('dim', ` (env cap $${state.risk.envCapUSD})`) : ''}`);
  console.log(`    ${c('dim', 'Emergency pause     ')}  ${state.emergencyPause ? c('red', 'ACTIVE') : c('green', 'armed')}`);
  console.log(`    ${c('dim', 'Circuit breaker     ')}  ${state.circuitBreaker ? c('red', 'TRIPPED') : c('green', 'armed')}`);
  const mode = state.mode || state.tradingMode || 'paper';
  console.log(`    ${c('dim', 'Trading mode        ')}  ${c(mode === 'live' ? 'red' : 'yellow', String(mode).toUpperCase())}`);
}

async function testScale(name) {
  const target = name?.toLowerCase();
  if (!['conservative', 'balanced', 'aggressive'].includes(target)) {
    console.error(c('red', `Unknown scale "${name}". Use: conservative | balanced | aggressive`));
    process.exit(1);
  }
  console.log(c('dim', `→ ${API_URL}  (operator token: ${TOKEN ? 'set' : c('yellow', 'unset — dev mode')})`));
  console.log(c('dim', `→ Switching risk scale to "${target}"...`));

  const before = await api('/api/state');
  const wasAlready = before.riskScale.current === target;

  const result = await api('/api/agent/risk-scale', { method: 'POST', body: { scale: target } });
  if (!result.success) throw new Error('API rejected: ' + JSON.stringify(result));

  const after = await api('/api/state');
  if (after.riskScale.current !== target) {
    console.error(c('red', `✗ FAIL: server still reports "${after.riskScale.current}" after switch`));
    process.exit(2);
  }

  printScaleSettings(after.riskScale);
  printDynamic(after.riskScale);
  printSafetyFloors(after);

  console.log();
  console.log(c('green', c('bold', `  ✓ CONFIRMED: risk scale = "${target}" is ACTIVE`)) +
    c('dim', wasAlready ? '  (no change — was already active)' : `  (was "${before.riskScale.current}")`));
  console.log();
}

async function status() {
  console.log(c('dim', `→ ${API_URL}`));
  const s = await api('/api/state');
  printScaleSettings(s.riskScale);
  printDynamic(s.riskScale);
  printSafetyFloors(s);
  console.log();
  console.log(c('bold', '  ACCOUNT:'));
  console.log(`    ${c('dim', 'Equity              ')}  ${c('green', '$' + s.equity.toLocaleString())}`);
  console.log(`    ${c('dim', 'Starting balance    ')}  ${c('dim', '$' + s.startingBalance.toLocaleString())}`);
  console.log(`    ${c('dim', 'Cash                ')}  ${c('dim', '$' + s.cash.toLocaleString())}`);
  console.log(`    ${c('dim', 'Open positions      ')}  ${c('dim', s.holdings?.length || 0)}`);
  console.log(`    ${c('dim', 'Day P&L             ')}  ${(s.dailyPnL >= 0 ? c('green', '+') : c('red', '')) + '$' + s.dailyPnL.toFixed(2)}`);
  console.log();
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'test') return await testScale(args[0]);
    if (cmd === 'status' || cmd === 'show') return await status();
    console.log(`AlphaTrade risk-scale CLI

  ${c('bold', 'node scripts/risk.js test conservative')}   ${c('dim', '→ "Test Conservative"')}
  ${c('bold', 'node scripts/risk.js test balanced')}       ${c('dim', '→ "Test Balanced"')}
  ${c('bold', 'node scripts/risk.js test aggressive')}     ${c('dim', '→ "Test Aggressive"')}
  ${c('bold', 'node scripts/risk.js status')}              ${c('dim', '→ "Show current risk scale"')}

Env: API_URL (default http://localhost:3001), OPERATOR_TOKEN (if set on server)`);
  } catch (e) {
    console.error(c('red', `✗ ${e.message}`));
    process.exit(1);
  }
}
main();
