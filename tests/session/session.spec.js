'use strict';
// Session tests: creation, persistence, isolation, multiple sessions.
const test = require('node:test');
const assert = require('node:assert');
const { AuthManager, Session } = require('@atf/auth-core');
const { createMockAuthAdapter } = require('@atf/adapters');
const { TenantRegistry } = require('@atf/tenant-core');

function setup() {
  const reg = new TenantRegistry();
  const tA = reg.createTenant({ id: 'ten_a' });
  const a1 = reg.createActor('ten_a', { id: 'act_a1' });
  const a2 = reg.createActor('ten_a', { id: 'act_a2' });
  return { reg, tA, a1, a2 };
}

test('session: creation produces authenticated session', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  assert.strictEqual(session.state, 'authenticated');
  assert.ok(session.id.startsWith('sess_'));
});

test('session: multiple sessions for same actor', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const s1 = (await mgr.login(tA, a1, { password: 'x' })).session;
  const s2 = (await mgr.login(tA, a1, { password: 'x' })).session;
  assert.notStrictEqual(s1.id, s2.id);
  assert.strictEqual(mgr.listSessions().length, 2);
});

test('session: session-specific logout leaves other sessions valid', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const s1 = (await mgr.login(tA, a1, { password: 'x' })).session;
  const s2 = (await mgr.login(tA, a1, { password: 'x' })).session;
  await mgr.logout(s1);
  assert.strictEqual(await mgr.isAuthenticated(s1), false);
  assert.strictEqual(await mgr.isAuthenticated(s2), true);
});

test('session: session isolation — logout A leaves B valid', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const s1 = (await mgr.login(tA, a1, { password: 'x' })).session;
  const s2 = (await mgr.login(tA, a1, { password: 'x' })).session;
  await mgr.logout(s1);
  assert.strictEqual(await mgr.isAuthenticated(s2), true);
});

test('session: clearSession removes from registry', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  await mgr.clearSession(session);
  assert.strictEqual(mgr.getSession(session.id), null);
});

test('session: invalid session id rejected', async () => {
  assert.throws(() => new Session({ id: 'bad', tenantId: 'ten_a', actorId: 'act_a1' }), Error);
});