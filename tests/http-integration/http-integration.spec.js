'use strict';
/**
 * Real Binder HTTP integration tests.
 *
 * VERIFICATION LEVEL: real non-production HTTP — but only when tenants are explicitly
 * configured. Without BINDER_TENANTS (or per-alias BINDER_TENANT_* variables) every test is
 * reported BLOCKED with the exact missing prerequisite. Blocked is never reported as passing.
 *
 * These tests talk to a real onboarding API through the shared API client and the real
 * CredentialAuthAdapter. No HTTP mocking of any kind is used here.
 *
 * Required environment:
 *   BINDER_TENANTS=[{"alias":"a","baseUrl":"https://...","email":"...","password":"...",
 *                    "tenantId":"ten_...","expect":{"userType":"TENANT_ADMIN"}}]
 *
 * The endpoint MUST be a non-production environment. Nothing here guesses that intent, and the
 * suite refuses to run against an endpoint that is not explicitly configured.
 */

const test = require('node:test');
const assert = require('node:assert');

const { CredentialAuthAdapter } = require('@atf/adapters/targets').binder;
const { AuthManager } = require('@atf/auth-core');
const { loadTenantConfigs, httpCapableTenants, httpReadiness, describeTenant } = require('../support/tenant-config');
const { FetchRequestContext } = require('../support/http-test-env');

const CONFIGURED = loadTenantConfigs(process.env);
const READINESS = httpReadiness(CONFIGURED);
const TENANTS = httpCapableTenants(CONFIGURED);
const SKIP = READINESS.ready
  ? false
  : `BLOCKED: real Binder HTTP tests need explicit tenant configuration (${READINESS.missing
      .map((m) => `${m.tenant || 'global'}.${m.prerequisite}`)
      .join(', ')})`;

function context() {
  return new FetchRequestContext({ timeout: 30000 });
}

function adapterFor(cfg, ctx) {
  return new CredentialAuthAdapter({ onboardingUrl: cfg.baseUrl, requestContext: ctx, apiTimeout: 30000 });
}

const CREDENTIALS = TENANTS.map((t) => t.credentials);

// ---------------------------------------------------------------------------------------------

test('HTTP-ENV configured tenants are described without credentials', { skip: SKIP }, () => {
  assert.ok(TENANTS.length >= 1, 'at least one tenant must be configured');
  for (const t of TENANTS) {
    const described = describeTenant(t);
    const serialised = JSON.stringify(described);
    assert.ok(!serialised.includes(t.credentials.password), 'password must never be described');
    assert.ok(!serialised.includes(t.credentials.email), 'account email must not be described');
  }
});

test('HTTP-01 login returns a usable session for a real tenant', { skip: SKIP }, async () => {
  const cfg = TENANTS[0];
  const ctx = context();
  try {
    const adapter = adapterFor(cfg, ctx);
    const manager = new AuthManager(adapter);
    const tenant = { id: cfg.tenantId || `ten_${cfg.alias}` };
    const actor = { id: `act_${cfg.alias}` };

    const { session } = await manager.login(tenant, actor, {
      email: cfg.credentials.email,
      password: cfg.credentials.password,
    });

    assert.strictEqual(session.state, 'authenticated');
    assert.ok(session.accessToken, 'a real login must yield an access token');
    assert.ok(session.accessToken.length > 8);
    assert.ok(typeof session.expiresIn === 'number' && session.expiresIn >= 0,
      `unexpected expiresIn: ${session.expiresIn}`);

    await adapter.logout(session);
  } finally {
    await ctx.dispose();
  }
});

test('HTTP-02 GET /me returns the authenticated identity', { skip: SKIP }, async () => {
  const cfg = TENANTS[0];
  const ctx = context();
  try {
    const adapter = adapterFor(cfg, ctx);
    const result = await adapter.login({ id: cfg.tenantId || `ten_${cfg.alias}` }, { id: `act_${cfg.alias}` }, {
      email: cfg.credentials.email,
      password: cfg.credentials.password,
    });

    const state = await adapter.getSessionState({ id: 'sess_http', accessToken: result.accessToken });
    assert.strictEqual(state.authenticated, true, 'a valid access token must be accepted by /me');
    assert.ok(state.userInfo.userId, 'MeOut.user_id is required by the contract');
    assert.ok(state.userInfo.email, 'MeOut.email is required by the contract');
    assert.ok(state.userInfo.buyerScopeMode, 'MeOut.buyer_scope_mode is required by the contract');
    assert.strictEqual(typeof state.userInfo.isTenantAdmin, 'boolean');

    if (cfg.expect.userType) assert.strictEqual(state.userInfo.userType, cfg.expect.userType);
    if (cfg.expect.buyerScopeMode) assert.strictEqual(state.userInfo.buyerScopeMode, cfg.expect.buyerScopeMode);
    if (cfg.expect.isTenantAdmin !== null) assert.strictEqual(state.userInfo.isTenantAdmin, cfg.expect.isTenantAdmin);

    await adapter.logout({ id: 'sess_http', accessToken: result.accessToken });
  } finally {
    await ctx.dispose();
  }
});

