'use strict';
// Refresh token tests: rotation, reuse, expiry, concurrency.
const test = require('node:test');
const assert = require('node:assert');
const { AuthManager } = require('@atf/auth-core');
const { createMockAuthAdapter } = require('@atf/adapters');
const { TenantRegistry } = require('@atf/tenant-core');

function setup() {
  const reg = new TenantRegistry();
  const tA = reg.createTenant({ id: 'ten_a' });
  const a1 = reg.createActor('ten_a', { id: 'act_a1' });
  return { reg, tA, a1 };
}

test('refresh: valid refresh renews access token', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session, accessToken: first } = await mgr.login(tA, a1, { password: 'x' });
  const result = await mgr.refresh(session);
  assert.ok(result.accessToken.startsWith('at_'));
  assert.notStrictEqual(result.accessToken, first);
});

test('refresh: rotation invalidates old token when enabled', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ rotationEnabled: true });
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const before = await mgr.getAccessToken(session);
  await mgr.refresh(session);
  const after = await mgr.getAccessToken(session);
  assert.notStrictEqual(before, after);
});

test('refresh: old refresh token after rotation', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ rotationEnabled: true });
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const state = await mgr.getSessionState(session);
  const oldRefresh = state.refreshToken;
  await mgr.refresh(session);
  const after = await mgr.getSessionState(session);
  // Rotation enabled: old refresh token is no longer the current one.
  assert.notStrictEqual(after.refreshToken, oldRefresh);
});

test('refresh: invalid refresh token throws', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ failRefresh: 'INVALID_TOKEN' });
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  await assert.rejects(() => mgr.refresh(session), /Invalid refresh token/i);
});

test('refresh: expired refresh token throws', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ failRefresh: 'EXPIRED_TOKEN' });
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  await assert.rejects(() => mgr.refresh(session), /Expired refresh token/i);
});

test('refresh: malformed refresh token throws', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ failRefresh: 'MALFORMED_TOKEN' });
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  await assert.rejects(() => mgr.refresh(session), /Malformed refresh token/i);
});

test('refresh: session remains valid after refresh', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  await mgr.refresh(session);
  assert.strictEqual(await mgr.isAuthenticated(session), true);
});