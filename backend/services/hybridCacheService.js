// hybridCacheService — bounded TTL+LRU cache for hybridSignalService route
// decisions. Strictly a memoization layer; identical inputs (composed key)
// yield identical outputs within TTL. Invalidated on:
//   • any trade close          (invalidateSymbol)
//   • regime classification    (invalidate('regime_change'))
//   • dynamic gate change      (invalidate('gate_change'))
//   • daily reset              (invalidateAll)
//
// SAFETY: this caches HYBRID ROUTE DECISIONS only — never replaces quorum,
// confidence-gate, daily-loss budget, breaker, kill switch, atomic cash, or
// audit chain. Cache miss == identical behavior to pre-Phase-B.

const TTL_MS_DEFAULT = 120 * 60 * 1000; // 120m
const MAX_ENTRIES_DEFAULT = 5000;

function _now() { return Date.now(); }

class HybridCache {
  constructor({ ttlMs = TTL_MS_DEFAULT, maxEntries = MAX_ENTRIES_DEFAULT } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this._map = new Map(); // insertion-order = LRU
    this._stats = { hits: 0, misses: 0, sets: 0, evictions: 0, invalidations: 0 };
  }

  // 5-key composer. ALL five fields participate so a regime/gate/news/
  // holding-state change yields a different cache key (no stale routes).
  composeKey({ symbol, strategy, regime, gateBucket, newsBucket }) {
    const sym = String(symbol || '').toUpperCase();
    const str = String(strategy || '');
    const reg = regime ? String(regime.primary || regime) : 'none';
    const gb  = Number.isFinite(gateBucket) ? Math.round(gateBucket * 100) : 'na';
    const nb  = newsBucket == null ? 'na' : String(newsBucket);
    return `${sym}|${str}|${reg}|${gb}|${nb}`;
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) { this._stats.misses++; return null; }
    if (_now() - entry.ts > this.ttlMs) {
      this._map.delete(key);
      this._stats.misses++;
      return null;
    }
    // refresh LRU position
    this._map.delete(key);
    this._map.set(key, entry);
    this._stats.hits++;
    return entry.value;
  }

  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, { value, ts: _now() });
    this._stats.sets++;
    while (this._map.size > this.maxEntries) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
      this._stats.evictions++;
    }
  }

  has(key) { return this.get(key) !== null; }

  invalidate(reason = 'unspecified') {
    const n = this._map.size;
    this._map.clear();
    this._stats.invalidations++;
    return { cleared: n, reason };
  }

  invalidateSymbol(symbol) {
    const sym = String(symbol || '').toUpperCase();
    let cleared = 0;
    for (const k of Array.from(this._map.keys())) {
      if (k.startsWith(`${sym}|`)) { this._map.delete(k); cleared++; }
    }
    if (cleared) this._stats.invalidations++;
    return { cleared, reason: `symbol:${sym}` };
  }

  invalidateAll() { return this.invalidate('all'); }

  getStats() {
    const total = this._stats.hits + this._stats.misses;
    return {
      ...this._stats,
      size: this._map.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hitRate: total > 0 ? +(this._stats.hits / total).toFixed(4) : 0,
    };
  }

  // Test-only: drain all state for a clean slate.
  _resetForTest() {
    this._map.clear();
    this._stats = { hits: 0, misses: 0, sets: 0, evictions: 0, invalidations: 0 };
  }
}

const _singleton = new HybridCache();

module.exports = {
  HybridCache,
  composeKey: (k) => _singleton.composeKey(k),
  get: (k) => _singleton.get(k),
  set: (k, v) => _singleton.set(k, v),
  has: (k) => _singleton.has(k),
  invalidate: (r) => _singleton.invalidate(r),
  invalidateSymbol: (s) => _singleton.invalidateSymbol(s),
  invalidateAll: () => _singleton.invalidateAll(),
  getStats: () => _singleton.getStats(),
  _resetForTest: () => _singleton._resetForTest(),
};
