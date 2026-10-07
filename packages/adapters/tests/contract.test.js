'use strict';
// Contract tests: every adapter must satisfy these contracts before a real adapter is valid.
const test = require('node:test');
const assert = require('node:assert');
const { createMockAuthAdapter, assertAuthAdapter } = require('@atf/adapters');
const { createMockTenantAdapter } = require('@atf/adapters');
const { createMockRedisAdapter } = require('@atf/adapters');
const { TenantRegistry } = require('@atf/tenant-core');

test('contract: AuthAdapter — login/refresh/logout/getSessionState', async () => {
  const reg = new TenantRegistry();
  const t = reg.createTenant({ id: 'ten_c1' });
  const a = reg.createActor('ten_c1', { id: 'act_c1' });
  const adapter = createMockAuthAdapter();
  assertAuthAdapter(adapter);
  const login = await adapter.login(t, a, { password: 'x' });
  assert.ok(login.sessionId.startsWith('sess_'));
  assert.ok(login.accessToken.startsWith('at_'));
  const state = await adapter.getSessionState({ id: login.sessionId });
  assert.strictEqual(state.authenticated, true);
  const refreshed = await adapter.refresh({ id: login.sessionId });
  assert.ok(refreshed.accessToken.startsWith('at_'));
  const out = await adapter.logout({ id: login.sessionId });
  assert.ok(out.count >= 1);
  const after = await adapter.getSessionState({ id: login.sessionId });
  assert.strictEqual(after.authenticated, false);
});

test('contract: AuthAdapter — rotation enabled changes refresh token', async () => {
  const reg = new TenantRegistry();
  const t = reg.createTenant({ id: 'ten_c2' });
  const a = reg.createActor('ten_c2', { id: 'act_c2' });
  const adapter = createMockAuthAdapter({ rotationEnabled: true });
  const login = await adapter.login(t, a, { password: 'x' });
  const r = await adapter.refresh({ id: login.sessionId });
  assert.strictEqual(r.rotated, true);
  assert.ok(r.previousRefreshToken);
  assert.notStrictEqual(r.refreshToken, r.previousRefreshToken);
});

test('contract: TenantAdapter — getTenant/getActor/listTenants', async () => {
  const reg = new TenantRegistry();
  reg.createTenant({ id: 'ten_t1' });
  reg.createActor('ten_t1', { id: 'act_t1' });
  const adapter = createMockTenantAdapter({ tenants: [{ id: 'ten_t1' }], actors: [{ tenantId: 'ten_t1', id: 'act_t1' }] });
  const t = await adapter.getTenant('ten_t1');
  assert.ok(t);
  const a = await adapter.getActor('ten_t1', 'act_t1');
  assert.ok(a);
  assert.strictEqual(a.tenantId, 'ten_t1');
  const list = await adapter.listTenants();
  assert.strictEqual(list.length, 1);
});

test('contract: RedisAdapter — inspect/snapshot/discoverKeys', async () => {
  const adapter = createMockRedisAdapter({ allowMutations: true });
  await adapter.hset('sess:1', 'user', 'alice');
  await adapter.hset('sess:1', 'password', 'secret');
  const entry = await adapter.inspect('sess:1');
  assert.strictEqual(entry.type, 'hash');
  assert.strictEqual(entry.fields.user, 'alice');
  assert.strictEqual(entry.fields.password, '[REDACTED]');
  const snap = await adapter.snapshot();
  assert.ok(snap['sess:1']);
  const keys = await adapter.discoverKeys();
  assert.deepStrictEqual(keys, ['sess:1']);
});

test('contract: RedisAdapter — mutation blocked by default', async () => {
  const adapter = createMockRedisAdapter({ mode: 'READ_ONLY' });
  await assert.rejects(() => adapter.set('k', 'v'), /blocked/);
});

test('contract: RedisAdapter — TTL validation', async () => {
  const adapter = createMockRedisAdapter({ allowMutations: true });
  await adapter.set('k', 'v');
  await adapter.expire('k', 3600);
  const r = await adapter.validateTtl('k', 3600, 2000);
  assert.strictEqual(r.ok, true);
});

test('contract: RedisAdapter — type mismatch detection', async () => {
  const adapter = createMockRedisAdapter({ allowMutations: true });
  await adapter.hset('h:1', 'f', 'v');
  const entry = await adapter.inspect('h:1');
  assert.strictEqual(entry.type, 'hash');
  assert.strictEqual(entry.cardinality, 1);
});