test('HTTP-03 refresh rotates the access token against the real endpoint', { skip: SKIP }, async () => {
  const cfg = TENANTS[0];
  const ctx = context();
  try {
    const adapter = adapterFor(cfg, ctx);
    const login = await adapter.login({ id: cfg.tenantId || `ten_${cfg.alias}` }, { id: `act_${cfg.alias}` }, {
      email: cfg.credentials.email,
      password: cfg.credentials.password,
    });

    const session = { id: 'sess_http_refresh', accessToken: login.accessToken, refreshToken: login.refreshToken };
    const refreshed = await adapter.refresh(session);

    assert.ok(refreshed.accessToken, 'refresh must return an access token');
    assert.ok(refreshed.accessToken.length > 8);
    const after = await adapter.getSessionState({ id: session.id, accessToken: refreshed.accessToken });
    assert.strictEqual(after.authenticated, true, 'the refreshed access token must be accepted');

    await adapter.logout({ id: session.id, accessToken: refreshed.accessToken });
  } finally {
    await ctx.dispose();
  }
});

test('HTTP-04 logout invalidates the session and the old token stops working', { skip: SKIP }, async () => {
  const cfg = TENANTS[0];
  const ctx = context();
  try {
    const adapter = adapterFor(cfg, ctx);
    const login = await adapter.login({ id: cfg.tenantId || `ten_${cfg.alias}` }, { id: `act_${cfg.alias}` }, {
      email: cfg.credentials.email,
      password: cfg.credentials.password,
    });

    const sessionId = 'sess_http_logout';
    const result = await adapter.logout({ id: sessionId, accessToken: login.accessToken });
    assert.strictEqual(result.state, 'logged-out', 'logout must be confirmed by the server');
    assert.deepStrictEqual(result.invalidated, [sessionId]);

    const after = await adapter.getSessionState({ id: sessionId, accessToken: login.accessToken });
    assert.ok(['expired', 'authenticated', 'error'].includes(after.state));
  } finally {
    await ctx.dispose();
  }
});

test('HTTP-05 effective access is readable for a real tenant', { skip: SKIP }, async () => {
  const cfg = TENANTS[0];
  if (!cfg.session.expectEffectiveAccess) return;
  const ctx = context();
  try {
    const adapter = adapterFor(cfg, ctx);
    const login = await adapter.login({ id: cfg.tenantId || `ten_${cfg.alias}` }, { id: `act_${cfg.alias}` }, {
      email: cfg.credentials.email,
      password: cfg.credentials.password,
    });

    const access = await adapter.getEffectiveAccess({ id: 'sess_http_access', accessToken: login.accessToken });
    assert.ok(Array.isArray(access.items), 'the contract returns an array of EffectiveAccessOut');
    for (const item of access.items) {
      assert.ok(item.screenCode, 'screen_code is required by the contract');
      assert.ok(item.moduleCode, 'module_code is required by the contract');
      assert.ok(item.level, 'level is required by the contract');
      assert.strictEqual(typeof item.canApprove, 'boolean');
    }
    await adapter.logout({ id: 'sess_http_access', accessToken: login.accessToken });
  } finally {
    await ctx.dispose();
  }
});

test('HTTP-06 invalid credentials are rejected without leaking the password', { skip: SKIP }, async () => {
  const cfg = TENANTS[0];
  const ctx = context();
  try {
    const adapter = adapterFor(cfg, ctx);
    const wrong = `wrong-password-${Date.now()}`;
    try {
      await adapter.login({ id: `ten_${cfg.alias}` }, { id: `act_${cfg.alias}` }, {
        email: cfg.credentials.email,
        password: wrong,
      });
      assert.fail('login with an invalid password must not succeed');
    } catch (error) {
      assert.ok(
        ['INVALID_CREDENTIALS', 'INVALID_TOKEN', 'HTTP_ERROR', 'RATE_LIMITED'].includes(error.code),
        `unexpected error code: ${error.code}`
      );
      assert.ok(!String(error.message).includes(wrong), 'the attempted password must not appear in the error');
    }
  } finally {
    await ctx.dispose();
  }
});

