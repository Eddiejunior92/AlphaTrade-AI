const STRATEGIES = {
  day: {
    name: 'day',
    label: 'Day Trading',
    description: 'Fast intraday trades on 1-minute bars. Auto-flattens 5 min before close. No overnight risk.',
    timeframe: '1Min',
    lookback: 30,
    intervalSeconds: 60,
    stopLossPct: 0.005,
    takeProfitPct: 0.01,
    minRiskUSD: 50,
    maxRiskUSD: 100,
    maxHoldings: 4,
    forceFlattenBeforeClose: true,
    holdOvernight: false,
    confidenceThreshold: 0.85,
    minDirectionalAgreement: 3,
    maxPositionPct: 0.03,
  },
  swing: {
    name: 'swing',
    label: 'Longer Hold',
    description: 'Multi-day swing trades on 15-minute bars. Wider stops, larger targets, can hold overnight.',
    timeframe: '15Min',
    lookback: 60,
    intervalSeconds: 300,
    stopLossPct: 0.02,
    takeProfitPct: 0.05,
    minRiskUSD: 75,
    maxRiskUSD: 200,
    maxHoldings: 3,
    forceFlattenBeforeClose: false,
    holdOvernight: true,
    confidenceThreshold: 0.85,
    minDirectionalAgreement: 3,
    maxPositionPct: 0.05,
  },
};

function getStrategy(name) { return STRATEGIES[name] || null; }
function listStrategies() { return Object.values(STRATEGIES); }

module.exports = { STRATEGIES, getStrategy, listStrategies };
