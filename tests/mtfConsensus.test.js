import { describe, it, expect } from 'vitest';
import mtf from '../backend/services/mtfConsensusService.js'; const { computeMtfConsensus, renderForPrompt } = mtf;

describe('mtfConsensusService', () => {
  it('returns ok:false when no timeframes provided', () => {
    const r = computeMtfConsensus({});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_timeframes_available');
    expect(r.score).toBe(0);
  });

  it('all-up across 3 frames yields score=1, dir=up, agree=3', () => {
    const up = { rsi: 60, macd: { histogram: 0.5 } };
    const r = computeMtfConsensus({ tf5m: up, tf15m: up, tf1h: up });
    expect(r.ok).toBe(true);
    expect(r.direction).toBe('up');
    expect(r.score).toBe(1);
    expect(r.agree).toBe(3);
  });

  it('all-down yields score=-1, dir=down', () => {
    const dn = { rsi: 35, macd: { histogram: -0.5 } };
    const r = computeMtfConsensus({ tf5m: dn, tf15m: dn, tf1h: dn });
    expect(r.direction).toBe('down');
    expect(r.score).toBe(-1);
  });

  it('mixed up/down/flat reduces score', () => {
    const up = { rsi: 60, macd: { histogram: 0.5 } };
    const dn = { rsi: 35, macd: { histogram: -0.5 } };
    const flat = { rsi: 50, macd: { histogram: 0 } };
    const r = computeMtfConsensus({ tf5m: up, tf15m: dn, tf1h: flat });
    expect(Math.abs(r.score)).toBeLessThan(0.5);
    expect(r.framesPresent).toBe(3);
  });

  it('degrades gracefully with one frame', () => {
    const up = { rsi: 60, macd: { histogram: 0.3 } };
    const r = computeMtfConsensus({ tf15m: up });
    expect(r.ok).toBe(true);
    expect(r.framesPresent).toBe(1);
    expect(r.direction).toBe('up');
  });

  it('renderForPrompt returns null for missing data and a string otherwise', () => {
    expect(renderForPrompt(null)).toBeNull();
    expect(renderForPrompt({ ok: false })).toBeNull();
    const r = computeMtfConsensus({ tf5m: { rsi: 60, macd: { histogram: 0.4 } } });
    expect(typeof renderForPrompt(r)).toBe('string');
  });
});
