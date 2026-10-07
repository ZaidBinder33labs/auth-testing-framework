'use strict';
// Mock RedisAdapter: wraps the in-memory mock client behind the RedisAdapter contract.
// Supports tenant/session stamping so isolation engines can read tenantId/sessionId from entries.
const { RedisObserver } = require('@atf/redis-observer');
const { MockRedisClient } = require('@atf/redis-observer/src/mock-client');

class MockRedisAdapter {
  constructor(opts = {}) {
    this.client = opts.client || new MockRedisClient();
    this.observer = new RedisObserver(this.client, {
      namespace: opts.namespace || null,
      readOnly: opts.readOnly !== false,
      ttlToleranceMs: opts.ttlToleranceMs,
    });
    this.mode = opts.mode || 'MOCK_REDIS';
    this.allowedMutations = opts.allowMutations || false;
    this.createdKeys = new Set();
    this._tenantId = opts.tenantId || null;
    this._sessionId = opts.sessionId || null;
    this._meta = new Map(); // key -> { tenantId, sessionId }
  }

  withTenantContext(tenantId, sessionId) {
    if (tenantId) this._tenantId = tenantId;
    if (sessionId) this._sessionId = sessionId;
  }

  _stamp(entry) {
    if (!entry) return entry;
    const meta = this._meta.get(entry.key);
    if (meta) {
      if (meta.tenantId) entry.tenantId = meta.tenantId;
      if (meta.sessionId) entry.sessionId = meta.sessionId;
    }
    return entry;
  }

  async inspect(key) { return this._stamp(await this.observer.inspect(key)); }
  async snapshot() {
    const snap = await this.observer.snapshot();
    for (const k of Object.keys(snap)) this._stamp(snap[k]);
    return snap;
  }
  async discoverKeys() { return this.observer.discoverKeys(); }
  async getTtl(key) { return this.observer.getTtl(key); }
  async pttl(key) { return this.observer.pttl(key); }
  async validateTtl(key, expectedSeconds, toleranceMs) { return this.observer.validateTtl(key, expectedSeconds, toleranceMs); }

  async set(key, value) { this._checkMutation('set'); await this.client.set(key, value); this._record(key); }
  async hset(key, field, value) { this._checkMutation('hset'); await this.client.hset(key, field, value); this._record(key); }
  async expire(key, seconds) { this._checkMutation('expire'); await this.client.expire(key, seconds); }
  async del(key) { this._checkMutation('del'); return this.client.del(key); }

  _record(key) {
    this.createdKeys.add(key);
    const meta = this._meta.get(key) || {};
    if (this._tenantId) meta.tenantId = this._tenantId;
    if (this._sessionId) meta.sessionId = this._sessionId;
    this._meta.set(key, meta);
  }

  _checkMutation(op) {
    if (!this.allowedMutations) {
      const err = new Error(`Redis mutation (${op}) blocked: REDIS_MODE=${this.mode}`);
      err.code = 'REDIS_MUTATION_BLOCKED';
      throw err;
    }
  }

  trackKey(key) { this.createdKeys.add(key); }
  ownedKeys() { return [...this.createdKeys]; }
  clearTracked() { this.createdKeys.clear(); }
}

function createMockRedisAdapter(opts = {}) {
  return new MockRedisAdapter(opts);
}

module.exports = { MockRedisAdapter, createMockRedisAdapter };