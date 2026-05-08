import { describe, it, expect } from 'vitest';
import gate from '../backend/services/dynamicGateService.js';

describe('computeRegimeAdjustment', () => {
  it('returns 0 for null/undefined/empty input (null-safe)', () => {
    expect(gate.computeRegimeAdjustment(null)).toBe(0);
    expect(gate.computeRegimeAdjustment(undefined)).toBe(0);
    expect(gate.computeRegimeAdjustment('')).toBe(0);
    expect(gate.computeRegimeAdjustment({})).toBe(0);
  });
  it('returns 0 for unknown regime labels (raise-only floor)', () => {
    expect(gate.computeRegimeAdjustment('trending')).toBe(0);
    expect(gate.computeRegimeAdjustment('mean_reverting')).toBe(0);
    expect(gate.computeRegimeAdjustment('normal')).toBe(0);
    expect(gate.computeRegimeAdjustment({ primary: 'unknown' })).toBe(0);
  });
  it('returns positive adjustment for risk-elevating regimes', () => {
    expect(gate.computeRegimeAdjustment('high_vol')).toBeGreaterThan(0);
    expect(gate.computeRegimeAdjustment('news_driven')).toBeGreaterThan(0);
    expect(gate.computeRegimeAdjustment('low_liquidity')).toBeGreaterThan(0);
  });
  it('never exceeds REGIME_ADJ_MAX (single-cycle bound)', () => {
    for (const k of Object.keys(gate.REGIME_RULES)) {
      const adj = gate.computeRegimeAdjustment(k);
      expect(adj).toBeLessThanOrEqual(gate.REGIME_ADJ_MAX);
      expect(adj).toBeGreaterThanOrEqual(0);
    }
  });
  it('accepts both string and {primary} object inputs identically', () => {
    expect(gate.computeRegimeAdjustment('high_vol'))
      .toBe(gate.computeRegimeAdjustment({ primary: 'high_vol' }));
  });
});

describe('clampGate × regime composition', () => {
  it('clampGate keeps result in [SAFETY_FLOOR, SAFETY_CEIL]', () => {
    expect(gate.clampGate(0.50)).toBe(gate.SAFETY_FLOOR);
    expect(gate.clampGate(1.50)).toBe(gate.SAFETY_CEIL);
    expect(gate.clampGate(0.80)).toBe(0.80);
  });
  it('base + max regime adjustment never exceeds SAFETY_CEIL after clamp', () => {
    const composed = gate.clampGate(gate.BASE_GATE + gate.REGIME_ADJ_MAX);
    expect(composed).toBeLessThanOrEqual(gate.SAFETY_CEIL);
    expect(composed).toBeGreaterThanOrEqual(gate.SAFETY_FLOOR);
  });
});
