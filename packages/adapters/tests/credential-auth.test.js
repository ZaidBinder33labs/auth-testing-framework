'use strict';
// CredentialAuthAdapter tests â€” node:test only (no jest).
//
// The Api client is injected through the adapter's apiFactory seam, so these tests pin the
// exact HTTP contract the adapter uses against the real client:
//   - which method/path is called
//   - the JSON body is passed positionally (not wrapped in an options object)
//   - logout is sent without a request body, per the OpenAPI contract
// No network access and no credentials are involved.

const test = require('node:test');
const assert = require('node:assert');
const { CredentialAuthAdapter, CredentialAuthError, generateSessionId, readExpiresIn } = require('@atf/adapters/targets').binder;
const { SESSION_ID_RE } = require('@atf/auth-core');

const ONBOARDING_URL = 'https://onboarding.test.invalid';

/** Minimal request context: the real client only needs .fetch. Records every call. */
function recordingContext() {
  const calls = [];
  return {
    calls,
    ctx: {
      async fetch(url, init) {
        calls.push({ url, init });
        return {
          status: () => 200,
          headers: () => ({}),
          text: async () => '{}',
        };
      },
    },
  };
}

/** Scripted API client matching the real lib/api-client.js surface used by the adapter. */
function fakeApiFactory(script) {
  const calls = [];
  const factory = (ctx, opts) => {
    calls.push({ ctx, opts });
    return {
      async post(path, json) {
        calls.push({ method: 'POST', path, json });
        const r = script(path, json);
        return response(r.status, r.body);
      },
      async send(method, path) {
        calls.push({ method, path });
        const r = script(path, undefined);
        return response(r.status, r.body);
      },
      async get(path) {
        calls.push({ method: 'GET', path });
        const r = script(path, undefined);
        return response(r.status, r.body);
      },
    };
  };
  factory.calls = calls;
  return factory;
}

function response(status, body) {
  return {
    status,
    body,
    expect(expected) {
      const ok = [].concat(expected);
      if (!ok.includes(status)) {
        const err = new Error(`Expected HTTP ${ok.join('/')} but got ${status}`);
        err.response = { status, body };
        throw err;
      }
      return this;
    },
  };
}

function adapterWith(script, extra = {}) {
  const apiFactory = fakeApiFactory(script);
  const { ctx } = recordingContext();
  const adapter = new CredentialAuthAdapter({ onboardingUrl: ONBOARDING_URL, requestContext: ctx, apiFactory, ...extra });
  return { adapter, apiFactory };
}

const TOKEN_OUT = (over = {}) => ({
  access_token: 'at_value_placeholder',
  refresh_token: 'rt_value_placeholder',
  token_type: 'bearer',
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  ...over,
});

const ME_OUT = {
  user_id: 'u-1',
  email: 'user@test.invalid',
  first_name: 'Test',
  user_type: 'TENANT_MEMBER',
  buyer_scope_mode: 'SELECTED',
  is_tenant_admin: false,
};

const TENANT = { id: 'ten_a' };
const ACTOR = { id: 'act_a1' };

// ---------------------------------------------------------------------------------------------
// Construction and configuration
// ---------------------------------------------------------------------------------------------

test('CredentialAuthAdapter: constructs with an explicit onboardingUrl', () => {
  const adapter = new CredentialAuthAdapter({ onboardingUrl: ONBOARDING_URL });
  assert.strictEqual(adapter.onboardingUrl, ONBOARDING_URL);
});

test('CredentialAuthAdapter: an explicit empty url falls back to the environment configuration', () => {
  // The environment supplies its base URL through the injected resolver. This used to read a
  // mutable global config object in another repository, which made the adapter impossible to
  // use outside that repository.
  const envBaseUrl = 'https://from-environment.example.test';
  const adapter = new CredentialAuthAdapter({ onboardingUrl: '', resolveBaseUrl: () => envBaseUrl });
  assert.strictEqual(adapter.onboardingUrl, envBaseUrl);
});

test('CredentialAuthAdapter: missing onboarding configuration is rejected with a coded error', () => {
  // No explicit URL and no resolver: there is no ambient configuration to fall back to.
  assert.throws(
    () => new CredentialAuthAdapter({}),
    (e) => e instanceof CredentialAuthError && e.code === 'NO_ONBOARDING_URL'
  );
});

