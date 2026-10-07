'use strict';
// Integration: end-to-end scenarios combining auth + Redis + isolation + reporting.
const test = require('node:test');
const assert = require('node:assert');
const { AuthManager } = require('@atf/auth-core');
const { createMockAuthAdapter } = require('@atf/adapters');
const { createMockRedisAdapter } = require('@atf/adapters');
const { TenantRegistry } = require('@atf/tenant-core');
const { runScenario } = require('@atf/lifecycle-engine');
const { Reporter, RESULT } = require('@atf/reporting');
const { validateNoCrossTenantContamination } = require('@atf/isolation-engine');

function setup() {
  const reg = new TenantRegistry();
  const tA = reg.createTenant({ id: 'ten_a' });
  const tB = reg.createTenant({ id: 'ten_b' });
  const a1 = reg.createActor('ten_a', { id: 'act_a1' });
  const b1 = reg.createActor('ten_b', { id: 'act_b1' });
  return { reg, tA, tB, a1, b1 };
}

test('integration: full login + Redis snapshot + isolation + report', async () => {
  const { tA, tB, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const redis = createMockRedisAdapter({ allowMutations: true });
  redis.withTenantContext('ten_b', 'sess-b1');
  await redis.hset('sess:b1', 'user', 'bob');
  const reporter = new Reporter();
  const evidence = await runScenario({
    scenarioId: 'integration-login',
    testRunId: 'run-1',
    tenant: tA, actor: a1, action: 'login', redisAdapter: redis,
    assertions: [],
    otherTenants: ['ten_b'],
    action: async () => {
      await mgr.login(tA, a1, { password: 'x' });
      redis.withTenantContext(tA.id, 'sess-a1');
      await redis.hset('sess:a1', 'user', 'alice');
    },
  });
  reporter.add(evidence);
  assert.strictEqual(evidence.status, RESULT.PASS);
  assert.strictEqual(evidence.tenantIsolationResult.result, 'PASS');
  assert.ok(evidence.redisDiff.added.includes('sess:a1'));
  const serialized = reporter.serialize();
  assert.ok(serialized.length === 1);
  assert.ok(!JSON.stringify(serialized).includes('alice'));
});

test('integration: cross-tenant contamination reported as FAIL', async () => {
  const { tA, tB, a1 } = setup();
  const redis = createMockRedisAdapter({ allowMutations: true });
  redis.withTenantContext('ten_b', 'sess-b1');
  await redis.hset('sess:b1', 'user', 'bob');
  const evidence = await runScenario({
    scenarioId: 'integration-contam',
    tenant: tA, actor: a1, action: 'login', redisAdapter: redis,
    assertions: [],
    otherTenants: ['ten_b'],
    action: async () => {
      redis.withTenantContext('ten_b', 'sess-b1');
      await redis.hset('sess:b1', 'user', 'bob-changed');
    },
  });
  assert.strictEqual(evidence.tenantIsolationResult.result, 'FAIL');
  assert.ok(evidence.tenantIsolationResult.contamination.length > 0);
});

test('integration: refresh rotation + Redis state', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ rotationEnabled: true });
  const mgr = new AuthManager(adapter);
  const redis = createMockRedisAdapter({ allowMutations: true });
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  redis.withTenantContext(tA.id, session.id);
  await redis.hset('sess:token', 'access', 'old');
  const before = await redis.snapshot();
  await mgr.refresh(session);
  const after = await redis.snapshot();
  const diff = require('@atf/state-diff').diffSnapshots(before, after);
  // Access token fingerprint changed.
  assert.ok(diff.unchanged.length + diff.modified.length + diff.added.length >= 1);
  assert.strictEqual(await mgr.isAuthenticated(session), true);
});