import { describe, it, expect } from 'vitest';
import council from '../backend/services/councilService.js';

describe('Council ROLES (Phase B — 8 roles)', () => {
  it('contains exactly the 8 expected role IDs', () => {
    const ids = council.ROLES.map(r => r.id).sort();
    expect(ids).toEqual([
      'adversarial', 'deep_research', 'fundamental', 'future_prediction',
      'historical_research', 'risk', 'technical',
    ]);
    expect(ids.length).toBe(7);
  });
  it('every role declares a unique LLM task type and a non-empty pool', () => {
    const seen = new Set();
    for (const r of council.ROLES) {
      expect(typeof r.task).toBe('string');
      expect(r.task.startsWith('council_')).toBe(true);
      expect(seen.has(r.task)).toBe(false);
      seen.add(r.task);
      expect(Array.isArray(r.pool)).toBe(true);
      expect(r.pool.length).toBeGreaterThan(0);
      for (const m of r.pool) expect(council.MODEL_REGISTRY).toHaveProperty(m);
    }
  });
  it('Adversarial prompt instructs to argue the OPPOSITE thesis', () => {
    const a = council.ROLES.find(r => r.id === 'adversarial');
    expect(a).toBeTruthy();
    const p = a.prompt({ symbol: 'AAPL' });
    expect(p).toMatch(/OPPOSITE|opposite|counter/i);
    expect(p).toMatch(/failure_modes/);
  });
  it('Technical prompt embeds MTF block when ctx provides it (and omits cleanly when not)', () => {
    const t = council.ROLES.find(r => r.id === 'technical');
    const withMtf = t.prompt({ symbol: 'AAPL', mtfConsensusBlock: 'MTF-CONSENSUS: aligned UP' });
    const withoutMtf = t.prompt({ symbol: 'AAPL' });
    expect(withMtf).toMatch(/MTF-CONSENSUS/);
    expect(withoutMtf).not.toMatch(/MTF-CONSENSUS/);
  });
});
