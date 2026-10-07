'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runScenario } = require('../src');
const { createMockRedisAdapter } = require('@atf/adapters');
const { RESULT } = require('@atf/reporting');

test('lifecycle: scenario captures BEFORE/AFTER and diff', async () => {
  const redis = createMockRedisAdapter({ allowMutations: true });
  await redis.hset('sess:1', 'user', 'alice');
  let actionRan = false;
  const evidence = await runScenario({
    scenarioId: 'login-1',
    tenant: { id: 'ten_a' },
    actor: { id: 'act_a1' },
    action: 'login',
    redisAdapter: redis,
    assertions: [],
    action: async () => { actionRan = true; await redis.hset('sess:1', 'token', 'abc'); },
  });
  assert.strictEqual(actionRan, true);
  assert.ok(evidence.beforeSummary.keyCount >= 1);
  assert.ok(evidence.afterSummary.keyCount >= 1);
  assert.ok(evidence.redisDiff);
  assert.strictEqual(evidence.status, RESULT.PASS);
});

test('lifecycle: scenario detects ADDED key', async () => {
  const redis = createMockRedisAdapter({ allowMutations: true });
  await redis.set('existing', 'v');
  const evidence = await runScenario({
    scenarioId: 'add-1',
    tenant: { id: 'ten_a' },
    actor: { id: 'act_a1' },
    action: 'create',
    redisAdapter: redis,
    assertions: [],
    action: async () => { await redis.set('new-key', 'val'); },
  });
  assert.ok(evidence.redisDiff.added.includes('new-key'));
});

test('lifecycle: scenario detects MODIFIED key', async () => {
  const redis = createMockRedisAdapter({ allowMutations: true });
  await redis.set('k', 'v1');
  const evidence = await runScenario({
    scenarioId: 'mod-1',
    tenant: { id: 'ten_a' },
    actor: { id: 'act_a1' },
    action: 'update',
    redisAdapter: redis,
    assertions: [],
    action: async () => { await redis.set('k', 'v2'); },
  });
  assert.ok(evidence.redisDiff.modified.includes('k'));
});

test('lifecycle: scenario detects REMOVED key', async () => {
  const redis = createMockRedisAdapter({ allowMutations: true });
  await redis.set('k', 'v');
  const evidence = await runScenario({
    scenarioId: 'del-1',
    tenant: { id: 'ten_a' },
    actor: { id: 'act_a1' },
    action: 'delete',
    redisAdapter: redis,
    assertions: [],
    action: async () => { await redis.del('k'); },
  });
  assert.ok(evidence.redisDiff.removed.includes('k'));
});

test('lifecycle: scenario assertion failure marks FAIL', async () => {
  const redis = createMockRedisAdapter({ allowMutations: true });
  const evidence = await runScenario({
    scenarioId: 'fail-1',
    tenant: { id: 'ten_a' },
    actor: { id: 'act_a1' },
    action: 'noop',
    redisAdapter: redis,
    assertions: [
      async () => ({ ok: false, detail: 'expected session to exist' }),
    ],
    action: async () => {},
  });
  assert.strictEqual(evidence.status, RESULT.FAIL);
  assert.ok(evidence.securityAssertions.some((a) => a.ok === false));
});

test('lifecycle: scenario tenant isolation PASS when other tenants unchanged', async () => {
  const redis = createMockRedisAdapter({ allowMutations: true });
  redis.withTenantContext('ten_b', 'sess-b1');
  await redis.hset('sess:b1', 'user', 'bob');
  const evidence = await runScenario({
    scenarioId: 'iso-1',
    tenant: { id: 'ten_a' },
    actor: { id: 'act_a1' },
    action: 'login',
    redisAdapter: redis,
    assertions: [],
    otherTenants: ['ten_b'],
    action: async () => {
      redis.withTenantContext('ten_a', 'sess-a1');
      await redis.hset('sess:a1', 'user', 'alice');
    },
  });
  assert.strictEqual(evidence.tenantIsolationResult.result, 'PASS');
});

test('lifecycle: scenario tenant isolation FAIL when other tenant changes', async () => {
  const redis = createMockRedisAdapter({ allowMutations: true });
  redis.withTenantContext('ten_b', 'sess-b1');
  await redis.hset('sess:b1', 'user', 'bob');
  const evidence = await runScenario({
    scenarioId: 'iso-2',
    tenant: { id: 'ten_a' },
    actor: { id: 'act_a1' },
    action: 'login',
    redisAdapter: redis,
    assertions: [],
    otherTenants: ['ten_b'],
    action: async () => {
      redis.withTenantContext('ten_b', 'sess-b1');
      await redis.hset('sess:b1', 'user', 'bob-changed');
    },
  });
  assert.strictEqual(evidence.tenantIsolationResult.result, 'FAIL');
});