import { describe, it, expect } from 'vitest';
import exp from '../backend/services/expectancyService.js';

describe('expectancyService pure helpers', () => {
  describe('_shouldAutoSuspendPure', () => {
    it('returns false below MIN_TRADES_FOR_SUSPEND', () => {
      expect(exp._shouldAutoSuspendPure({ n_trades: 5, expectancy_r: -1.0 })).toBe(false);
    });

    it('returns false above suspend threshold even with many trades', () => {
      expect(exp._shouldAutoSuspendPure({ n_trades: 50, expectancy_r: -0.1 })).toBe(false);
      expect(exp._shouldAutoSuspendPure({ n_trades: 50, expectancy_r:  0.5 })).toBe(false);
    });

    it('returns true at threshold AND min trades', () => {
      expect(exp._shouldAutoSuspendPure({
        n_trades: exp.MIN_TRADES_FOR_SUSPEND,
        expectancy_r: exp.SUSPEND_R_THRESHOLD,
      })).toBe(true);
    });

    it('returns true well below threshold with enough samples', () => {
      expect(exp._shouldAutoSuspendPure({ n_trades: 20, expectancy_r: -2.0 })).toBe(true);
    });

    it('handles malformed inputs', () => {
      expect(exp._shouldAutoSuspendPure({})).toBe(false);
      expect(exp._shouldAutoSuspendPure({ n_trades: NaN, expectancy_r: -1 })).toBe(false);
    });

    it('respects custom thresholds', () => {
      expect(exp._shouldAutoSuspendPure({ n_trades: 3, expectancy_r: -0.1, minTrades: 3, suspendThreshold: 0 })).toBe(true);
    });
  });

  describe('_computeExpectancyPure', () => {
    it('empty trade list yields zeros', () => {
      const r = exp._computeExpectancyPure([]);
      expect(r.n_trades).toBe(0);
      expect(r.expectancy_r).toBe(0);
    });

    it('all winners yield positive expectancy', () => {
      const r = exp._computeExpectancyPure([
        { pnlUSD: 100, riskUSD: 50 },
        { pnlUSD:  50, riskUSD: 50 },
      ]);
      expect(r.n_wins).toBe(2);
      expect(r.expectancy_r).toBeGreaterThan(0);
    });

    it('mixed wins/losses compute R-multiple correctly', () => {
      const r = exp._computeExpectancyPure([
        { pnlUSD: 200, riskUSD: 100 }, // +2R
        { pnlUSD: -50, riskUSD: 100 }, // -0.5R
      ]);
      expect(r.expectancy_r).toBeCloseTo(0.75, 5);
      expect(r.n_wins).toBe(1);
    });

    it('falls back to abs(pnl) when riskUSD missing', () => {
      const r = exp._computeExpectancyPure([{ pnlUSD: -100 }]);
      expect(r.expectancy_r).toBeCloseTo(-1.0, 5);
    });

    it('a long losing streak breaches the suspend threshold', () => {
      const trades = Array.from({ length: 12 }, () => ({ pnlUSD: -75, riskUSD: 100 }));
      const r = exp._computeExpectancyPure(trades);
      expect(r.expectancy_r).toBeCloseTo(-0.75, 5);
      expect(exp._shouldAutoSuspendPure(r)).toBe(true);
    });
  });
});