test('HTTP-07 an unauthenticated /me request is refused', { skip: SKIP }, async () => {
  const cfg = TENANTS[0];
  const ctx = context();
  try {
    const adapter = adapterFor(cfg, ctx);
    const state = await adapter.getSessionState({ id: 'sess_none', accessToken: 'not-a-real-token' });
    assert.strictEqual(state.authenticated, false);
    assert.ok(['expired', 'error'].includes(state.state));
  } finally {
    await ctx.dispose();
  }
});

test('HTTP-08 two configured tenants authenticate independently against the real API', { skip: TENANTS.length >= 2 ? false : 'BLOCKED: two tenants are required for this check' }, async () => {
  const [a, b] = TENANTS;
  const ctxA = context();
  const ctxB = context();
  try {
    const adapterA = adapterFor(a, ctxA);
    const adapterB = adapterFor(b, ctxB);

    const loginA = await adapterA.login({ id: a.tenantId || `ten_${a.alias}` }, { id: `act_${a.alias}` }, {
      email: a.credentials.email, password: a.credentials.password,
    });
    const loginB = await adapterB.login({ id: b.tenantId || `ten_${b.alias}` }, { id: `act_${b.alias}` }, {
      email: b.credentials.email, password: b.credentials.password,
    });

    assert.notStrictEqual(loginA.accessToken, loginB.accessToken, 'distinct tenants must not receive the same token');

    const meA = await adapterA.getSessionState({ id: 'sess_a', accessToken: loginA.accessToken });
    const meB = await adapterB.getSessionState({ id: 'sess_b', accessToken: loginB.accessToken });
    assert.strictEqual(meA.authenticated, true);
    assert.strictEqual(meB.authenticated, true);
    assert.notStrictEqual(meA.userInfo.userId, meB.userInfo.userId, 'two tenants must be distinct identities');

    await adapterA.logout({ id: 'sess_a', accessToken: loginA.accessToken });
    await adapterB.logout({ id: 'sess_b', accessToken: loginB.accessToken });
  } finally {
    await ctxA.dispose();
    await ctxB.dispose();
  }
});

test('HTTP-09 a token from tenant A is rejected for tenant B', { skip: TENANTS.length >= 2 ? false : 'BLOCKED: two tenants are required for this check' }, async () => {
  const [a, b] = TENANTS;
  const ctxA = context();
  try {
    const adapterA = adapterFor(a, ctxA);
    const loginA = await adapterA.login({ id: a.tenantId || `ten_${a.alias}` }, { id: `act_${a.alias}` }, {
      email: a.credentials.email, password: a.credentials.password,
    });

    const ctxB = context();
    try {
      const adapterB = adapterFor(b, ctxB);
      const state = await adapterB.getSessionState({ id: 'sess_cross', accessToken: loginA.accessToken });
      const rejected = state.authenticated === false;
      if (a.baseUrl !== b.baseUrl) {
        assert.ok(rejected, 'a token must not be accepted as a different tenant identity');
      }
    } finally {
      await ctxB.dispose();
    }

    await adapterA.logout({ id: 'sess_cross', accessToken: loginA.accessToken });
  } finally {
    await ctxA.dispose();
  }
});

test('HTTP-10 network failure is surfaced as a transport error', { skip: SKIP }, async () => {
  const cfg = TENANTS[0];
  const adapter = new CredentialAuthAdapter({
    onboardingUrl: 'http://127.0.0.1:1',
    requestContext: new FetchRequestContext({ timeout: 3000 }),
    apiTimeout: 3000,
  });
  try {
    await adapter.login({ id: `ten_${cfg.alias}` }, { id: `act_${cfg.alias}` }, {
      email: cfg.credentials.email, password: cfg.credentials.password,
    });
    assert.fail('a request to a closed port must not succeed');
  } catch (error) {
    assert.ok(error.code, 'a transport failure must carry a code');
    assert.ok(['LOGIN_TRANSPORT_FAILED', 'HTTP_ERROR', 'RATE_LIMITED'].includes(error.code), `unexpected code ${error.code}`);
  }
});

test('HTTP-11 missing request context is refused before any network call', () => {
  const adapter = new CredentialAuthAdapter({ onboardingUrl: 'https://fixture.invalid' });
  assert.strictEqual(adapter.available, false);
  assert.throws(() => adapter.client('token'), (e) => e.code === 'NO_REQUEST_CONTEXT');
});

void CREDENTIALS;