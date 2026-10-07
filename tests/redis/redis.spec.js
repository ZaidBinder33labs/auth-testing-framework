'use strict';
// Redis snapshot/diff/TTL/consistency tests.
const test = require('node:test');
const assert = require('node:assert');
const { RedisObserver, REDIS_TYPES } = require('@atf/redis-observer');
const { MockRedisClient } = require('@atf/redis-observer/src/mock-client');
const { diffSnapshots } = require('@atf/state-diff');
const { createMockRedisAdapter } = require('@atf/adapters');

function makeObserver(opts = {}) {
  return new RedisObserver(new MockRedisClient(), opts);
}

test('redis: key existence detection', async () => {
  const obs = makeObserver();
  await obs.client.set('k', 'v');
  const entry = await obs.inspect('k');
  assert.strictEqual(entry.exists, true);
  assert.strictEqual((await obs.inspect('missing')), null);
});

test('redis: key type detection', async () => {
  const obs = makeObserver();
  await obs.client.hset('h', 'f', 'v');
  await obs.client.rpush('l', 'a');
  await obs.client.sadd('s', 'm');
  assert.strictEqual((await obs.inspect('h')).type, REDIS_TYPES.HASH);
  assert.strictEqual((await obs.inspect('l')).type, REDIS_TYPES.LIST);
  assert.strictEqual((await obs.inspect('s')).type, REDIS_TYPES.SET);
});

test('redis: TTL observation', async () => {
  const obs = makeObserver();
  await obs.client.set('k', 'v');
  await obs.client.expire('k', 3600);
  const entry = await obs.inspect('k');
  assert.ok(entry.ttl > 0 && entry.ttl <= 3600);
  assert.strictEqual(entry.noExpiry, false);
});

test('redis: no-expiry detection', async () => {
  const obs = makeObserver();
  await obs.client.set('k', 'v');
  const entry = await obs.inspect('k');
  assert.strictEqual(entry.noExpiry, true);
  assert.strictEqual(entry.ttl, null);
});

test('redis: creation detection via diff', async () => {
  const before = {};
  const after = { 'k': { type: 'string', value: 'v', ttl: null, tenantId: 't', sessionId: 's' } };
  const diff = diffSnapshots(before, after);
  assert.ok(diff.added.includes('k'));
});

test('redis: deletion detection via diff', async () => {
  const before = { 'k': { type: 'string', value: 'v', ttl: null, tenantId: 't', sessionId: 's' } };
  const after = {};
  const diff = diffSnapshots(before, after);
  assert.ok(diff.removed.includes('k'));
});

test('redis: modification detection via diff', async () => {
  const before = { 'k': { type: 'string', value: 'v1', ttl: null, tenantId: 't', sessionId: 's' } };
  const after = { 'k': { type: 'string', value: 'v2', ttl: null, tenantId: 't', sessionId: 's' } };
  const diff = diffSnapshots(before, after);
  assert.ok(diff.modified.includes('k'));
});

test('redis: fingerprinting hides raw values', async () => {
  const obs = makeObserver();
  await obs.client.hset('sess:1', 'password', 'supersecret');
  await obs.client.hset('sess:1', 'user', 'alice');
  const entry = await obs.inspect('sess:1');
  assert.strictEqual(entry.fields.password, '[REDACTED]');
  assert.strictEqual(entry.fields.user, 'alice');
  assert.ok(entry.fingerprint);
});

test('redis: tenant association via entry metadata', async () => {
  const obs = makeObserver();
  await obs.client.hset('sess:1', 'user', 'alice');
  const entry = await obs.inspect('sess:1');
  assert.strictEqual(entry.type, REDIS_TYPES.HASH);
  assert.strictEqual(entry.cardinality, 1);
});

test('redis: session association via key naming', async () => {
  const obs = makeObserver();
  await obs.client.hset('sess:abc:token', 'k', 'v');
  const keys = await obs.discoverKeys();
  assert.ok(keys.some((k) => k.includes('sess:')));
});

test('redis: snapshot consistency across multiple keys', async () => {
  const obs = makeObserver();
  await obs.client.set('a', '1');
  await obs.client.set('b', '2');
  await obs.client.set('c', '3');
  const snap = await obs.snapshot();
  assert.strictEqual(Object.keys(snap).length, 3);
  assert.ok(snap.a && snap.b && snap.c);
});

test('redis: adapter mutation blocked by default', async () => {
  const adapter = createMockRedisAdapter({ mode: 'READ_ONLY' });
  await assert.rejects(() => adapter.set('k', 'v'), /blocked/);
  await assert.rejects(() => adapter.hset('h', 'f', 'v'), /blocked/);
});

test('redis: adapter allows controlled mutation when enabled', async () => {
  const adapter = createMockRedisAdapter({ allowMutations: true });
  await adapter.set('k', 'v');
  assert.strictEqual((await adapter.inspect('k')).value, 'v');
});

test('redis: pttl returns milliseconds', async () => {
  const obs = makeObserver();
  await obs.client.set('k', 'v');
  await obs.client.expire('k', 5);
  const p = await obs.pttl('k');
  assert.ok(p > 0 && p <= 5000);
});

test('redis: TTL decreases over time', async () => {
  const obs = makeObserver();
  await obs.client.set('k', 'v');
  await obs.client.expire('k', 5);
  const t1 = await obs.getTtl('k');
  await new Promise((r) => setTimeout(r, 50));
  const t2 = await obs.getTtl('k');
  assert.ok(t1 >= t2);
});

test('redis: validateTtl within tolerance passes', async () => {
  const obs = makeObserver({ ttlToleranceMs: 2000 });
  await obs.client.set('k', 'v');
  await obs.client.expire('k', 3600);
  const r = await obs.validateTtl('k', 3600, 2000);
  assert.strictEqual(r.ok, true);
});

test('redis: validateTtl outside tolerance fails', async () => {
  const obs = makeObserver({ ttlToleranceMs: 100 });
  await obs.client.set('k', 'v');
  await obs.client.expire('k', 10);
  const r = await obs.validateTtl('k', 3600, 100);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'TTL_MISMATCH');
});

test('redis: validateTtl no expiry fails with NO_EXPIRY', async () => {
  const obs = makeObserver();
  await obs.client.set('k', 'v');
  const r = await obs.validateTtl('k', 3600, 2000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'NO_EXPIRY');
});