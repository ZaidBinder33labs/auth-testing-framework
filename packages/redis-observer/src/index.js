'use strict';
// Redis observer: read-only observation of keys, types, TTLs, fingerprints, metadata.
// Never exposes raw values or secrets. Works against a real ioredis client OR a mock client
// that implements the same minimal command surface (see MockRedisClient in tests).
const crypto = require('crypto');

// Phase 2 additions: generic Redis config + connection abstraction.
const config = require('./config');
const { RedisConnection, RedisConnectionError, safeErrorMessage } = require('./connection');

const REDIS_TYPES = Object.freeze({
  STRING: 'string',
  HASH: 'hash',
  LIST: 'list',
  SET: 'set',
  ZSET: 'zset',
  STREAM: 'stream',
  UNKNOWN: 'unknown',
});

const SENSITIVE_VALUE_RE = /(password|secret|token|refresh|access|cookie|authorization|api[_-]?key)/i;

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function looksSensitive(key) {
  return SENSITIVE_VALUE_RE.test(String(key || ''));
}

class RedisObserverError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'RedisObserverError';
    this.code = code || 'REDIS_OBSERVER_ERROR';
  }
}

class RedisObserver {
  constructor(client, opts = {}) {
    if (!client) throw new RedisObserverError('redis client is required', { code: 'NO_CLIENT' });
    this.client = client;
    this.namespace = opts.namespace || null;
    this.readOnly = opts.readOnly !== false;
    this.ttlToleranceMs = Number(opts.ttlToleranceMs || 2000);
    this._mutationBlocked = 0;
  }

  _namespaced(key) {
    if (!this.namespace) return key;
    return `${this.namespace}:${key}`;
  }

  _scanCursor(cursor) {
    return this.client.scan(cursor, 'MATCH', this.namespace ? `${this.namespace}:*` : '*', 'COUNT', 100);
  }

  async discoverKeys() {
    const keys = [];
    let cursor = '0';
    do {
      const [next, found] = await this._scanCursor(cursor);
      cursor = next;
      for (const raw of found) {
        keys.push(this.namespace ? raw.slice(this.namespace.length + 1) : raw);
      }
    } while (cursor !== '0');
    return keys;
  }

  async inspect(key) {
    const full = this._namespaced(key);
    const exists = await this.client.exists(full);
    if (!exists) return null;
    const type = await this.client.type(full);
    const ttl = await this.client.ttl(full);
    const entry = {
      key,
      exists: true,
      type,
      ttl: (ttl === -2 || ttl === -1) ? null : ttl,
      noExpiry: ttl === -1,
      fingerprint: null,
      cardinality: null,
      fields: null,
      value: null,
    };
    if (type === REDIS_TYPES.STRING) {
      const raw = await this.client.get(full);
      entry.value = looksSensitive(key) ? `[FP:${fingerprint(raw)}]` : raw;
      entry.fingerprint = fingerprint(raw);
    } else if (type === REDIS_TYPES.HASH) {
      const fields = await this.client.hgetall(full);
      entry.fields = Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, looksSensitive(k) ? '[REDACTED]' : v])
      );
      entry.fingerprint = fingerprint(JSON.stringify(fields));
      entry.cardinality = Object.keys(fields).length;
    } else if (type === REDIS_TYPES.LIST) {
      entry.cardinality = await this.client.llen(full);
      entry.fingerprint = fingerprint(`list:${entry.cardinality}`);
    } else if (type === REDIS_TYPES.SET) {
      entry.cardinality = await this.client.scard(full);
      entry.fingerprint = fingerprint(`set:${entry.cardinality}`);
    } else if (type === REDIS_TYPES.ZSET) {
      entry.cardinality = await this.client.zcard(full);
      entry.fingerprint = fingerprint(`zset:${entry.cardinality}`);
    } else {
      entry.fingerprint = fingerprint(`type:${type}`);
    }
    return entry;
  }

  async snapshot() {
    const keys = await this.discoverKeys();
    const snap = {};
    for (const key of keys) {
      snap[key] = await this.inspect(key);
    }
    return snap;
  }

  async pttl(key) {
    const full = this._namespaced(key);
    const p = await this.client.pttl(full);
    return p === -2 ? null : p;
  }

  async getTtl(key) {
    return this.inspect(key).then((e) => (e ? e.ttl : null));
  }

  /** Assert TTL is within expected +/- tolerance. Returns { ok, actual, expected, tolerance }. */
  validateTtl(key, expectedSeconds, toleranceMs) {
    const tol = Number(toleranceMs || this.ttlToleranceMs);
    return this.inspect(key).then((entry) => {
      if (!entry) return { ok: false, reason: 'MISSING', actual: null, expected: expectedSeconds, toleranceMs: tol };
      if (entry.noExpiry) return { ok: false, reason: 'NO_EXPIRY', actual: null, expected: expectedSeconds, toleranceMs: tol };
      if (expectedSeconds === null || expectedSeconds === undefined) return { ok: true, actual: entry.ttl, expected: null, toleranceMs: tol, reason: 'no-expiry-expected' };
      const diff = Math.abs(entry.ttl - expectedSeconds);
      if (diff * 1000 <= tol) {
        return { ok: true, actual: entry.ttl, expected: expectedSeconds, diffMs: diff * 1000, toleranceMs: tol };
      }
      return { ok: false, reason: 'TTL_MISMATCH', actual: entry.ttl, expected: expectedSeconds, diffMs: diff * 1000, toleranceMs: tol };
    });
  }

  /** Discover rate-limit counter keys by pattern prefix.
   * READ-ONLY: never mutates Redis. Returns safe metadata only (no raw values). */
  async observeRateLimitKeys(patterns = [], opts = {}) {
    const { prefixRe = null, maxKeys = 200 } = opts;
    const keys = await this.discoverKeys();
    const matched = [];
    for (const key of keys) {
      if (patterns.length && !patterns.some((p) => key.includes(p))) continue;
      if (prefixRe && !prefixRe.test(key)) continue;
      if (matched.length >= maxKeys) break;
      const entry = await this.inspect(key);
      if (!entry) continue;
      matched.push({
        key,
        type: entry.type,
        ttl: entry.ttl,
        noExpiry: entry.noExpiry,
        cardinality: entry.cardinality,
        fingerprint: entry.fingerprint,
        counter: entry.type === REDIS_TYPES.STRING ? entry.value : (entry.cardinality || null),
      });
    }
    return matched;
  }

  blockMutations() {
    this._mutationBlocked = 1;
  }

  isMutationBlocked() {
    return this._mutationBlocked === 1;
  }
}

module.exports = {
  RedisObserver,
  RedisObserverError,
  REDIS_TYPES,
  fingerprint,
  // Phase 2 additions
  RedisConnection,
  RedisConnectionError,
  safeErrorMessage,
  RedisConfigError: config.RedisConfigError,
  loadConfig: config.load,
  sanitizeUrl: config.sanitizeUrl,
  hasAuth: config.hasAuth,
  isAllowedCommand: config.isAllowedCommand,
  isBlockedCommand: config.isBlockedCommand,
  validateDb: config.validateDb,
  parseDb: config.parseDb,
  ALLOWED_COMMANDS: config.ALLOWED_COMMANDS,
  BLOCKED_COMMANDS: config.BLOCKED_COMMANDS,
};