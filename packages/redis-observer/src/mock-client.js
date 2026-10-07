'use strict';
// In-memory mock Redis client implementing the minimal command surface used by RedisObserver.
// Supports STRING, HASH, LIST, SET, ZSET with TTL, scan, exists, type, and basic commands.
// This is a test double, not a real Redis connection.

class MockRedisClient extends Map {
  constructor() {
    super();
    this._ttl = new Map(); // key -> expiry timestamp (ms) or null (no expiry) or 'none' (no key)
    this._types = new Map();
  }

  _now() { return Date.now(); }

  _effectiveTtl(key) {
    const exp = this._ttl.get(key);
    if (exp === undefined) return 'none';
    if (exp === null) return -1; // no expiry
    const ms = exp - this._now();
    return ms <= 0 ? -2 : Math.ceil(ms / 1000);
  }

  _ptype(key) {
    if (!super.has(key)) return 'none';
    return this._types.get(key) || 'string';
  }

  // --- key commands ---
  async exists(...keys) {
    const list = Array.isArray(keys[0]) ? keys[0] : keys;
    return list.filter((k) => super.has(k)).length;
  }

  async type(key) {
    const t = this._ptype(key);
    return t === 'none' ? 'none' : t;
  }

  async scan(cursor, ...args) {
    // Accept both scan(cursor, pattern, count) and ioredis-style
    // scan(cursor, 'MATCH', pattern, 'COUNT', n).
    let pattern = '*';
    let count = 100;
    if (args.length === 2) {
      pattern = args[0];
      count = args[1];
    } else if (args.length >= 2) {
      const matchIdx = args.findIndex((a) => String(a).toUpperCase() === 'MATCH');
      const countIdx = args.findIndex((a) => String(a).toUpperCase() === 'COUNT');
      if (matchIdx >= 0) pattern = args[matchIdx + 1];
      if (countIdx >= 0) count = args[countIdx + 1];
    }
    const all = [...super.keys()];
    const matched = pattern && pattern !== '*' ? all.filter((k) => {
      const pat = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(`^${pat}$`).test(k);
    }) : all;
    const start = Number(cursor);
    const slice = matched.slice(start, start + Number(count || 100));
    const next = start + slice.length >= matched.length ? '0' : String(start + slice.length);
    return [next, slice];
  }

  async ttl(key) {
    return this._effectiveTtl(key);
  }

  async pttl(key) {
    const exp = this._ttl.get(key);
    if (exp === undefined) return -2;
    if (exp === null) return -1;
    return Math.max(0, exp - this._now());
  }

  async expire(key, seconds) {
    if (!super.has(key)) return 0;
    this._ttl.set(key, this._now() + seconds * 1000);
    return 1;
  }

  async persist(key) {
    if (!super.has(key)) return 0;
    this._ttl.set(key, null);
    return 1;
  }

  async del(key) {
    const existed = super.has(key);
    super.delete(key);
    this._ttl.delete(key);
    this._types.delete(key);
    return existed ? 1 : 0;
  }

  // --- string ---
  async set(key, value) {
    super.set(key, value);
    this._types.set(key, 'string');
    this._ttl.set(key, null);
    return 'OK';
  }

  async get(key) {
    return super.get(key);
  }

  // --- hash ---
  async hset(key, field, value) {
    let map = super.get(key);
    if (!(map instanceof Map)) { map = new Map(); super.set(key, map); this._types.set(key, 'hash'); this._ttl.set(key, null); }
    const existed = map.has(field);
    map.set(field, value);
    return existed ? 0 : 1;
  }

  async hgetall(key) {
    const map = super.get(key);
    if (!(map instanceof Map)) return {};
    return Object.fromEntries(map.entries());
  }

  async hdel(key, ...fields) {
    const map = super.get(key);
    if (!(map instanceof Map)) return 0;
    let n = 0;
    for (const f of fields) { if (map.delete(f)) n += 1; }
    return n;
  }

  // --- list ---
  async rpush(key, ...values) {
    let arr = super.get(key);
    if (!Array.isArray(arr)) { arr = []; super.set(key, arr); this._types.set(key, 'list'); this._ttl.set(key, null); }
    arr.push(...values);
    return arr.length;
  }

  async llen(key) {
    const arr = super.get(key);
    return Array.isArray(arr) ? arr.length : 0;
  }

  // --- set ---
  async sadd(key, ...members) {
    let s = super.get(key);
    if (!(s instanceof Set)) { s = new Set(); super.set(key, s); this._types.set(key, 'set'); this._ttl.set(key, null); }
    let n = 0;
    for (const m of members) { if (!s.has(m)) { s.add(m); n += 1; } }
    return n;
  }

  async scard(key) {
    const s = super.get(key);
    return s instanceof Set ? s.size : 0;
  }

  // --- zset ---
  async zadd(key, score, member) {
    let z = super.get(key);
    if (!(z instanceof Map)) { z = new Map(); super.set(key, z); this._types.set(key, 'zset'); this._ttl.set(key, null); }
    const existed = z.has(member);
    z.set(member, score);
    return existed ? 0 : 1;
  }

  async zcard(key) {
    const z = super.get(key);
    return z instanceof Map ? z.size : 0;
  }

  // --- helpers used by tests ---
  _setExpiry(key, seconds) {
    if (!super.has(key)) return;
    this._ttl.set(key, this._now() + seconds * 1000);
  }

  _setNoExpiry(key) {
    if (!super.has(key)) return;
    this._ttl.set(key, null);
  }
}

module.exports = { MockRedisClient };