'use strict';
// Selftest: proves the framework itself works end-to-end without any real target app.
// These are framework self-tests, not target-application tests.
const test = require('node:test');
const assert = require('node:assert');
const { AuthManager } = require('@atf/auth-core');
const { createMockAuthAdapter, createMockTenantAdapter, createMockRedisAdapter, assertAuthAdapter, assertRedisAdapter, assertTenantAdapter } = require('@atf/adapters');
const { TenantRegistry } = require('@atf/tenant-core');
const { runScenario } = require('@atf/lifecycle-engine');
const { RedisObserver } = require('@atf/redis-observer');
const { MockRedisClient } = require('@atf/redis-observer/src/mock-client');
const { diffSnapshots } = require('@atf/state-diff');
const { redact, fingerprint } = require('@atf/token-security');
const { parallelLimit } = require('@atf/concurrency-engine');
const { RESULT } = require('@atf/reporting');

function setup() {
  const reg = new TenantRegistry();
  const tA = reg.createTenant({ id: 'ten_a' });
  const tB = reg.createTenant({ id: 'ten_b' });
  const a1 = reg.createActor('ten_a', { id: 'act_a1' });
  const b1 = reg.createActor('ten_b', { id: 'act_b1' });
  return { reg, tA, tB, a1, b1 };
}

test('selftest: adapters satisfy contracts', () => {
  assert.doesNotThrow(() => assertAuthAdapter(createMockAuthAdapter()));
  assert.doesNotThrow(() => assertRedisAdapter(createMockRedisAdapter()));
  assert.doesNotThrow(() => assertTenantAdapter(createMockTenantAdapter({ tenants: [{ id: 'ten_x' }] })));
});

test('selftest: login flow works end-to-end', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  assert.strictEqual(await mgr.isAuthenticated(session), true);
  await mgr.logout(session);
  assert.strictEqual(await mgr.isAuthenticated(session), false);
});

test('selftest: refresh + rotation', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ rotationEnabled: true });
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const before = await mgr.getAccessToken(session);
  await mgr.refresh(session);
  const after = await mgr.getAccessToken(session);
  assert.notStrictEqual(before, after);
});

test('selftest: snapshot + diff', async () => {
  const obs = new RedisObserver(new MockRedisClient());
  await obs.client.set('a', '1');
  const before = await obs.snapshot();
  await obs.client.set('b', '2');
  const after = await obs.snapshot();
  const diff = diffSnapshots(before, after);
  assert.ok(diff.added.includes('b'));
});

test('selftest: TTL validation', async () => {
  const obs = new RedisObserver(new MockRedisClient());
  await obs.client.set('k', 'v');
  await obs.client.expire('k', 3600);
  const r = await obs.validateTtl('k', 3600, 2000);
  assert.strictEqual(r.ok, true);
});

test('selftest: tenant isolation', async () => {
  const { tA, tB, a1, b1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const redis = createMockRedisAdapter({ allowMutations: true });
  redis.withTenantContext('ten_b', 'sess-b1');
  await redis.hset('sess:b1', 'user', 'bob');
  const evidence = await runScenario({
    scenarioId: 'selftest-iso',
    tenant: tA, actor: a1, action: 'login', redisAdapter: redis,
    assertions: [], otherTenants: ['ten_b'],
    action: async () => {
      redis.withTenantContext('ten_a', 'sess-a1');
      await redis.hset('sess:a1', 'user', 'alice');
    },
  });
  assert.strictEqual(evidence.tenantIsolationResult.result, 'PASS');
  assert.strictEqual(evidence.status, RESULT.PASS);
});

test('selftest: cross-tenant contamination detected', async () => {
  const { tA, tB, a1, b1 } = setup();
  const redis = createMockRedisAdapter({ allowMutations: true });
  redis.withTenantContext('ten_b', 'sess-b1');
  await redis.hset('sess:b1', 'user', 'bob');
  const evidence = await runScenario({
    scenarioId: 'selftest-contam',
    tenant: tA, actor: a1, action: 'login', redisAdapter: redis,
    assertions: [], otherTenants: ['ten_b'],
    action: async () => {
      redis.withTenantContext('ten_b', 'sess-b1');
      await redis.hset('sess:b1', 'user', 'bob-changed');
    },
  });
  assert.strictEqual(evidence.tenantIsolationResult.result, 'FAIL');
});

test('selftest: concurrency — 4 concurrent refreshes', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ rotationEnabled: true });
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const results = await parallelLimit(
    Array.from({ length: 4 }, () => () => mgr.refresh(session)),
    4
  );
  assert.strictEqual(results.length, 4);
  assert.strictEqual(await mgr.isAuthenticated(session), true);
});

test('selftest: redaction — raw token never in evidence', () => {
  const token = 'at_very-secret-token-1234567890';
  const evidence = { accessToken: token, user: 'u1' };
  const redacted = redact(evidence);
  assert.ok(!JSON.stringify(redacted).includes(token));
  assert.strictEqual(redacted.accessToken, `[TOKEN:${fingerprint(token)}]`);
});

test('selftest: cleanup — only test-owned resources are tracked', async () => {
  const redis = createMockRedisAdapter({ allowMutations: true });
  await redis.set('owned:1', 'v');
  redis.trackKey('owned:1');
  assert.ok(redis.ownedKeys().includes('owned:1'));
});

test('selftest: session isolation — logout A leaves B valid', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const s1 = (await mgr.login(tA, a1, { password: 'x' })).session;
  const s2 = (await mgr.login(tA, a1, { password: 'x' })).session;
  await mgr.logout(s1);
  assert.strictEqual(await mgr.isAuthenticated(s1), false);
  assert.strictEqual(await mgr.isAuthenticated(s2), true);
});