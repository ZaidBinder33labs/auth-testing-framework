'use strict';
// Authentication lifecycle tests against the mock adapter.
const test = require('node:test');
const assert = require('node:assert');
const { AuthManager } = require('@atf/auth-core');
const { createMockAuthAdapter } = require('@atf/adapters');
const { TenantRegistry } = require('@atf/tenant-core');
const { runScenario } = require('@atf/lifecycle-engine');
const { createMockRedisAdapter } = require('@atf/adapters');
const { RESULT } = require('@atf/reporting');

function setup() {
  const reg = new TenantRegistry();
  const tA = reg.createTenant({ id: 'ten_a' });
  const a1 = reg.createActor('ten_a', { id: 'act_a1', label: 'A1' });
  const a2 = reg.createActor('ten_a', { id: 'act_a2', label: 'A2' });
  return { reg, tA, a1, a2 };
}

test('login: valid login creates session and Redis state', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const redis = createMockRedisAdapter({ allowMutations: true });
  await redis.hset('sess:pre', 'k', 'v');
  const evidence = await runScenario({
    scenarioId: 'login-valid',
    tenant: tA, actor: a1, action: 'login', redisAdapter: redis, assertions: [],
    action: async () => {
      await mgr.login(tA, a1, { password: 'secret' });
      redis.withTenantContext(tA.id, 'sess:created');
      await redis.hset('sess:created', 'user', 'alice');
    },
  });
  assert.strictEqual(evidence.status, RESULT.PASS);
  assert.ok(evidence.redisDiff.added.includes('sess:created'));
});

test('login: invalid password throws', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ failLogin: 'INVALID_CREDENTIALS' });
  const mgr = new AuthManager(adapter);
  await assert.rejects(() => mgr.login(tA, a1, { password: 'wrong' }), /invalid credentials/i);
});

test('login: missing credentials throws', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  await assert.rejects(() => mgr.login(tA, a1, {}), /missing credentials/i);
});

test('login: access token usable after login', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const token = await mgr.getAccessToken(session);
  assert.ok(token.startsWith('at_'));
  assert.strictEqual(await mgr.isAuthenticated(session), true);
});

test('login: refresh state created', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const state = await mgr.getRefreshTokenState(session);
  assert.strictEqual(state.present, true);
  assert.ok(state.fingerprint);
});

test('login: tenant association recorded on session', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  assert.strictEqual(session.tenantId, 'ten_a');
  assert.strictEqual(session.actorId, 'act_a1');
});

test('login: expected TTL on session', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  assert.strictEqual(session.expiresIn, 3600);
});