test('CredentialAuthAdapter: is unavailable and refuses to build a client without a request context', () => {
  const adapter = new CredentialAuthAdapter({ onboardingUrl: ONBOARDING_URL });
  assert.strictEqual(adapter.available, false);
  assert.throws(
    () => adapter.client(undefined),
    (e) => e instanceof CredentialAuthError && e.code === 'NO_REQUEST_CONTEXT'
  );
});

test('CredentialAuthAdapter: is available once a request context is injected', () => {
  const { ctx } = recordingContext();
  const adapter = new CredentialAuthAdapter({ onboardingUrl: ONBOARDING_URL, requestContext: ctx });
  assert.strictEqual(adapter.available, true);
});

// ---------------------------------------------------------------------------------------------
// Session identifiers
// ---------------------------------------------------------------------------------------------

test('CredentialAuthAdapter: generated session IDs satisfy the auth-core validator', () => {
  for (let i = 0; i < 50; i += 1) {
    const id = generateSessionId();
    assert.ok(SESSION_ID_RE.test(id), `session id rejected by auth-core: ${id}`);
  }
});

test('CredentialAuthAdapter: login returns a session ID valid under auth-core validation', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: TOKEN_OUT() }));
  const result = await adapter.login(TENANT, ACTOR, { email: 'a@b.invalid', password: 'pw' });
  assert.ok(SESSION_ID_RE.test(result.sessionId), `invalid session id: ${result.sessionId}`);
});

// ---------------------------------------------------------------------------------------------
// Login â€” request shape and response mapping
// ---------------------------------------------------------------------------------------------

test('CredentialAuthAdapter: login posts LoginIn fields positionally, not wrapped in an options object', async () => {
  const { adapter, apiFactory } = adapterWith(() => ({ status: 200, body: TOKEN_OUT() }));
  await adapter.login(TENANT, ACTOR, { email: 'user@test.invalid', password: 'secret' });

  const call = apiFactory.calls.find((c) => c.method === 'POST');
  assert.strictEqual(call.path, '/api/v1/auth/login');
  assert.deepStrictEqual(call.json, { email: 'user@test.invalid', password: 'secret' });
  assert.ok(!('json' in (call.json || {})), 'body must not be nested under a json key');
});

test('CredentialAuthAdapter: login sends no bearer token', async () => {
  const { adapter, apiFactory } = adapterWith(() => ({ status: 200, body: TOKEN_OUT() }));
  await adapter.login(TENANT, ACTOR, { email: 'a@b.invalid', password: 'pw' });
  const clientCall = apiFactory.calls[0];
  assert.strictEqual(clientCall.opts.token, undefined);
});

test('CredentialAuthAdapter: login maps TokenOut into a session descriptor', async () => {
  const expires = new Date(Date.now() + 3600_000).toISOString();
  const { adapter } = adapterWith(() => ({ status: 200, body: TOKEN_OUT({ expires_at: expires }) }));
  const result = await adapter.login(TENANT, ACTOR, { email: 'a@b.invalid', password: 'pw' });

  assert.strictEqual(result.accessToken, 'at_value_placeholder');
  assert.strictEqual(result.refreshToken, 'rt_value_placeholder');
  assert.strictEqual(result.tokenType, 'bearer');
  assert.strictEqual(result.tenantId, 'ten_a');
  assert.strictEqual(result.actorId, 'act_a1');
  assert.ok(result.expiresIn > 3500 && result.expiresIn <= 3600, `unexpected expiresIn: ${result.expiresIn}`);
  assert.strictEqual(result.rotationEnabled, true);
});

test('CredentialAuthAdapter: login without refresh_token disables rotation', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: TOKEN_OUT({ refresh_token: null }) }));
  const result = await adapter.login(TENANT, ACTOR, { email: 'a@b.invalid', password: 'pw' });
  assert.strictEqual(result.refreshToken, null);
  assert.strictEqual(result.rotationEnabled, false);
});

test('CredentialAuthAdapter: login without refresh_token keeps a zero expiry rather than inventing 3600', async () => {
  // expires_at is required by the contract, so its absence is malformed and must not be
  // silently converted into a healthy-looking lifetime.
  const { adapter } = adapterWith(() => ({ status: 200, body: { access_token: 'at_x', expires_at: null } }));
  const result = await adapter.login(TENANT, ACTOR, { email: 'a@b.invalid', password: 'pw' });
  assert.strictEqual(result.expiresIn, null);
});

