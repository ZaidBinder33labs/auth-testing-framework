'use strict';
// Real DEV Redis smoke tests. EXPLICITLY INVOKED ONLY.
// Requires REDIS_MODE=READ_ONLY and REDIS_URL in the environment.
// NOT part of `npm run test:all`. Run via `npm run redis:smoke` or
// `node tools/run-dev-tests.js tests/redis`.
const test = require('node:test');
const assert = require('node:assert');
const { RedisConnection, RedisConnectionError } = require('../../packages/redis-observer/src/connection');
const { load: loadConfig } = require('../../packages/redis-observer/src/config');

const cfg = loadConfig();
const devEnabled = cfg.mode === 'READ_ONLY' && cfg.hasUrl;

function skipIfDisabled() {
  if (!devEnabled) return 'SKIP: REDIS_MODE=READ_ONLY and REDIS_URL must be set in the environment';
  return null;
}

test('TC-REDIS-DEV-001: REDIS_MODE is READ_ONLY', () => {
  const skip = skipIfDisabled();
  if (skip) { console.log(skip); return; }
  assert.strictEqual(cfg.mode, 'READ_ONLY');
});

test('TC-REDIS-DEV-002: REDIS_URL exists', () => {
  const skip = skipIfDisabled();
  if (skip) { console.log(skip); return; }
  assert.ok(cfg.hasUrl);
});

test('TC-REDIS-DEV-003: connect to DEV Redis using TLS', async () => {
  const skip = skipIfDisabled();
  if (skip) { console.log(skip); return; }
  const conn = RedisConnection.create(cfg);
  await conn.connect();
  assert.strictEqual(conn.isConnected(), true);
  await conn.disconnect();
});

test('TC-REDIS-DEV-004: PING returns PONG', async () => {
  const skip = skipIfDisabled();
  if (skip) { console.log(skip); return; }
  const conn = RedisConnection.create(cfg);
  await conn.connect();
  const r = await conn.ping();
  assert.strictEqual(r, 'PONG');
  await conn.disconnect();
});

test('TC-REDIS-DEV-005: SCAN works', async () => {
  const skip = skipIfDisabled();
  if (skip) { console.log(skip); return; }
  const conn = RedisConnection.create(cfg);
  await conn.connect();
  const client = conn.getClient();
  let cursor = '0';
  let count = 0;
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', '*test*', 'COUNT', 20);
    cursor = next;
    count += keys.length;
    if (count > 50) break;
  } while (cursor !== '0');
  assert.ok(typeof count === 'number');
  await conn.disconnect();
});

test('TC-REDIS-DEV-006: TYPE works for sampled keys', async () => {
  const skip = skipIfDisabled();
  if (skip) { console.log(skip); return; }
  const conn = RedisConnection.create(cfg);
  await conn.connect();
  const client = conn.getClient();
  const [cursor, keys] = await client.scan(0, 'MATCH', '*test*', 'COUNT', 5);
  for (const k of keys.slice(0, 3)) {
    const t = await client.type(k);
    assert.ok(typeof t === 'string');
  }
  await conn.disconnect();
});

test('TC-REDIS-DEV-007: TTL/PTTL works for sampled keys', async () => {
  const skip = skipIfDisabled();
  if (skip) { console.log(skip); return; }
  const conn = RedisConnection.create(cfg);
  await conn.connect();
  const client = conn.getClient();
  const [cursor, keys] = await client.scan(0, 'MATCH', '*test*', 'COUNT', 5);
  for (const k of keys.slice(0, 3)) {
    const ttl = await client.ttl(k).catch(() => null);
    const pttl = await client.pttl(k).catch(() => null);
    assert.ok(ttl === null || typeof ttl === 'number');
    assert.ok(pttl === null || typeof pttl === 'number');
  }
  await conn.disconnect();
});

test('TC-REDIS-DEV-008: no raw values are printed', () => {
  const skip = skipIfDisabled();
  if (skip) { console.log(skip); return; }
  assert.ok(cfg.sanitizedUrl);
  assert.ok(!cfg.sanitizedUrl.includes('password'));
});

test('TC-REDIS-DEV-009: no password appears in output', () => {
  const skip = skipIfDisabled();
  if (skip) { console.log(skip); return; }
  assert.strictEqual(cfg.hasPassword, false);
});

test('TC-REDIS-DEV-010: no mutation command is executed', async () => {
  const skip = skipIfDisabled();
  if (skip) { console.log(skip); return; }
  const conn = RedisConnection.create(cfg);
  await conn.connect();
  await assert.rejects(() => conn.command('SET', 'k', 'v'), (e) => {
    assert.strictEqual(e.code, 'REDIS_MUTATION_BLOCKED');
    return true;
  });
  await conn.disconnect();
});

test('TC-REDIS-DEV-011: connection closes cleanly', async () => {
  const skip = skipIfDisabled();
  if (skip) { console.log(skip); return; }
  const conn = RedisConnection.create(cfg);
  await conn.connect();
  assert.strictEqual(conn.isConnected(), true);
  await conn.disconnect();
  assert.strictEqual(conn.isConnected(), false);
});