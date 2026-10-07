'use strict';
// READ-ONLY safety enforcement + RedisObserver compatibility tests.
const test = require('node:test');
const assert = require('node:assert');
const { RedisConnection } = require('../src/connection');
const { load } = require('../src/config');
const { RedisObserver } = require('../src/index');
const { MockRedisClient } = require('../src/mock-client');

class RecordingClient {
  constructor(opts = {}) {
    this.opts = opts;
    this.calls = [];
    this.connected = false;
    this.blocked = opts.blocked || new Set();
  }
  async connect() { this.connected = true; }
  async ping() { this.calls.push('ping'); return 'PONG'; }
  async scan(cursor, ...rest) {
    this.calls.push('scan');
    return ['0', this.opts.keys || []];
  }
  async exists() { this.calls.push('exists'); return 1; }
  async type() { this.calls.push('type'); return 'string'; }
  async get(key) { this.calls.push('get'); return 'v'; }
  async hgetall() { this.calls.push('hgetall'); return {}; }
  async llen() { this.calls.push('llen'); return 0; }
  async scard() { this.calls.push('scard'); return 0; }
  async zcard() { this.calls.push('zcard'); return 0; }
  async ttl() { this.calls.push('ttl'); return 3600; }
  async pttl() { this.calls.push('pttl'); return 3600000; }
  async quit() { this.calls.push('quit'); this.connected = false; }
}

function makeConn(cfgOpts = {}) {
  const cfg = load({ env: { REDIS_MODE: 'READ_ONLY', ...cfgOpts } });
  const conn = new RedisConnection(cfg);
  const fake = new RecordingClient(cfgOpts);
  conn._createClient = () => fake;
  return { conn, fake };
}

const BLOCKED = ['SET', 'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'PERSIST', 'HSET', 'HDEL', 'RPUSH',
  'SADD', 'ZADD', 'FLUSHDB', 'FLUSHALL', 'EVAL', 'EVALSHA', 'KEYS', 'SETEX', 'RENAME', 'RENAMENX', 'LPOP', 'RPOP', 'SREM', 'ZREM', 'LPUSH', 'SCRIPT', 'RANDOMKEY', 'MOVE', 'OBJECT', 'SORT'];

BLOCKED.forEach((cmd, i) => {
  test(`TC-REDIS-SAFETY-BLOCK-${String(i).padStart(2, '0')}: ${cmd} throws REDIS_MUTATION_BLOCKED and never reaches client`, async () => {
    const { conn, fake } = makeConn();
    await conn.connect();
    let threw = null;
    try { await conn.command(cmd, 'x'); } catch (e) { threw = e; }
    assert.ok(threw, `${cmd} should have thrown`);
    assert.strictEqual(threw.code, 'REDIS_MUTATION_BLOCKED');
    assert.ok(!fake.calls.includes(cmd.toLowerCase()), `${cmd} must not reach the client`);
  });
});

const ALLOWED = [
  ['PING', 'ping'],
  ['SCAN', 'scan'],
  ['EXISTS', 'exists'],
  ['TYPE', 'type'],
  ['GET', 'get'],
  ['HGETALL', 'hgetall'],
  ['LLEN', 'llen'],
  ['SCARD', 'scard'],
  ['ZCARD', 'zcard'],
  ['TTL', 'ttl'],
  ['PTTL', 'pttl'],
];

ALLOWED.forEach(([cmd, method], i) => {
  test(`TC-REDIS-SAFETY-ALLOW-${String(i).padStart(2, '0')}: ${cmd} is allowed and reaches client`, async () => {
    const { conn, fake } = makeConn();
    await conn.connect();
    await conn.command(method, 'x');
    assert.ok(fake.calls.includes(method), `${cmd} should reach the client`);
  });
});

// --- SCAN NOT BLOCKED ---
test('TC-REDIS-SAFETY-SCAN-001: SCAN is allowed and not blocked in READ_ONLY mode', async () => {
  const { conn, fake } = makeConn();
  await conn.connect();
  await conn.command('scan', '0');
  assert.ok(fake.calls.includes('scan'), 'SCAN should reach the client');
});

// --- RedisObserver COMPATIBILITY ---

test('TC-REDIS-OBSERVER-001: existing MockRedisClient works unchanged', async () => {
  const c = new MockRedisClient();
  await c.set('k', 'v');
  assert.strictEqual(await c.get('k'), 'v');
});

test('TC-REDIS-OBSERVER-002: existing RedisObserver constructor works unchanged', () => {
  const obs = new RedisObserver(new MockRedisClient());
  assert.ok(obs);
});

test('TC-REDIS-OBSERVER-003: discoverKeys() still works', async () => {
  const obs = new RedisObserver(new MockRedisClient());
  await obs.client.set('a', '1');
  const keys = await obs.discoverKeys();
  assert.deepStrictEqual(keys, ['a']);
});

test('TC-REDIS-OBSERVER-004: inspect() still works', async () => {
  const obs = new RedisObserver(new MockRedisClient());
  await obs.client.set('k', 'v');
  const entry = await obs.inspect('k');
  assert.strictEqual(entry.exists, true);
  assert.strictEqual(entry.value, 'v');
});

test('TC-REDIS-OBSERVER-005: snapshot() still works', async () => {
  const obs = new RedisObserver(new MockRedisClient());
  await obs.client.set('k', 'v');
  const snap = await obs.snapshot();
  assert.ok(snap.k);
});

test('TC-REDIS-OBSERVER-006: TTL/PTTL still work', async () => {
  const obs = new RedisObserver(new MockRedisClient());
  await obs.client.set('k', 'v');
  await obs.client.expire('k', 3600);
  assert.ok((await obs.getTtl('k')) > 0);
  assert.ok((await obs.pttl('k')) > 0);
});

test('TC-REDIS-OBSERVER-007: validateTtl() still works', async () => {
  const obs = new RedisObserver(new MockRedisClient());
  await obs.client.set('k', 'v');
  await obs.client.expire('k', 3600);
  const r = await obs.validateTtl('k', 3600, 2000);
  assert.strictEqual(r.ok, true);
});

test('TC-REDIS-OBSERVER-008: existing mutation blocking remains functional', async () => {
  const { MockRedisAdapter } = require('@atf/adapters');
  const adapter = new MockRedisAdapter({ mode: 'READ_ONLY' });
  await assert.rejects(() => adapter.set('k', 'v'), /blocked/);
});