test('CredentialAuthAdapter: already-expired expires_at yields zero, not the 3600 fallback', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: TOKEN_OUT({ expires_at: new Date(Date.now() - 5000).toISOString() }) }));
  const result = await adapter.login(TENANT, ACTOR, { email: 'a@b.invalid', password: 'pw' });
  assert.strictEqual(result.expiresIn, 0);
});

test('readExpiresIn handles missing, malformed, zero and future values', () => {
  assert.strictEqual(readExpiresIn(undefined), null);
  assert.strictEqual(readExpiresIn(null), null);
  assert.strictEqual(readExpiresIn(''), null);
  assert.strictEqual(readExpiresIn('not-a-date'), null);
  assert.strictEqual(readExpiresIn(new Date(Date.now() - 10_000).toISOString()), 0);
  assert.ok(readExpiresIn(new Date(Date.now() + 120_000).toISOString()) >= 119);
});

// ---------------------------------------------------------------------------------------------
// Login â€” validation and failure modes
// ---------------------------------------------------------------------------------------------

test('CredentialAuthAdapter: missing credentials are rejected before any request', async () => {
  const { adapter, apiFactory } = adapterWith(() => ({ status: 200, body: TOKEN_OUT() }));
  await assert.rejects(
    adapter.login(TENANT, ACTOR, { email: 'a@b.invalid' }),
    (e) => e.code === 'MISSING_CREDENTIALS'
  );
  await assert.rejects(
    adapter.login(TENANT, ACTOR, { password: 'pw' }),
    (e) => e.code === 'MISSING_CREDENTIALS'
  );
  assert.strictEqual(apiFactory.calls.filter((c) => c.method === 'POST').length, 0, 'no request should be sent');
});

test('CredentialAuthAdapter: missing tenant or actor is rejected', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: TOKEN_OUT() }));
  await assert.rejects(adapter.login(null, ACTOR, { email: 'a', password: 'b' }), (e) => e.code === 'MISSING_TENANT');
  await assert.rejects(adapter.login(TENANT, null, { email: 'a', password: 'b' }), (e) => e.code === 'MISSING_ACTOR');
});

test('CredentialAuthAdapter: a 422 login maps to INVALID_CREDENTIALS', async () => {
  const { adapter } = adapterWith(() => ({ status: 422, body: { error: { code: 'x', message: 'y' } } }));
  await assert.rejects(
    adapter.login(TENANT, ACTOR, { email: 'a', password: 'b' }),
    (e) => e.code === 'INVALID_CREDENTIALS'
  );
});

test('CredentialAuthAdapter: a login response without access_token is malformed', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: { token_type: 'bearer' } }));
  await assert.rejects(
    adapter.login(TENANT, ACTOR, { email: 'a', password: 'b' }),
    (e) => e.code === 'MALFORMED_LOGIN_RESPONSE'
  );
});

test('CredentialAuthAdapter: a non-JSON login body is malformed', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: null }));
  await assert.rejects(
    adapter.login(TENANT, ACTOR, { email: 'a', password: 'b' }),
    (e) => e.code === 'MALFORMED_RESPONSE'
  );
});

test('CredentialAuthAdapter: 429 login maps to RATE_LIMITED', async () => {
  const { adapter } = adapterWith(() => ({ status: 429, body: { error: { code: 'rate', message: 'slow down' } } }));
  await assert.rejects(
    adapter.login(TENANT, ACTOR, { email: 'a', password: 'b' }),
    (e) => e.code === 'RATE_LIMITED'
  );
});

test('CredentialAuthAdapter: a network failure maps to a transport code, not a credential error', async () => {
  const adapter = new CredentialAuthAdapter({
    onboardingUrl: ONBOARDING_URL,
    requestContext: { fetch: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'Error' }); } },
    apiFactory: () => ({ post: async () => { throw new Error('connect ECONNREFUSED'); } }),
  });
  await assert.rejects(
    adapter.login(TENANT, ACTOR, { email: 'a', password: 'b' }),
    (e) => e.code === 'LOGIN_TRANSPORT_FAILED'
  );
});

