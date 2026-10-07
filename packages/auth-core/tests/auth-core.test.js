'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AuthManager, Session, AuthStateError } = require('../src');
const { MockAuthAdapter, createMockAuthAdapter } = require('@atf/adapters');
const { TenantRegistry } = require('@atf/tenant-core');

function setup() {
  const reg = new TenantRegistry();
  const tA = reg.createTenant({ id: 'ten_a' });
  const a1 = reg.createActor('ten_a', { id: 'act_a1', label: 'A1' });
  const a2 = reg.createActor('ten_a', { id: 'act_a2', label: 'A2' });
  const tB = reg.createTenant({ id: 'ten_b' });
  const b1 = reg.createActor('ten_b', { id: 'act_b1', label: 'B1' });
  return { reg, tA, a1, a2, tB, b1 };
}

test('auth-core: login creates authenticated session', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session, accessToken } = await mgr.login(tA, a1, { password: 'secret' });
  assert.ok(session.id.startsWith('sess_'));
  assert.strictEqual(session.state, 'authenticated');
  assert.strictEqual(session.tenantId, 'ten_a');
  assert.strictEqual(session.actorId, 'act_a1');
  assert.ok(accessToken.startsWith('at_'));
  assert.strictEqual(await mgr.isAuthenticated(session), true);
});

test('auth-core: unauthenticated state before login', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const session = new Session({ id: 'sess_pending', tenantId: tA.id, actorId: a1.id });
  const state = await mgr.getSessionState(session);
  assert.strictEqual(state.authenticated, false);
  assert.strictEqual(await mgr.isAuthenticated(session), false);
});

test('auth-core: logout marks session logged-out', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  assert.strictEqual(await mgr.isAuthenticated(session), true);
  await mgr.logout(session);
  assert.strictEqual(session.state, 'logged-out');
  assert.strictEqual(await mgr.isAuthenticated(session), false);
});

test('auth-core: refresh renews access token', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session, accessToken: first } = await mgr.login(tA, a1, { password: 'x' });
  const result = await mgr.refresh(session);
  assert.ok(result.accessToken.startsWith('at_'));
  assert.notStrictEqual(result.accessToken, first);
});

test('auth-core: refresh with rotation invalidates old token', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ rotationEnabled: true });
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const before = await mgr.getAccessToken(session);
  await mgr.refresh(session);
  const after = await mgr.getAccessToken(session);
  assert.notStrictEqual(before, after);
  const state = await mgr.getSessionState(session);
  assert.strictEqual(state.rotated, true);
});

test('auth-core: refresh on logged-out session throws', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  await mgr.logout(session);
  await assert.rejects(() => mgr.refresh(session), /not authenticated/i);
});

test('auth-core: invalid login (missing credentials) throws', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ failLogin: 'MISSING_CREDENTIALS' });
  const mgr = new AuthManager(adapter);
  await assert.rejects(() => mgr.login(tA, a1, {}), /Missing credentials/i);
});

test('auth-core: login without password is rejected by adapter', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  await assert.rejects(() => mgr.login(tA, a1, {}), /Missing credentials/i);
});

test('auth-core: getRefreshTokenState reports presence', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const state = await mgr.getRefreshTokenState(session);
  assert.strictEqual(state.present, true);
  assert.ok(state.fingerprint);
});

test('auth-core: clearSession removes session', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  assert.ok(mgr.getSession(session.id));
  await mgr.clearSession(session);
  assert.strictEqual(mgr.getSession(session.id), null);
});

test('auth-core: invalid session id rejected', async () => {
  assert.throws(() => new Session({ id: 'bad', tenantId: 'ten_a', actorId: 'act_a1' }), AuthStateError);
});