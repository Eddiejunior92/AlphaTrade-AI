import { describe, it, expect } from 'vitest';
import ps from '../backend/services/positionSizingService.js';

describe('positionSizingService.computeAsymmetricSize', () => {
  const dayBase = { name: 'day', maxPositionPct: 0.04 };
  const asxDayBase = { name: 'asx_day', maxPositionPct: 0.04 };
  const swingBase = { name: 'swing', maxPositionPct: 0.05 };

  it('passes through swing strategies unchanged', () => {
    const r = ps.computeAsymmetricSize(0.90, swingBase);
    expect(r.applied).toBe(false);
    expect(r.maxPositionPct).toBe(0.05);
    expect(r.multiplier).toBe(1.0);
  });

  it('1.0× multiplier at confidence floor 0.65', () => {
    const r = ps.computeAsymmetricSize(0.65, dayBase);
    expect(r.applied).toBe(true);
    expect(r.multiplier).toBeCloseTo(1.0, 5);
    expect(r.maxPositionPct).toBeCloseTo(0.04, 5);
  });

  it('3.0× multiplier at confidence ceiling 0.90 (clamped to ABS_CEIL=0.05)', () => {
    const r = ps.computeAsymmetricSize(0.90, dayBase);
    expect(r.multiplier).toBeCloseTo(3.0, 5);
    expect(r.rawPct).toBeCloseTo(0.12, 5);
    expect(r.maxPositionPct).toBe(0.05);
    expect(r.clamped).toBe(true);
    expect(r.violatedBound).toBe(true);
  });

  it('with small base 0.01, range is exactly [0.01, 0.03] across [0.65, 0.90]', () => {
    const lo = ps.computeAsymmetricSize(0.65, { name: 'day', maxPositionPct: 0.01 });
    const hi = ps.computeAsymmetricSize(0.90, { name: 'day', maxPositionPct: 0.01 });
    expect(lo.maxPositionPct).toBeCloseTo(0.01, 5);
    expect(hi.maxPositionPct).toBeCloseTo(0.03, 5);
    expect(lo.violatedBound).toBe(false);
    expect(hi.violatedBound).toBe(false);
  });

  it('clamps confidence outside [0.65, 0.90] band', () => {
    const lo = ps.computeAsymmetricSize(0.20, dayBase);
    const hi = ps.computeAsymmetricSize(0.99, dayBase);
    expect(lo.confidence).toBe(0.65);
    expect(hi.confidence).toBe(0.90);
  });

  it('asx_day treated as day strategy', () => {
    const r = ps.computeAsymmetricSize(0.90, asxDayBase);
    expect(r.applied).toBe(true);
    expect(r.maxPositionPct).toBe(0.05);
  });

  it('NEVER exceeds hard ABS_CEIL even with absurdly large base', () => {
    const r = ps.computeAsymmetricSize(0.90, { name: 'day', maxPositionPct: 0.5 });
    expect(r.maxPositionPct).toBeLessThanOrEqual(ps.ABS_CEIL);
    expect(r.violatedBound).toBe(true);
  });

  it('NEVER drops below ABS_FLOOR', () => {
    const r = ps.computeAsymmetricSize(0.65, { name: 'day', maxPositionPct: 0.001 });
    expect(r.maxPositionPct).toBeGreaterThanOrEqual(ps.ABS_FLOOR);
  });

  it('withAsymmetricSizing clones rather than mutates', () => {
    const base = { name: 'day', maxPositionPct: 0.04, foo: 'bar' };
    const { sc, sizing } = ps.withAsymmetricSizing(base, 0.80);
    expect(sc).not.toBe(base);
    expect(base.maxPositionPct).toBe(0.04);
    expect(sc.foo).toBe('bar');
    expect(sizing.applied).toBe(true);
  });
});
