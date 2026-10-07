'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { RedisObserver, REDIS_TYPES } = require('../src');
const { MockRedisClient } = require('../src/mock-client');

function makeObserver(opts = {}) {
  return new RedisObserver(new MockRedisClient(), opts);
}

test('redis-observer: inspect string key', async () => {
  const obs = makeObserver();
  await obs.client.set('sess:1', 'hello');
  const entry = await obs.inspect('sess:1');
  assert.strictEqual(entry.exists, true);
  assert.strictEqual(entry.type, REDIS_TYPES.STRING);
  assert.strictEqual(entry.value, 'hello');
  assert.strictEqual(entry.ttl, null);
  assert.strictEqual(entry.noExpiry, true);
});

test('redis-observer: inspect hash key hides sensitive fields', async () => {
  const obs = makeObserver();
  await obs.client.hset('sess:1', 'password', 'secret123');
  await obs.client.hset('sess:1', 'user', 'alice');
  const entry = await obs.inspect('sess:1');
  assert.strictEqual(entry.type, REDIS_TYPES.HASH);
  assert.strictEqual(entry.cardinality, 2);
  assert.strictEqual(entry.fields.password, '[REDACTED]');
  assert.strictEqual(entry.fields.user, 'alice');
});

test('redis-observer: inspect list/set/zset cardinality', async () => {
  const obs = makeObserver();
  await obs.client.rpush('q:1', 'a', 'b', 'c');
  await obs.client.sadd('s:1', 'x', 'y');
  await obs.client.zadd('z:1', 1, 'a');
  const list = await obs.inspect('q:1');
  const set = await obs.inspect('s:1');
  const zset = await obs.inspect('z:1');
  assert.strictEqual(list.type, REDIS_TYPES.LIST);
  assert.strictEqual(list.cardinality, 3);
  assert.strictEqual(set.type, REDIS_TYPES.SET);
  assert.strictEqual(set.cardinality, 2);
  assert.strictEqual(zset.type, REDIS_TYPES.ZSET);
  assert.strictEqual(zset.cardinality, 1);
});

test('redis-observer: inspect missing key returns null', async () => {
  const obs = makeObserver();
  const entry = await obs.inspect('missing:key');
  assert.strictEqual(entry, null);
});

test('redis-observer: snapshot discovers all keys', async () => {
  const obs = makeObserver();
  await obs.client.set('a', '1');
  await obs.client.set('b', '2');
  const snap = await obs.snapshot();
  assert.strictEqual(Object.keys(snap).length, 2);
  assert.ok(snap.a && snap.b);
});

test('redis-observer: discoverKeys with namespace prefix', async () => {
  const obs = makeObserver({ namespace: 'ns' });
  await obs.client.set('ns:k1', 'v1');
  await obs.client.set('other:k2', 'v2');
  const keys = await obs.discoverKeys();
  assert.deepStrictEqual(keys, ['k1']);
});

test('redis-observer: validateTtl within tolerance passes', async () => {
  const obs = makeObserver({ ttlToleranceMs: 2000 });
  await obs.client.set('k', 'v');
  await obs.client.expire('k', 3600);
  const r = await obs.validateTtl('k', 3600, 2000);
  assert.strictEqual(r.ok, true);
  assert.ok(Math.abs(r.actual - 3600) <= 2);
});

test('redis-observer: validateTtl outside tolerance fails', async () => {
  const obs = makeObserver({ ttlToleranceMs: 100 });
  await obs.client.set('k', 'v');
  await obs.client.expire('k', 10);
  const r = await obs.validateTtl('k', 3600, 100);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'TTL_MISMATCH');
});

test('redis-observer: validateTtl no expiry fails with NO_EXPIRY', async () => {
  const obs = makeObserver();
  await obs.client.set('k', 'v');
  const r = await obs.validateTtl('k', 3600, 2000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'NO_EXPIRY');
});

test('redis-observer: pttl returns milliseconds', async () => {
  const obs = makeObserver();
  await obs.client.set('k', 'v');
  await obs.client.expire('k', 5);
  const p = await obs.pttl('k');
  assert.ok(p > 0 && p <= 5000, `pttl=${p}`);
});

test('redis-observer: TTL decreases over time', async () => {
  const obs = makeObserver();
  await obs.client.set('k', 'v');
  await obs.client.expire('k', 5);
  const t1 = await obs.getTtl('k');
  await new Promise((r) => setTimeout(r, 50));
  const t2 = await obs.getTtl('k');
  assert.ok(t1 >= t2, `t1=${t1} t2=${t2}`);
  assert.ok(t1 > 0);
});

test('redis-observer: missing key pttl is null', async () => {
  const obs = makeObserver();
  const p = await obs.pttl('missing');
  assert.strictEqual(p, null);
});