test('CredentialAuthAdapter: errors never echo the request password', async () => {
  const { adapter } = adapterWith(() => ({ status: 422, body: { error: { code: 'bad', message: 'no' } } }));
  try {
    await adapter.login(TENANT, ACTOR, { email: 'a@b.invalid', password: 'sup3rs3cret' });
    assert.fail('expected rejection');
  } catch (e) {
    assert.ok(!String(e.message).includes('sup3rs3cret'), 'password leaked into error message');
  }
});

// ---------------------------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------------------------

test('CredentialAuthAdapter: refresh posts an empty body, matching the RefreshIn contract', async () => {
  const { adapter, apiFactory } = adapterWith(() => ({ status: 200, body: TOKEN_OUT({ access_token: 'at_new' }) }));
  await adapter.refresh({ accessToken: 'at_old', refreshToken: 'rt_old' });

  const call = apiFactory.calls.find((c) => c.method === 'POST');
  assert.strictEqual(call.path, '/api/v1/auth/refresh');
  assert.deepStrictEqual(call.json, {});
  assert.ok(!('json' in (call.json || {})), 'body must not be nested under a json key');
});

test('CredentialAuthAdapter: refresh detects rotation and reports the previous token', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: TOKEN_OUT({ access_token: 'at_new', refresh_token: 'rt_new' }) }));
  const result = await adapter.refresh({ accessToken: 'at_old', refreshToken: 'rt_old' });

  assert.strictEqual(result.accessToken, 'at_new');
  assert.strictEqual(result.refreshToken, 'rt_new');
  assert.strictEqual(result.rotated, true);
  assert.strictEqual(result.previousRefreshToken, 'rt_old');
});

test('CredentialAuthAdapter: refresh keeps the existing token when the server returns none', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: { access_token: 'at_new', expires_at: new Date(Date.now() + 3600_000).toISOString() } }));
  const result = await adapter.refresh({ accessToken: 'at_old', refreshToken: 'rt_old' });

  assert.strictEqual(result.refreshToken, 'rt_old');
  assert.strictEqual(result.rotated, false);
  assert.strictEqual(result.previousRefreshToken, undefined);
});

test('CredentialAuthAdapter: refresh without a session is NOT_AUTHENTICATED', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: TOKEN_OUT() }));
  await assert.rejects(adapter.refresh(null), (e) => e.code === 'NOT_AUTHENTICATED');
  await assert.rejects(adapter.refresh({}), (e) => e.code === 'NOT_AUTHENTICATED');
});

test('CredentialAuthAdapter: a 401 refresh maps to INVALID_TOKEN', async () => {
  const { adapter } = adapterWith(() => ({ status: 401, body: {} }));
  await assert.rejects(
    adapter.refresh({ accessToken: 'at', refreshToken: 'rt' }),
    (e) => e.code === 'INVALID_TOKEN'
  );
});

test('CredentialAuthAdapter: a refresh response without access_token is malformed', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: { token_type: 'bearer' } }));
  await assert.rejects(
    adapter.refresh({ accessToken: 'at' }),
    (e) => e.code === 'MALFORMED_REFRESH_RESPONSE'
  );
});

// ---------------------------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------------------------

test('CredentialAuthAdapter: logout sends no request body, per contract', async () => {
  const { adapter, apiFactory } = adapterWith(() => ({ status: 204, body: null }));
  await adapter.logout({ id: 'sess_x', accessToken: 'at_x' });

  const call = apiFactory.calls.find((c) => c.path === '/api/v1/auth/logout');
  assert.strictEqual(call.method, 'POST');
  assert.ok(!('json' in call), 'logout must not send a request body');
});

test('CredentialAuthAdapter: logout on 204 reports the invalidated session', async () => {
  const { adapter } = adapterWith(() => ({ status: 204, body: null }));
  const result = await adapter.logout({ id: 'sess_x', accessToken: 'at_x' });

  assert.strictEqual(result.state, 'logged-out');
  assert.strictEqual(result.count, 1);
  assert.deepStrictEqual(result.invalidated, ['sess_x']);
});

test('CredentialAuthAdapter: logout accepts sessionId as well as id', async () => {
  const { adapter } = adapterWith(() => ({ status: 204, body: null }));
  const result = await adapter.logout({ sessionId: 'sess_y', accessToken: 'at_x' });
  assert.deepStrictEqual(result.invalidated, ['sess_y']);
});

