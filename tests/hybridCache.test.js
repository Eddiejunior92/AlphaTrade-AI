import { describe, it, expect, beforeEach } from 'vitest';
import cache from '../backend/services/hybridCacheService.js';
const { HybridCache } = cache;

describe('hybridCacheService', () => {
  beforeEach(() => cache._resetForTest());

  it('composes a 5-key string deterministically', () => {
    const k1 = cache.composeKey({ symbol: 'aapl', strategy: 'day', regime: { primary: 'trending' }, gateBucket: 0.78, newsBucket: 'pos' });
    const k2 = cache.composeKey({ symbol: 'AAPL', strategy: 'day', regime: 'trending', gateBucket: 0.78, newsBucket: 'pos' });
    expect(k1).toBe('AAPL|day|trending|78|pos');
    expect(k2).toBe('AAPL|day|trending|78|pos');
  });

  it('keys differ across each of the 5 dimensions', () => {
    const base = { symbol: 'AAPL', strategy: 'day', regime: 'normal', gateBucket: 0.80, newsBucket: 'neu' };
    const k = cache.composeKey(base);
    expect(cache.composeKey({ ...base, symbol: 'MSFT' })).not.toBe(k);
    expect(cache.composeKey({ ...base, strategy: 'swing' })).not.toBe(k);
    expect(cache.composeKey({ ...base, regime: 'high_vol' })).not.toBe(k);
    expect(cache.composeKey({ ...base, gateBucket: 0.85 })).not.toBe(k);
    expect(cache.composeKey({ ...base, newsBucket: 'pos' })).not.toBe(k);
  });

  it('get/set round-trips and counts hits/misses', () => {
    expect(cache.get('K')).toBeNull();
    cache.set('K', { route: 'STATISTICAL_ONLY' });
    expect(cache.get('K')).toEqual({ route: 'STATISTICAL_ONLY' });
    const s = cache.getStats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.sets).toBe(1);
  });

  it('expires entries after TTL', () => {
    const c = new HybridCache({ ttlMs: 5 });
    c.set('K', 'v');
    expect(c.get('K')).toBe('v');
    const realNow = Date.now;
    Date.now = () => realNow() + 10;
    try { expect(c.get('K')).toBeNull(); }
    finally { Date.now = realNow; }
  });

  it('evicts oldest beyond maxEntries (LRU)', () => {
    const c = new HybridCache({ maxEntries: 3 });
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    c.get('a'); // refresh a
    c.set('d', 4); // should evict b (least-recently-used)
    expect(c.get('b')).toBeNull();
    expect(c.get('a')).toBe(1);
    expect(c.get('d')).toBe(4);
    expect(c.getStats().evictions).toBe(1);
  });

  it('invalidateSymbol clears only matching keys', () => {
    cache.set('AAPL|day|normal|80|neu', 1);
    cache.set('AAPL|swing|normal|80|neu', 2);
    cache.set('MSFT|day|normal|80|neu', 3);
    const r = cache.invalidateSymbol('aapl');
    expect(r.cleared).toBe(2);
    expect(cache.get('MSFT|day|normal|80|neu')).toBe(3);
    expect(cache.get('AAPL|day|normal|80|neu')).toBeNull();
  });

  it('invalidateAll clears everything', () => {
    cache.set('a', 1); cache.set('b', 2);
    const r = cache.invalidateAll();
    expect(r.cleared).toBe(2);
    expect(cache.getStats().size).toBe(0);
  });
});
