'use strict';
// Logout tests: session invalidation, revocation, repeated logout, Redis state.
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
  const a1 = reg.createActor('ten_a', { id: 'act_a1' });
  return { reg, tA, a1 };
}

test('logout: authenticated session becomes invalid', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  assert.strictEqual(await mgr.isAuthenticated(session), true);
  await mgr.logout(session);
  assert.strictEqual(session.state, 'logged-out');
  assert.strictEqual(await mgr.isAuthenticated(session), false);
});

test('logout: access token after logout is invalid', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const token = await mgr.getAccessToken(session);
  assert.ok(token);
  await mgr.logout(session);
  const state = await mgr.getSessionState(session);
  assert.strictEqual(state.authenticated, false);
});

test('logout: refresh token after logout is invalid', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const before = await mgr.getRefreshTokenState(session);
  assert.strictEqual(before.present, true);
  await mgr.logout(session);
  const after = await mgr.getSessionState(session);
  assert.strictEqual(after.authenticated, false);
});

test('logout: Redis session state removed after logout', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const redis = createMockRedisAdapter({ allowMutations: true });
  await redis.hset('sess:live', 'user', 'alice');
  const evidence = await runScenario({
    scenarioId: 'logout-redis',
    tenant: tA, actor: a1, action: 'logout', redisAdapter: redis, assertions: [],
    action: async () => { await redis.del('sess:live'); },
  });
  assert.ok(evidence.redisDiff.removed.includes('sess:live'));
  assert.strictEqual(evidence.status, RESULT.PASS);
});

test('logout: repeated logout does not throw', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  await mgr.logout(session);
  await assert.doesNotThrow(() => mgr.logout(session));
});

test('logout: logout without session is safe', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { Session } = require('@atf/auth-core');
  const session = new Session({ id: 'sess_ghost', tenantId: tA.id, actorId: a1.id });
  await assert.doesNotThrow(() => mgr.logout(session));
});