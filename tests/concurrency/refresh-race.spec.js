'use strict';
// Concurrency tests: refresh races, concurrent login/session, shared lock.
const test = require('node:test');
const assert = require('node:assert');
const { AuthManager } = require('@atf/auth-core');
const { createMockAuthAdapter } = require('@atf/adapters');
const { TenantRegistry } = require('@atf/tenant-core');
const { RefreshLock, parallelLimit } = require('@atf/concurrency-engine');

function setup() {
  const reg = new TenantRegistry();
  const tA = reg.createTenant({ id: 'ten_a' });
  const a1 = reg.createActor('ten_a', { id: 'act_a1' });
  return { reg, tA, a1 };
}

test('concurrency: 4 simultaneous refresh requests', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ rotationEnabled: true });
  const mgr = new AuthManager(adapter, { refreshLock: new RefreshLock({ timeoutMs: 5000 }) });
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const results = await parallelLimit(
    Array.from({ length: 4 }, () => () => mgr.refresh(session)),
    4
  );
  assert.strictEqual(results.length, 4);
  // All refreshes succeeded.
  for (const r of results) assert.ok(r.accessToken.startsWith('at_'));
  // Final state consistent.
  assert.strictEqual(await mgr.isAuthenticated(session), true);
});

test('concurrency: 10 simultaneous refresh requests', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ rotationEnabled: true });
  const mgr = new AuthManager(adapter, { refreshLock: new RefreshLock({ timeoutMs: 10000 }) });
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const results = await parallelLimit(
    Array.from({ length: 10 }, () => () => mgr.refresh(session)),
    10
  );
  assert.strictEqual(results.length, 10);
  assert.strictEqual(await mgr.isAuthenticated(session), true);
});

test('concurrency: shared lock prevents duplicate rotation', async () => {
  const lock = new RefreshLock({ timeoutMs: 3000 });
  let counter = 0;
  const task = async (owner) => lock.withLock('sess:1', owner, async () => {
    counter += 1;
    await new Promise((r) => setTimeout(r, 20));
    return counter;
  });
  const results = await parallelLimit([() => task('a'), () => task('b'), () => task('c')], 3);
  assert.strictEqual(results.length, 3);
  // Lock is released after each.
  assert.strictEqual(lock.isHeld('sess:1'), false);
});

test('concurrency: concurrent login produces distinct sessions', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const results = await parallelLimit(
    Array.from({ length: 5 }, () => () => mgr.login(tA, a1, { password: 'x' })),
    5
  );
  const ids = new Set(results.map((r) => r.session.id));
  assert.strictEqual(ids.size, 5);
});

test('concurrency: lock release on failure', async () => {
  const lock = new RefreshLock();
  await assert.rejects(() => lock.withLock('k', 'o', async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(lock.isHeld('k'), false);
});

test('concurrency: lock timeout handling', async () => {
  const lock = new RefreshLock({ timeoutMs: 50 });
  await lock.acquire('k', 'a');
  const start = Date.now();
  const r = await lock.acquire('k', 'b');
  assert.strictEqual(r.acquired, false);
  assert.strictEqual(r.reason, 'TIMEOUT');
  assert.ok(Date.now() - start >= 40);
  lock.release('k', 'a');
});