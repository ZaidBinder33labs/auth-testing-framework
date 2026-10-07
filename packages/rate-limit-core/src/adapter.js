'use strict';
// Rate-limit adapter contract + mock adapter.
// A real RateLimitAdapter integrates through this contract and is verified by the
// contract tests. Mock adapters let the framework self-test with no target app.

class RateLimitAdapterContract extends Error {
  constructor(method) { super(`RateLimitAdapter must implement ${method}()`); this.name = 'RateLimitAdapterContract'; }
}

function assertRateLimitAdapter(adapter, label = 'adapter') {
  for (const fn of ['observeKeys', 'observeCounter', 'observeTtl', 'snapshot']) {
    if (typeof adapter[fn] !== 'function') throw new RateLimitAdapterContract(`${label}.${fn}`);
  }
  return true;
}

/** Mock RateLimitAdapter backed by the in-memory mock Redis client.
 * Supports configurable limits per scope and atomic counter behaviour. */
class MockRateLimitAdapter {
  constructor(opts = {}) {
    this.client = opts.client || null;
    this.limits = opts.limits || {};
    this.mode = opts.mode || 'MOCK_REDIS';
    this.atomic = opts.atomic !== false;
    this.windowMs = opts.windowMs || 60000;
    this.prefix = opts.prefix || 'rl';
    this._counters = new Map(); // key -> { count, expiresAt }
  }

  _key(scope, id) {
    return `${this.prefix}:${scope}:${id}`;
  }

  _now() { return Date.now(); }

  _prune() {
    const now = this._now();
    for (const [k, v] of this._counters) {
      if (v.expiresAt <= now) this._counters.delete(k);
    }
  }

  _limitFor(scope) {
    return this.limits[scope] || this.limits.default || 60;
  }

  async observeKeys() {
    this._prune();
    return [...this._counters.keys()];
  }

  async observeCounter(key) {
    this._prune();
    const rec = this._counters.get(key);
    if (!rec) return { key, count: 0, exists: false, ttl: null, fingerprint: null };
    const ttl = Math.max(0, Math.ceil((rec.expiresAt - this._now()) / 1000));
    return {
      key,
      count: rec.count,
      exists: true,
      ttl,
      fingerprint: `fp_${key.slice(0, 12)}`,
    };
  }

  async observeTtl(key) {
    const c = await this.observeCounter(key);
    return c.ttl;
  }

  async snapshot() {
    this._prune();
    const out = {};
    for (const [k, v] of this._counters) {
      out[k] = {
        key: k,
        count: v.count,
        ttl: Math.max(0, Math.ceil((v.expiresAt - this._now()) / 1000)),
        exists: true,
      };
    }
    return out;
  }

  /** Simulate a request: increment the counter and return whether it was allowed. */
  async hit(scope, id) {
    const key = this._key(scope, id);
    this._prune();
    const limit = this._limitFor(scope);
    const now = this._now();
    let rec = this._counters.get(key);
    if (!rec || rec.expiresAt <= now) {
      rec = { count: 0, expiresAt: now + this.windowMs };
      this._counters.set(key, rec);
    }
    if (this.atomic) {
      rec.count += 1;
    }
    const allowed = rec.count <= limit;
    return { key, count: rec.count, limit, allowed, ttl: Math.max(0, Math.ceil((rec.expiresAt - now) / 1000)) };
  }

  /** Reset a scope's counter (only in mock/test mode). */
  async reset(scope, id) {
    const key = this._key(scope, id);
    this._counters.delete(key);
  }
}

function createMockRateLimitAdapter(opts = {}) {
  return new MockRateLimitAdapter(opts);
}

module.exports = {
  RateLimitAdapterContract,
  assertRateLimitAdapter,
  MockRateLimitAdapter,
  createMockRateLimitAdapter,
};