test('CredentialAuthAdapter: a failed logout is reported as failed, never as invalidated', async () => {
  const { adapter } = adapterWith(() => ({ status: 401, body: {} }));
  const result = await adapter.logout({ id: 'sess_x', accessToken: 'at_x' });

  assert.strictEqual(result.state, 'logout-failed');
  assert.strictEqual(result.count, 0);
  assert.deepStrictEqual(result.invalidated, []);
  assert.strictEqual(result.code, 'INVALID_TOKEN');
});

test('CredentialAuthAdapter: logout without a token does not claim success', async () => {
  const { adapter } = adapterWith(() => ({ status: 204, body: null }));
  const result = await adapter.logout({ id: 'sess_x' });
  assert.strictEqual(result.state, 'logout-failed');
  assert.strictEqual(result.code, 'NOT_AUTHENTICATED');
});

// ---------------------------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------------------------

test('CredentialAuthAdapter: getSessionState GETs /me with no body', async () => {
  const { adapter, apiFactory } = adapterWith(() => ({ status: 200, body: ME_OUT }));
  await adapter.getSessionState({ accessToken: 'at_x' });

  const call = apiFactory.calls.find((c) => c.method === 'GET');
  assert.strictEqual(call.path, '/api/v1/auth/me');
});

test('CredentialAuthAdapter: getSessionState maps MeOut including the newer fields', async () => {
  const { adapter } = adapterWith(() => ({
    status: 200,
    body: { ...ME_OUT, tenant_logo_url: 'https://cdn.test.invalid/l.png', company_setup_required: true, seat_limit: 5, seats_used: 2 },
  }));
  const state = await adapter.getSessionState({ accessToken: 'at_x', refreshToken: 'rt_x' });

  assert.strictEqual(state.authenticated, true);
  assert.strictEqual(state.state, 'authenticated');
  assert.strictEqual(state.userInfo.userId, 'u-1');
  assert.strictEqual(state.userInfo.buyerScopeMode, 'SELECTED');
  assert.strictEqual(state.userInfo.isTenantAdmin, false);
  assert.strictEqual(state.userInfo.tenantLogoUrl, 'https://cdn.test.invalid/l.png');
  assert.strictEqual(state.userInfo.companySetupRequired, true);
  assert.strictEqual(state.userInfo.seatLimit, 5);
});

test('CredentialAuthAdapter: refreshTokenFingerprint is a hash and contains no token characters', async () => {
  const token = 'rt_super_secret_value_0123456789';
  const { adapter } = adapterWith(() => ({ status: 200, body: ME_OUT }));
  const state = await adapter.getSessionState({ accessToken: 'at_x', refreshToken: token });

  assert.ok(state.refreshTokenFingerprint.startsWith('fp_'));
  for (let i = 0; i < token.length - 6; i += 1) {
    assert.ok(!state.refreshTokenFingerprint.includes(token.slice(i, i + 6)), 'raw token fragment present in fingerprint');
  }
});

test('CredentialAuthAdapter: getSessionState reports expired on 401 without throwing', async () => {
  const { adapter } = adapterWith(() => ({ status: 401, body: {} }));
  const state = await adapter.getSessionState({ accessToken: 'at_bad' });

  assert.strictEqual(state.authenticated, false);
  assert.strictEqual(state.state, 'expired');
  assert.strictEqual(state.accessToken, null);
});

test('CredentialAuthAdapter: a transport failure is distinguishable from an expired session', async () => {
  const adapter = new CredentialAuthAdapter({
    onboardingUrl: ONBOARDING_URL,
    requestContext: { fetch: async () => ({}) },
    apiFactory: () => ({ get: async () => { throw new Error('ETIMEDOUT'); } }),
  });
  const state = await adapter.getSessionState({ accessToken: 'at_x' });

  assert.strictEqual(state.authenticated, false);
  assert.strictEqual(state.state, 'error');
  assert.strictEqual(state.code, 'ME_TRANSPORT_FAILED');
});

test('CredentialAuthAdapter: getSessionState without a token is not-found', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: ME_OUT }));
  const state = await adapter.getSessionState({});
  assert.strictEqual(state.state, 'not-found');
  assert.strictEqual(state.authenticated, false);
});

