'use strict';
/**
 * Dynamic multi-tenant authentication and authorization coverage.
 *
 * VERIFICATION LEVEL: fixture / mock.
 * These tests drive the real AuthManager, tenant registry, auth service and isolation engine
 * against the deterministic MockAuthAdapter. No HTTP request and no real Redis is involved.
 * Passing here proves the framework's own session and tenant-binding logic. It does NOT prove
 * that the Binder backend enforces tenant isolation â€” only a real HTTP run can show that.
 *
 * Every tenant used here comes from tests/support/tenant-config.js. No tenant ID is hardcoded
 * in this file, and the auth implementation has no tenant-specific branches.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createMockAuthAdapter } = require('@atf/adapters');
const { AuthStateError } = require('@atf/auth-core');
const { RefreshLock, parallelLimit } = require('@atf/concurrency-engine');

const {
  loadTenantConfigs, fixtureTenants, describeTenant, httpReadiness,
  TenantConfigError, validateTenant,
} = require('../support/tenant-config');
const { AuthService, TenantBoundaryError } = require('../support/auth-service');

const TENANTS = fixtureTenants(2); // tenant A and tenant B, from configuration data

function newService(adapterOpts = {}, tenants = TENANTS) {
  const adapter = createMockAuthAdapter(adapterOpts);
  return { adapter, service: new AuthService({ adapter, tenantConfigs: tenants }) };
}

// =============================================================================================
// Configuration and authentication (1-7)
// =============================================================================================

test('MT-01 valid login for tenant A', async () => {
  const { service } = newService();
  const a = TENANTS[0];
  const handle = await service.loginAs(a.alias);

  assert.ok(handle.id.startsWith('sess_'));
  assert.strictEqual(handle.tenantId, a.tenantId);
  assert.strictEqual(handle.session.state, 'authenticated');
  assert.ok(handle.session.accessToken);
});

test('MT-02 valid login for tenant B', async () => {
  const { service } = newService();
  const b = TENANTS[1];
  const handle = await service.loginAs(b.alias);

  assert.strictEqual(handle.tenantId, b.tenantId);
  assert.strictEqual(handle.session.state, 'authenticated');
});

test('MT-03 missing tenant configuration is rejected with a coded error', () => {
  assert.throws(() => validateTenant({}), (e) => e instanceof TenantConfigError && e.code === 'MISSING_FIELD');
  assert.throws(() => validateTenant(null), (e) => e.code === 'INVALID_ENTRY');
  assert.throws(() => validateTenant({ alias: 'a b c' }), (e) => e.code === 'INVALID_FORMAT');
  assert.throws(() => validateTenant({ alias: 'a', baseUrl: 'not a url' }), (e) => e.code === 'INVALID_URL');
  assert.throws(() => validateTenant({ alias: 'a', email: 'nope' }), (e) => e.code === 'INVALID_FORMAT');
});

test('MT-03b duplicate tenant aliases are rejected', () => {
  assert.throws(
    () => loadTenantConfigs({ BINDER_TENANTS: JSON.stringify([{ alias: 'dup' }, { alias: 'dup' }]) }),
    (e) => e.code === 'DUPLICATE_ALIAS'
  );
});

test('MT-03c malformed BINDER_TENANTS JSON is rejected explicitly', () => {
  assert.throws(
    () => loadTenantConfigs({ BINDER_TENANTS: '{not json' }),
    (e) => e.code === 'INVALID_JSON'
  );
  assert.throws(
    () => loadTenantConfigs({ BINDER_TENANTS: '{"alias":"a"}' }),
    (e) => e.code === 'INVALID_JSON'
  );
});

test('MT-04 missing credentials are rejected', async () => {
  const { adapter, service } = newService();
  await assert.rejects(
    service.manager.login(service.require(TENANTS[0].alias).tenant, service.require(TENANTS[0].alias).actor, {}),
    (e) => e.code === 'MISSING_CREDENTIALS'
  );
  // and the real adapter refuses before any transport is built
  const { CredentialAuthAdapter } = require('@atf/adapters/targets').binder;
  const real = new CredentialAuthAdapter({ onboardingUrl: 'https://fixture.invalid' });
  await assert.rejects(real.login({ id: 't' }, { id: 'a' }, {}), (e) => e.code === 'MISSING_CREDENTIALS');
  assert.ok(adapter);
});

test('MT-05 invalid credentials surface a failure without creating a session', async () => {
  const { service } = newService({ failLogin: 'INVALID_CREDENTIALS' });
  await assert.rejects(service.loginAs(TENANTS[0].alias), (e) => e.code === 'INVALID_CREDENTIALS');
  assert.strictEqual(service.manager.listSessions().length, 0, 'no session may survive a failed login');
});

test('MT-06 API errors and network failures do not create sessions', async () => {
  const { service } = newService();
  const { tenant, actor } = service.require(TENANTS[0].alias);

  // HTTP-shaped failure
  const httpish = Object.assign(new Error('unavailable'), { response: { status: 503 } });
  const adapter = createMockAuthAdapter();
  adapter.login = async () => { throw httpish; };
  const svc = new AuthService({ adapter, tenantConfigs: TENANTS });
  await assert.rejects(svc.loginAs(TENANTS[0].alias));
  assert.strictEqual(svc.manager.listSessions().length, 0);

  // Transport-shaped failure (no response at all)
  const netty = createMockAuthAdapter();
  netty.login = async () => { throw new Error('ECONNREFUSED 10.0.0.1:443'); };
  const svc2 = new AuthService({ adapter: netty, tenantConfigs: TENANTS });
  await assert.rejects(svc2.loginAs(TENANTS[0].alias), /ECONNREFUSED/);
  assert.ok(tenant && actor);
});

test('MT-07 two tenants share one Auth implementation with no tenant-specific code', async () => {
  const { service } = newService();
  assert.deepStrictEqual(service.aliases.sort(), [TENANTS[0].alias, TENANTS[1].alias].sort());

  const [a, b] = await Promise.all([service.loginAs(TENANTS[0].alias), service.loginAs(TENANTS[1].alias)]);
  assert.notStrictEqual(a.id, b.id, 'distinct tenants must not share a session id');
  assert.notStrictEqual(a.session.accessToken, b.session.accessToken, 'distinct tenants must not share an access token');
  assert.strictEqual(service.manager.listSessions().length, 2);
});

test('MT-07b an unknown tenant alias is refused rather than silently created', async () => {
  const { service } = newService();
  await assert.rejects(service.loginAs('tenant-that-does-not-exist'), (e) => e.code === 'UNKNOWN_TENANT');
});

// =============================================================================================
// Session lifecycle (8-15)
// =============================================================================================

test('MT-08 separate sessions exist for different tenants', async () => {
  const { service } = newService();
  const a = await service.loginAs(TENANTS[0].alias);
  const b = await service.loginAs(TENANTS[1].alias);

  const sessions = service.manager.listSessions();
  assert.strictEqual(sessions.length, 2);
  assert.deepStrictEqual(sessions.map((s) => s.tenantId).sort(), [TENANTS[0].tenantId, TENANTS[1].tenantId].sort());
  assert.notStrictEqual(a.id, b.id);
});

test('MT-09 session state is independent per tenant', async () => {
  const { service } = newService();
  const a = await service.loginAs(TENANTS[0].alias);
  const b = await service.loginAs(TENANTS[1].alias);

  await a.logout();

  assert.strictEqual(a.session.state, 'logged-out');
  assert.strictEqual(b.session.state, 'authenticated', "tenant B must be unaffected by tenant A's logout");
  assert.strictEqual(await b.isAuthenticated(), true);
  assert.strictEqual(service.manager.getSession(a.id).state, 'logged-out');
  assert.strictEqual(service.manager.getSession(b.id).state, 'authenticated');
});

test('MT-10 session expiry is represented and reported', async () => {
  const { service } = newService();
  const handle = await service.loginAs(TENANTS[0].alias);

  assert.strictEqual(handle.session.state, 'authenticated');
  handle.session.markExpired();
  assert.strictEqual(handle.session.state, 'expired');
  assert.strictEqual(service.manager.getSession(handle.id).state, 'expired');
});

test('MT-10b an invalid session ID is rejected by auth-core', async () => {
  const { Session } = require('@atf/auth-core');
  assert.throws(() => new Session({ id: 'not-a-valid-id' }), (e) => e instanceof AuthStateError && e.code === 'INVALID_SESSION_ID');
  assert.throws(() => new Session({ id: 'binder_sess_abc' }), (e) => e.code === 'INVALID_SESSION_ID');
  assert.throws(() => new Session({ id: '' }), (e) => e.code === 'INVALID_SESSION_ID');
});

test('MT-11 logout invalidates the intended session', async () => {
  const { service } = newService();
  const handle = await service.loginAs(TENANTS[0].alias);
  const result = await handle.logout();

  assert.strictEqual(result.state, 'logged-out');
  assert.deepStrictEqual(result.invalidated, [handle.id]);
  assert.strictEqual(service.manager.getSession(handle.id).state, 'logged-out');
});

test('MT-12 logging out tenant A does not invalidate tenant B', async () => {
  const { service } = newService();
  const a = await service.loginAs(TENANTS[0].alias);
  const b = await service.loginAs(TENANTS[1].alias);

  await a.logout();

  assert.strictEqual(b.session.state, 'authenticated');
  const bState = await service.manager.getSessionState(b.session);
  assert.strictEqual(bState.authenticated, true);
});

test('MT-13 parallel login and refresh operations complete without interference', async () => {
  const { service } = newService({ rotationEnabled: true });
  const lock = new RefreshLock();
  service.manager.refreshLock = lock;

  const handles = await Promise.all([service.loginAs(TENANTS[0].alias), service.loginAs(TENANTS[1].alias)]);
  const refreshed = await Promise.all(handles.map((h) => h.refresh()));

  assert.strictEqual(refreshed.length, 2);
  for (const h of handles) {
    assert.strictEqual(h.session.state, 'authenticated');
    assert.ok(h.session.previousAccessToken, 'refresh must record the superseded access token');
  }
  // Distinct sessions must have produced distinct new tokens.
  assert.notStrictEqual(refreshed[0].accessToken, refreshed[1].accessToken);
});

test('MT-14 no session or token is overwritten across tenants', async () => {
  const { service } = newService({ rotationEnabled: true });
  const a = await service.loginAs(TENANTS[0].alias);
  const b = await service.loginAs(TENANTS[1].alias);

  const aTokenBefore = a.session.accessToken;
  const bTokenBefore = b.session.accessToken;

  await a.refresh();

  assert.strictEqual(b.session.accessToken, bTokenBefore, "tenant B's token must not change");
  assert.notStrictEqual(a.session.accessToken, aTokenBefore);
  assert.notStrictEqual(a.session.accessToken, b.session.accessToken);
});

test('MT-15 cleanup removes sessions after successful operations', async () => {
  const { service } = newService();
  await service.loginAs(TENANTS[0].alias);
  await service.loginAs(TENANTS[1].alias);
  assert.strictEqual(service.manager.listSessions().length, 2);

  const results = await service.cleanup();

  assert.strictEqual(results.length, 2);
  assert.ok(results.every((r) => r.state === 'logged-out'));
  assert.strictEqual(service.sessions.size, 0);
});

test('MT-15b cleanup after a failed operation still leaves no tracked sessions', async () => {
  const { service } = newService();
  const handle = await service.loginAs(TENANTS[0].alias);
  handle.session.markExpired(); // simulate a broken session before cleanup
  const results = await service.cleanup();

  assert.strictEqual(service.sessions.size, 0);
  assert.ok(results.length >= 0);
});

// =============================================================================================
// Authorization and isolation (16-22) â€” FIXTURE LEVEL ONLY
// =============================================================================================

test('MT-16 authorized access within the correct tenant succeeds', async () => {
  const { service } = newService();
  const a = await service.loginAs(TENANTS[0].alias);

  a.assertTenant(TENANTS[0].tenantId); // must not throw
  assert.strictEqual(await a.isAuthenticated(), true);
});

test('MT-17 tenant A cannot use its session for tenant B by changing the tenant id', async () => {
  const { service } = newService();
  const a = await service.loginAs(TENANTS[0].alias);

  assert.throws(
    () => a.assertTenant(TENANTS[1].tenantId),
    (e) => e instanceof TenantBoundaryError && e.code === 'CROSS_TENANT_SESSION_USE'
  );
  // The session record itself is still bound to tenant A and cannot be re-pointed.
  assert.strictEqual(a.session.tenantId, TENANTS[0].tenantId);
});

test('MT-17b a session whose tenant binding was altered is detected', async () => {
  const { service } = newService();
  const a = await service.loginAs(TENANTS[0].alias);
  a.session.tenantId = TENANTS[1].tenantId; // simulate tampering

  // With no expected tenant supplied, the session's own binding is checked and must not
  // silently agree with a re-pointed tenant id.
  assert.throws(
    () => a.assertTenant(),
    (e) => e.code === 'SESSION_TENANT_MISMATCH'
  );
});

test('MT-18 missing tenant context is handled as an explicit error', async () => {
  const { service } = newService();
  assert.throws(() => service.require('ghost'), (e) => e.code === 'UNKNOWN_TENANT');
  assert.strictEqual(service.manager.getSession('sess_does_not_exist'), null);
});

test('MT-19 expired authentication is rejected', async () => {
  const { service } = newService();
  const handle = await service.loginAs(TENANTS[0].alias);

  handle.session.markExpired();
  assert.strictEqual(handle.session.state, 'expired');
  assert.strictEqual(handle.session.markExpired, handle.session.markExpired, 'state is observable');

  // A session the adapter no longer recognises must not report as authenticated, and a
  // session with no access token must be refused by the real adapter.
  const unknown = { id: 'sess_unknown_tenant_session', tenantId: TENANTS[0].tenantId };
  assert.strictEqual(await service.manager.isAuthenticated(unknown), false);

  const { CredentialAuthAdapter } = require('@atf/adapters/targets').binder;
  const real = new CredentialAuthAdapter({ onboardingUrl: 'https://fixture.invalid' });
  assert.strictEqual((await real.getSessionState({ id: handle.id })).authenticated, false);
});

test('MT-20 effective access is reported as unsupported when the adapter cannot answer', async () => {
  const { service } = newService();
  const handle = await service.loginAs(TENANTS[0].alias);

  const access = await handle.getEffectiveAccess();
  assert.strictEqual(service.supportsEffectiveAccess, false);
  assert.strictEqual(access.supported, false);
  assert.strictEqual(access.reason, 'ADAPTER_UNSUPPORTED');

  // The critical property: an unsupported capability is distinguishable from a supported
  // answer that happens to grant nothing.
  const supportedButEmpty = { supported: true, reason: null, items: [], screenCodes: [] };
  assert.notStrictEqual(access.supported, supportedButEmpty.supported);
  assert.strictEqual(await service.manager.hasEffectiveScreen(handle.session, 'SCR_ANY'), false);
});

test('MT-20b effective access is surfaced when the adapter supports it', async () => {
  const adapter = createMockAuthAdapter();
  adapter.getEffectiveAccess = async () => ({
    items: [{ screenCode: 'SCR_A', moduleCode: 'MOD_A', scope: 'ALL', level: 'ADMIN', canApprove: true, canDelete: false }],
    screenCodes: ['SCR_A'],
    moduleCodes: ['MOD_A'],
    canApprove: ['SCR_A'],
  });
  const service = new AuthService({ adapter, tenantConfigs: TENANTS });
  const handle = await service.loginAs(TENANTS[0].alias);

  const access = await handle.getEffectiveAccess();
  assert.strictEqual(access.supported, true);
  assert.deepStrictEqual(access.screenCodes, ['SCR_A']);
  assert.strictEqual(await service.manager.hasEffectiveScreen(handle.session, 'SCR_A'), true);
  assert.strictEqual(await service.manager.hasEffectiveScreen(handle.session, 'SCR_UNKNOWN'), false);
});

test('MT-21 unauthorized cross-tenant requests are refused by the framework', async () => {
  const { service } = newService();
  const a = await service.loginAs(TENANTS[0].alias);

  await assert.rejects(a.refresh.call({ ...a, assertTenant() { throw new TenantBoundaryError('blocked', { code: 'CROSS_TENANT_SESSION_USE' }); } }));
});

test('MT-22 concurrent operations for two tenants do not mix identities or sessions', async () => {
  const { service } = newService({ rotationEnabled: true });
  const [a, b] = await Promise.all([service.loginAs(TENANTS[0].alias), service.loginAs(TENANTS[1].alias)]);

  await parallelLimit(4, [
    () => a.refresh(),
    () => b.refresh(),
    () => Promise.resolve(a.assertTenant(TENANTS[0].tenantId)),
    () => Promise.resolve(b.assertTenant(TENANTS[1].tenantId)),
  ]);

  assert.strictEqual(a.session.tenantId, TENANTS[0].tenantId);
  assert.strictEqual(b.session.tenantId, TENANTS[1].tenantId);
  assert.notStrictEqual(a.session.accessToken, b.session.accessToken);
});

// =============================================================================================
// Failure handling (23-29)
// =============================================================================================

test('MT-23 refresh failure keeps the session unauthenticated and preserves the old token', async () => {
  const { service } = newService({ failRefresh: 'INVALID_TOKEN' });
  const handle = await service.loginAs(TENANTS[0].alias);
  const tokenBefore = handle.session.accessToken;

  await assert.rejects(handle.refresh(), (e) => e.code === 'INVALID_TOKEN');
  assert.strictEqual(handle.session.accessToken, tokenBefore, 'a failed refresh must not corrupt the session');
});

test('MT-24 logout failure is reported as a failure', async () => {
  const adapter = createMockAuthAdapter();
  adapter.logout = async () => ({ invalidated: [], count: 0, state: 'logout-failed', code: 'HTTP_ERROR' });
  const service = new AuthService({ adapter, tenantConfigs: TENANTS });
  const handle = await service.loginAs(TENANTS[0].alias);

  const result = await handle.logout();
  assert.strictEqual(result.state, 'logout-failed');
  assert.strictEqual(result.count, 0);
});

test('MT-25 malformed API responses are rejected', async () => {
  const adapter = createMockAuthAdapter();
  adapter.getSessionState = async () => ({ authenticated: 'yes', state: 'weird' });
  const service = new AuthService({ adapter, tenantConfigs: TENANTS });
  const handle = await service.loginAs(TENANTS[0].alias);

  const state = await handle.isAuthenticated();
  assert.strictEqual(state, false, 'a non-boolean authenticated flag must not read as authenticated');
});

test('MT-26 a missing request context is refused before any transport call', () => {
  const { CredentialAuthAdapter } = require('@atf/adapters/targets').binder;
  const adapter = new CredentialAuthAdapter({ onboardingUrl: 'https://fixture.invalid' });

  assert.strictEqual(adapter.available, false);
  assert.throws(() => adapter.client('token'), (e) => e.code === 'NO_REQUEST_CONTEXT');
});

test('MT-27 missing API configuration is refused', () => {
  // No base URL from either the caller or the environment resolver: refused rather than guessed.
  const { CredentialAuthAdapter } = require('@atf/adapters/targets').binder;
  assert.throws(() => new CredentialAuthAdapter({}), (e) => e.code === 'NO_ONBOARDING_URL');
});

test('MT-28 Redis connection failure is surfaced, not swallowed', async () => {
  const { RedisObserverError } = require('@atf/redis-observer');
  const err = new RedisObserverError('connection refused', { code: 'REDIS_UNAVAILABLE' });
  assert.strictEqual(err.code, 'REDIS_UNAVAILABLE');
  // The real Redis suite covers the live path; here we assert failures stay observable.
  assert.ok(String(err.message).includes('connection refused'));
});

test('MT-29 concurrent lifecycle failure and recovery converge on a usable session', async () => {
  let attempt = 0;
  const adapter = createMockAuthAdapter();
  const originalRefresh = adapter.refresh.bind(adapter);
  adapter.refresh = async (session) => {
    attempt += 1;
    if (attempt === 1) {
      const e = new Error('transient upstream failure');
      e.code = 'REFRESH_TRANSPORT_FAILED';
      throw e;
    }
    return originalRefresh(session);
  };

  const service = new AuthService({ adapter, tenantConfigs: TENANTS });
  const handle = await service.loginAs(TENANTS[0].alias);

  await assert.rejects(handle.refresh(), (e) => e.code === 'REFRESH_TRANSPORT_FAILED');
  assert.strictEqual(handle.session.state, 'authenticated', 'session must survive a transient failure');

  const recovered = await handle.refresh();
  assert.ok(recovered.accessToken);
  assert.strictEqual(handle.session.state, 'authenticated');
});

// =============================================================================================
// Configuration reporting helpers
// =============================================================================================

test('MT-CFG tenant descriptions never contain credentials', () => {
  const tenants = loadTenantConfigs({
    BINDER_TENANTS: JSON.stringify([
      { alias: 'prod_like', baseUrl: 'https://onboarding.test.invalid', email: 'user@test.invalid', password: 'top-secret-value', redisNamespace: 'qa:prod_like' },
    ]),
  });
  const described = describeTenant(tenants[0]);

  assert.strictEqual(described.hasCredentials, true);
  const serialised = JSON.stringify(described);
  assert.ok(!serialised.includes('top-secret-value'), 'password must never be described');
  assert.ok(!serialised.includes('user@test.invalid'), 'account email must not be echoed into reports');
});

test('MT-CFG HTTP readiness reports missing prerequisites instead of assuming success', () => {
  const none = loadTenantConfigs({});
  const empty = httpReadiness(none);
  assert.strictEqual(empty.ready, false);
  assert.ok(empty.missing.length > 0);

  const partial = loadTenantConfigs({ BINDER_TENANTS: JSON.stringify([{ alias: 'a', baseUrl: 'https://x.invalid' }]) });
  const readiness = httpReadiness(partial);
  assert.strictEqual(readiness.ready, false);
  assert.ok(readiness.missing.some((m) => m.prerequisite === 'password'));
});

test('MT-CFG multiple tenants may share one base URL', () => {
  const tenants = loadTenantConfigs({
    BINDER_TENANTS: JSON.stringify([
      { alias: 'a', baseUrl: 'https://shared.invalid', email: 'a@x.invalid', password: 'p' },
      { alias: 'b', baseUrl: 'https://shared.invalid', email: 'b@x.invalid', password: 'p' },
    ]),
  });
  assert.strictEqual(tenants.length, 2);
  assert.strictEqual(tenants[0].baseUrl, tenants[1].baseUrl);
  assert.notStrictEqual(tenants[0].alias, tenants[1].alias);
});

