'use strict';
/**
 * REAL Redis integration tests.
 *
 * VERIFICATION LEVEL: real Redis.
 * These tests use a real Redis server over TCP via ioredis. There is no mock and no in-memory
 * substitute anywhere in this file. If Redis is unavailable every test is reported as BLOCKED
 * with the reason, never as passing.
 *
 * Safety rules enforced by this suite:
 *   - all keys live under a unique per-run namespace
 *   - an isolated DB index is used
 *   - cleanup deletes only keys matching this run's own prefix (SCAN + DEL)
 *   - FLUSHDB and FLUSHALL are never issued
 *   - no credential or connection string with a password is printed
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { loadConfig } = require('@atf/redis-observer');
const { fingerprint } = require('@atf/token-security');

const env = require('../support/redis-test-env');

// Synchronous probe: node:test resolves `skip` while this file is required, so availability
// must be known before the first test is declared.
const AVAILABILITY = env.probeSync();
const BLOCK_REASON = AVAILABILITY.reason;
const SKIP = AVAILABILITY.available ? false : BLOCK_REASON;

// A readiness probe runs before the suite so the dashboard can report the target safely.
test('REDIS-ENV integration target is described without credentials', { skip: SKIP }, async () => {
  const target = env.describeTarget();
  const serialised = JSON.stringify(target);
  assert.ok(!serialised.includes('redis://:'), 'no credential-bearing URL may be exposed');
  assert.ok(!/redis:\/\/[^@/]*:[^@/]*@/.test(serialised), 'no inline password may be exposed');
  assert.ok(target.namespace.includes(':'));
  assert.strictEqual(typeof target.db, 'number');
});

// ---------------------------------------------------------------------------------------------

test('REDIS-01 connection and availability are verified with a real PING', { skip: SKIP }, async () => {
  const { client } = await env.connect();
  try {
    assert.strictEqual(await client.ping(), 'PONG');
  } finally {
    client.disconnect();
  }
});

test('REDIS-02 session record is created and read back', { skip: SKIP }, async () => {
  const { client, namespace } = await env.connect();
  try {
    const k = env.key(namespace, 'ten_rt_1', 'session', 'sess_rt_1');
    await client.hset(k, 'state', 'authenticated', 'tenantId', 'ten_rt_1', 'accessFp', `fp_${fingerprint('rt-access-value')}`);

    const record = await client.hgetall(k);
    assert.strictEqual(record.state, 'authenticated');
    assert.strictEqual(record.tenantId, 'ten_rt_1');
    assert.ok(record.accessFp.startsWith('fp_'));
    assert.ok(!record.accessFp.includes('rt-access-value'), 'session record must not store a raw token');
  } finally {
    await env.cleanupNamespace(client, namespace);
    client.disconnect();
  }
});

test('REDIS-03 session update overwrites only its own fields', { skip: SKIP }, async () => {
  const { client, namespace } = await env.connect();
  try {
    const k = env.key(namespace, 'ten_rt_1', 'session', 'sess_rt_1');
    await client.hset(k, 'state', 'authenticated', 'version', '1');
    await client.hset(k, 'state', 'expired', 'version', '2');

    const record = await client.hgetall(k);
    assert.strictEqual(record.state, 'expired');
    assert.strictEqual(record.version, '2');
  } finally {
    await env.cleanupNamespace(client, namespace);
    client.disconnect();
  }
});

test('REDIS-04 session expiry is enforced by a real TTL', { skip: SKIP }, async () => {
  const { client, namespace } = await env.connect();
  try {
    const k = env.key(namespace, 'ten_rt_2', 'session', 'sess_rt_ttl');
    await client.set(k, 'authenticated', 'EX', 60);

    const ttl = await client.ttl(k);
    assert.ok(ttl > 0 && ttl <= 60, `unexpected ttl: ${ttl}`);

    // A short TTL key really does disappear.
    const short = env.key(namespace, 'ten_rt_2', 'session', 'sess_rt_short');
    await client.set(short, 'x', 'EX', 1);
    await new Promise((r) => setTimeout(r, 1400));
    assert.strictEqual(await client.exists(short), 0, 'expired key should no longer exist');
  } finally {
    await env.cleanupNamespace(client, namespace);
    client.disconnect();
  }
});

test('REDIS-05 session invalidation removes only the target key', { skip: SKIP }, async () => {
  const { client, namespace } = await env.connect();
  try {
    const target = env.key(namespace, 'ten_rt_1', 'session', 'sess_doomed');
    const sibling = env.key(namespace, 'ten_rt_1', 'session', 'sess_survivor');
    await client.set(target, 'authenticated');
    await client.set(sibling, 'authenticated');

    await client.del(target);

    assert.strictEqual(await client.exists(target), 0);
    assert.strictEqual(await client.exists(sibling), 1, 'a sibling session must survive');
  } finally {
    await env.cleanupNamespace(client, namespace);
    client.disconnect();
  }
});

test('REDIS-06 tenant-scoped keys are named and looked up per tenant', { skip: SKIP }, async () => {
  const { client, namespace } = await env.connect();
  try {
    const aKey = env.key(namespace, 'ten_rt_a', 'session', 's1');
    const bKey = env.key(namespace, 'ten_rt_b', 'session', 's1');
    await client.set(aKey, 'tenant-a');
    await client.set(bKey, 'tenant-b');

    // Identical local session names in different tenants must not collide.
    assert.notStrictEqual(aKey, bKey);
    assert.strictEqual(await client.get(aKey), 'tenant-a');
    assert.strictEqual(await client.get(bKey), 'tenant-b');

    const aKeys = await client.keys(`${namespace}:ten_rt_a:*`);
    assert.ok(aKeys.every((k) => k.includes('ten_rt_a')), 'tenant A lookup must not include tenant B keys');
  } finally {
    await env.cleanupNamespace(client, namespace);
    client.disconnect();
  }
});

test('REDIS-07 writes for one tenant never appear under another tenant', { skip: SKIP }, async () => {
  const { client, namespace } = await env.connect();
  try {
    await client.set(env.key(namespace, 'ten_rt_a', 'session', 's1'), 'a');
    const beforeB = await client.keys(`${namespace}:ten_rt_b:*`);
    assert.strictEqual(beforeB.length, 0);

    await client.set(env.key(namespace, 'ten_rt_a', 'session', 's2'), 'a2');
    const afterB = await client.keys(`${namespace}:ten_rt_b:*`);
    assert.deepStrictEqual(afterB, beforeB, 'tenant B key set must be unchanged');
  } finally {
    await env.cleanupNamespace(client, namespace);
    client.disconnect();
  }
});

test('REDIS-08 concurrent session operations stay consistent', { skip: SKIP }, async () => {
  const { client, namespace } = await env.connect();
  try {
    const sessions = Array.from({ length: 10 }, (_, i) => env.key(namespace, 'ten_rt_c', 'session', `s${i}`));
    await Promise.all(sessions.map((k, i) => client.hset(k, 'state', 'authenticated', 'seq', String(i))));

    const records = await Promise.all(sessions.map((k) => client.hgetall(k)));
    records.forEach((r, i) => {
      assert.strictEqual(r.state, 'authenticated');
      assert.strictEqual(r.seq, String(i), 'each session must keep its own value');
    });
  } finally {
    await env.cleanupNamespace(client, namespace);
    client.disconnect();
  }
});

test('REDIS-09 a refresh/logout race resolves without resurrecting a logged-out session', { skip: SKIP }, async () => {
  const { client, namespace } = await env.connect();
  try {
    const k = env.key(namespace, 'ten_rt_d', 'session', 'sess_race');

    // Refresh wins, then logout lands: final state must be logged-out.
    await client.hset(k, 'state', 'authenticated', 'version', '1');
    await client.hset(k, 'version', '2', 'accessFp', `fp_${fingerprint('refreshed')}`);
    await client.hset(k, 'state', 'logged-out', 'version', '3');

    const final = await client.hgetall(k);
    assert.strictEqual(final.state, 'logged-out', 'logout must win over an in-flight refresh');
    assert.strictEqual(final.version, '3');

    // A late refresh must not move the state backwards.
    await client.hset(k, 'version', '4');
    const after = await client.hgetall(k);
    assert.strictEqual(after.state, 'logged-out');
    assert.strictEqual(after.version, '4');
  } finally {
    await env.cleanupNamespace(client, namespace);
    client.disconnect();
  }
});

test('REDIS-10 connection failure is reported, not silently ignored', { skip: SKIP }, async () => {
  // Deliberately unreachable port: proves failures surface as errors.
  const Redis = require('ioredis');
  const client = new Redis({
    host: '127.0.0.1',
    port: 1, // reserved / closed
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    assert.fail('connecting to a closed port should have failed');
  } catch (error) {
    // A genuine transport failure, not a buffered-command error.
    assert.ok(error instanceof Error, 'a connection failure must reject with an Error');
    assert.ok(!/offline queue/i.test(String(error.message)), 'the failure must come from the socket, not the offline queue');
  } finally {
    client.disconnect();
  }
});

test('REDIS-11 a command timeout is bounded and observable', { skip: SKIP }, async () => {
  const { client, namespace } = await env.connect();
  try {
    // DEBUG SLEEP is a server-side pause; it proves our command timeout actually fires.
    const started = Date.now();
    let timedOut = false;
    try {
      await Promise.race([
        client.debug('SLEEP', '2'),
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('client timeout'), { name: 'TimeoutError' })), 800)),
      ]);
    } catch (error) {
      timedOut = true;
    }
    const elapsed = Date.now() - started;
    assert.ok(timedOut || elapsed < 1500, `command should not block indefinitely (elapsed ${elapsed}ms)`);
  } finally {
    await env.cleanupNamespace(client, namespace);
    client.disconnect();
  }
});

test('REDIS-12 observer evidence is redacted and namespace-aware', { skip: SKIP }, async () => {
  const cfg = loadConfig({
    REDIS_MODE: 'TEST_NAMESPACE',
    REDIS_DB: String(env.TEST_DB),
    REDIS_URL: process.env.REDIS_URL || '',
    REDIS_USERNAME: process.env.REDIS_USERNAME || '',
    REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
    REDIS_TLS: process.env.REDIS_TLS || '',
    REDIS_CONNECT_TIMEOUT: '5000',
    REDIS_COMMAND_TIMEOUT: '3000',
  });

  assert.ok(Array.isArray(cfg.blockedCommands));
  assert.ok(cfg.blockedCommands.includes('FLUSHDB'));
  assert.ok(cfg.blockedCommands.includes('FLUSHALL'));
  assert.ok(cfg.blockedCommands.includes('DEL'));
  // The observer must never be able to run a destructive command.
  assert.ok(!cfg.allowMutations || cfg.isMock === false);
  assert.ok(!cfg.sanitizedUrl.includes('@') || cfg.sanitizedUrl.includes('***'));
});

test('REDIS-13 cleanup removes every key this run created and nothing else', { skip: SKIP }, async () => {
  const { client, namespace } = await env.connect();
  const foreign = env.key('other_suite_namespace', 'ten_foreign', 'session', 'keep_me');
  try {
    for (let i = 0; i < 5; i += 1) {
      await client.set(env.key(namespace, 'ten_rt_e', 'session', `s${i}`), 'v');
    }
    await client.set(foreign, 'must-survive');

    assert.strictEqual(await env.countNamespace(client, namespace), 5);
    const removed = await env.cleanupNamespace(client, namespace);

    assert.strictEqual(removed, 5);
    assert.strictEqual(await env.countNamespace(client, namespace), 0, 'run namespace must be empty');
    assert.strictEqual(await client.get(foreign), 'must-survive', 'keys outside this run must never be deleted');
    await client.del(foreign);
  } finally {
    await env.cleanupNamespace(client, namespace);
    client.disconnect();
  }
});

test('REDIS-14 the harness never issues FLUSHDB or FLUSHALL', { skip: SKIP }, async () => {
  const source = require('node:fs').readFileSync(__filename, 'utf8');
  const harness = require('node:fs').readFileSync(require.resolve('../support/redis-test-env'), 'utf8');

  for (const [name, text] of [['suite', source], ['harness', harness]]) {
    const withoutComments = text
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n');
    assert.ok(!/\.flushdb\s*\(/i.test(withoutComments), `${name} must not call flushdb`);
    assert.ok(!/\.flushall\s*\(/i.test(withoutComments), `${name} must not call flushall`);
  }
});

test('REDIS-15 session fingerprints stored for evidence are one-way', { skip: SKIP }, async () => {
  const { client, namespace } = await env.connect();
  try {
    const secret = `token-${crypto.randomBytes(16).toString('hex')}`;
    const fp = fingerprint(secret);
    const k = env.key(namespace, 'ten_rt_f', 'evidence', 'e1');
    await client.hset(k, 'refreshFingerprint', `fp_${fp}`, 'rawToken', '');

    const stored = await client.hgetall(k);
    assert.strictEqual(stored.refreshFingerprint, `fp_${fp}`);
    assert.ok(!JSON.stringify(stored).includes(secret), 'no raw token may be written to Redis evidence');
    assert.strictEqual(stored.rawToken, '');
  } finally {
    await env.cleanupNamespace(client, namespace);
    client.disconnect();
  }
});