// ---------------------------------------------------------------------------------------------
// GET /me/access â€” effective access (verified contract)
// ---------------------------------------------------------------------------------------------

test('CredentialAuthAdapter: getEffectiveAccess GETs /me/access and maps the array response', async () => {
  const { adapter, apiFactory } = adapterWith(() => ({
    status: 200,
    body: [
      { screen_code: 'SCR_A', module_code: 'MOD_X', scope: 'ALL', level: 'ADMIN', can_approve: true, can_delete: true },
      { screen_code: 'SCR_B', module_code: 'MOD_X', scope: null, level: 'READ', can_approve: false },
    ],
  }));

  const access = await adapter.getEffectiveAccess({ accessToken: 'at_x' });

  assert.strictEqual(apiFactory.calls.find((c) => c.method === 'GET').path, '/api/v1/auth/me/access');
  assert.strictEqual(access.items.length, 2);
  assert.deepStrictEqual(access.screenCodes, ['SCR_A', 'SCR_B']);
  assert.deepStrictEqual(access.moduleCodes, ['MOD_X']);
  assert.deepStrictEqual(access.canApprove, ['SCR_A']);
  assert.strictEqual(access.items[1].canDelete, false, 'absent can_delete must default to false');
});

test('CredentialAuthAdapter: getEffectiveAccess rejects a non-array response', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: { unexpected: true } }));
  await assert.rejects(
    adapter.getEffectiveAccess({ accessToken: 'at_x' }),
    (e) => e.code === 'MALFORMED_ACCESS_RESPONSE'
  );
});

test('CredentialAuthAdapter: getEffectiveAccess on 401 raises INVALID_TOKEN', async () => {
  const { adapter } = adapterWith(() => ({ status: 401, body: {} }));
  await assert.rejects(
    adapter.getEffectiveAccess({ accessToken: 'at_x' }),
    (e) => e.code === 'INVALID_TOKEN'
  );
});

test('CredentialAuthAdapter: getEffectiveAccess requires an authenticated session', async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: [] }));
  await assert.rejects(adapter.getEffectiveAccess(null), (e) => e.code === 'NOT_AUTHENTICATED');
});

// ---------------------------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------------------------

test('CredentialAuthAdapter: tokenTenant and tokenUser read unverified claims', () => {
  const adapter = new CredentialAuthAdapter({ onboardingUrl: ONBOARDING_URL });
  const payload = Buffer.from(JSON.stringify({ tid: 'ten-1', sub: 'user-1' }), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const token = `header.${payload}.signature`;

  assert.strictEqual(adapter.tokenTenant(token), 'ten-1');
  assert.strictEqual(adapter.tokenUser(token), 'user-1');
});

test('CredentialAuthAdapter: claim extraction returns null for opaque or malformed tokens', () => {
  const adapter = new CredentialAuthAdapter({ onboardingUrl: ONBOARDING_URL });
  assert.strictEqual(adapter.tokenTenant('opaque-token'), null);
  assert.strictEqual(adapter.tokenUser('opaque-token'), null);
  assert.strictEqual(adapter.tokenTenant('a.b.c'), null);
  assert.strictEqual(adapter.tokenTenant(null), null);
});

test('CredentialAuthAdapter: safeToken and safeSession expose only a hash fingerprint', () => {
  const adapter = new CredentialAuthAdapter({ onboardingUrl: ONBOARDING_URL });
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const safe = adapter.safeToken(token);
  const safeSession = adapter.safeSession({ accessToken: token });

  assert.match(safe.fingerprint, /^fp_[0-9a-f]{16}$/);
  assert.strictEqual(safeSession.fingerprint, safe.fingerprint);
  assert.ok(!JSON.stringify(safe).includes(token), 'raw token present in safeToken output');
  assert.ok(!JSON.stringify(safe).includes(token.slice(4, 12)), 'raw token fragment present');
});

test('CredentialAuthAdapter: safeToken handles missing tokens without throwing', () => {
  const adapter = new CredentialAuthAdapter({ onboardingUrl: ONBOARDING_URL });
  assert.deepStrictEqual(adapter.safeToken(null), { fingerprint: null });
  assert.deepStrictEqual(adapter.safeToken(''), { fingerprint: null });
  assert.deepStrictEqual(adapter.safeSession(null), { fingerprint: null });
});

