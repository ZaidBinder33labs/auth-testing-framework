'use strict';
/**
 * EXM-01..EXM-nn â€” the same adapter, driven through a deliberately unlike target.
 *
 * This is the proof that the framework is application-agnostic. config/targets/example.json
 * shares nothing with config/targets/binder.json: different paths, different credential and token
 * field names, the refresh token in the JSON body instead of an HttpOnly cookie, expiry as a
 * duration rather than a timestamp, rotation off, a logout that answers 200 instead of 204,
 * different JWT claim names and different Redis key prefixes.
 *
 * If the adapter still assumed anything about Binder, this file would fail. It is therefore the
 * deliverable of the target-descriptor phase, not an extra: without it, "application-agnostic"
 * is a claim the code does not support.
 *
 * No such application is deployed. Every response comes from a scripted transport, so this file
 * proves the adapter follows the descriptor; it proves nothing about any backend.
 */

const test = require('node:test');
const assert = require('node:assert');

const { CredentialAuthAdapter, CredentialAuthError } = require('@atf/adapters/targets').binder;
const { loadTarget, describeTarget, composeKeyPrefix, sessionKey } = require('@atf/target-config');
const { HttpStatusError, HttpTransport } = require('@atf/http-transport');

const EXAMPLE_BASE = 'https://example-app.test';
const TENANT = { id: 'ten_example_1' };
const ACTOR = { id: 'act_example_1' };
const CREDENTIALS = { email: 'someone@example-app.test', password: 'not-a-real-secret' };

const example = () => loadTarget('example');
const binder = () => loadTarget('binder');

/**
 * A scripted example application.
 *
 * It answers only the paths the descriptor declares, only the field names the descriptor
 * declares, and rejects anything else. A request the adapter made with a hardcoded Binder path or
 * field name would therefore fail here rather than quietly pass.
 */
function createExampleBackend(state = {}) {
  const seen = [];
  const store = {
accessToken: state.accessToken || 'ex-at-1',
    refreshToken: state.refreshToken || 'ex-rt-1',
    // The example application reports a relative TTL, matching its declared expiresFormat.
    ttlSeconds: state.ttlSeconds === undefined ? 3600 : state.ttlSeconds,
    grantRows: state.grantRows || [
      { screen_key: 'EX_SCREEN_A', module_key: 'EX_MOD', reach: 'ALL', tier: 'ADMIN', may_approve: true, may_remove: false },
      { screen_key: 'EX_SCREEN_B', module_key: 'EX_MOD', reach: 'OWN', tier: 'USER', may_approve: 'yes', may_remove: true },
    ],
    profile: state.profile || {
      id: 'u-77', login: 'someone@example-app.test', handle: 'someone',
      given_name: 'Some', family_name: 'One', role_title: 'Engineer', principal_kind: 'USER',
      tenant_id: 'ten_example_1', tenant_label: 'Example Org', tenant_key: 'ex-org', tenant_banner: null,
      plan_state: 'ACTIVE', seat_cap: 10, seats_taken: 3, trial_until: null,
      purchaser_scope: 'ALL', tenant_admin: false, onboarding_needed: false,
    },
    failNext: state.failNext || null,
  };

  const ctx = {
    calls: seen,
    async fetch(url, init = {}) {
      const path = url.startsWith(EXAMPLE_BASE) ? url.slice(EXAMPLE_BASE.length) : url;
      seen.push({ path, method: init.method, data: init.data, headers: init.headers });
      const t = example().auth;

      const reply = (status, body, headers = {}) => ({
        status: () => status,
        headers: () => headers,
        text: async () => (body === undefined ? '' : JSON.stringify(body)),
      });

      if (store.failNext) {
        const f = store.failNext;
        store.failNext = null;
        return reply(f.status, f.body);
      }

      if (path === t.loginPath && init.method === 'POST') {
        // The application calls the credential fields user_name / secret.
        if (!init.data || init.data[t.loginFields.email] !== CREDENTIALS.email) return reply(422, { message: 'nope' });
        return reply(200, {
          [t.fields.accessTokenField]: store.accessToken,
          [t.fields.refreshTokenField]: store.refreshToken,
          [t.fields.expiresField]: store.ttlSeconds,
          [t.tokenTypeField]: 'bearer',
        });
      }

      if (path === t.refreshPath && init.method === 'POST') {
        // The refresh token travels in the body, so it must actually arrive.
        if (!init.data || init.data[t.fields.refreshTokenField] !== store.refreshToken) return reply(401, { message: 'no renew token' });
        return reply(200, {
          [t.fields.accessTokenField]: `${store.accessToken}-renewed`,
          [t.fields.refreshTokenField]: store.refreshToken,
          [t.fields.expiresField]: store.ttlSeconds,
        });
      }

      if (path === t.logoutPath && init.method === 'POST') return reply(200, { ended: true });

      if (path === t.mePath && init.method === 'GET') {
        return reply(200, { ...store.profile });
      }

      if (path === t.accessPath && init.method === 'GET') {
        return reply(200, store.grantRows);
      }

      return reply(404, { message: 'no such route' });
    },
  };
  return { ctx, store, seen };
}

function exampleAdapter(ctx, extra = {}) {
  return new CredentialAuthAdapter({
    onboardingUrl: EXAMPLE_BASE,
    requestContext: ctx,
    target: example(),
    apiTimeout: 5000,
    ...extra,
  });
}

/** A context that answers the example login route with one fixed body, whatever is asked. */
function ctxReturning(loginBody) {
  return {
    async fetch(url, init = {}) {
      const path = String(url).startsWith(EXAMPLE_BASE) ? String(url).slice(EXAMPLE_BASE.length) : String(url);
      if (path === example().auth.loginPath) {
        const text = JSON.stringify(loginBody);
        return { status: () => 200, headers: () => ({}), text: async () => text };
      }
      return { status: () => 404, headers: () => ({}), text: async () => '{}' };
    },
  };
}

/** An unsigned JWT whose payload the adapter will decode without verifying. */
function jwtWith(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

// ------------------------------------------------------------------------------------------
// EXM-01  The descriptors really are unlike each other
// ------------------------------------------------------------------------------------------

test('EXM-01 the example descriptor differs from binder in every dimension that could hide an assumption', () => {
  const ex = example();
  const bi = binder();

  for (const field of ['loginPath', 'refreshPath', 'logoutPath', 'mePath', 'accessPath']) {
    assert.notStrictEqual(ex.auth[field], bi.auth[field], `${field} must differ`);
  }
  for (const field of ['accessTokenField', 'refreshTokenField', 'expiresField']) {
    assert.notStrictEqual(ex.auth.fields[field], bi.auth.fields[field], `fields.${field} must differ`);
  }
  assert.notStrictEqual(ex.auth.tokenTypeField, bi.auth.tokenTypeField);
  assert.notStrictEqual(ex.auth.fields.expiresFormat, bi.auth.fields.expiresFormat);
  assert.notStrictEqual(ex.auth.logoutSuccessStatus, bi.auth.logoutSuccessStatus);
  assert.notStrictEqual(ex.auth.cookieAuth, bi.auth.cookieAuth);
  assert.notStrictEqual(ex.auth.rotationEnabled, bi.auth.rotationEnabled);
  assert.notStrictEqual(ex.auth.loginFields.email, bi.auth.loginFields.email);
  assert.notStrictEqual(ex.auth.claims.tenant, bi.auth.claims.tenant);
  assert.notStrictEqual(ex.redis.sessionPrefix, bi.redis.sessionPrefix);
});

test('EXM-02 the example descriptor declares no Binder path anywhere', () => {
  const raw = JSON.stringify(example());
  assert.ok(!raw.includes('/api/v1'), 'no Binder path may appear in the example descriptor');
  assert.ok(!raw.includes('access_token'), 'no Binder field name may appear in the example descriptor');
});

// ------------------------------------------------------------------------------------------
// EXM-03  The lifecycle, end to end
// ------------------------------------------------------------------------------------------

test('EXM-03 login posts the example credential field names to the example path', async () => {
  const { ctx, seen } = createExampleBackend();
  const session = await exampleAdapter(ctx).login(TENANT, ACTOR, CREDENTIALS);

  assert.strictEqual(seen[0].path, '/v2/session/start');
  assert.deepStrictEqual(seen[0].data, { user_name: CREDENTIALS.email, secret: CREDENTIALS.password });
  assert.ok(!('email' in seen[0].data), 'the framework name must not be sent verbatim');
  assert.strictEqual(session.accessToken, 'ex-at-1');
  assert.strictEqual(session.refreshToken, 'ex-rt-1');
  assert.strictEqual(session.tenantId, TENANT.id);
  assert.strictEqual(session.actorId, ACTOR.id);
});

test('EXM-04 login reads the example token, refresh and expiry field names', async () => {
  const { ctx } = createExampleBackend();
  const session = await exampleAdapter(ctx).login(TENANT, ACTOR, CREDENTIALS);

  assert.strictEqual(session.accessToken, 'ex-at-1', 'session_token read');
  assert.strictEqual(session.refreshToken, 'ex-rt-1', 'renew_token read');
  assert.strictEqual(session.tokenType, 'bearer', 'token_kind read');
  // The descriptor says the expiry arrives as a duration, so it is taken at face value.
  assert.strictEqual(session.expiresIn, 3600, 'ttl_seconds read as seconds');
});

test('EXM-05 the declared expiry format is authoritative and is never guessed', async () => {
  const ex = example();
  assert.strictEqual(ex.auth.fields.expiresFormat, 'seconds');

  // The same adapter, told the target reports a duration, given a timestamp instead.
  const adapter = new CredentialAuthAdapter({
    onboardingUrl: EXAMPLE_BASE,
    requestContext: ctxReturning({
      session_token: 'ex-at-1',
      renew_token: 'ex-rt-1',
      ttl_seconds: new Date(Date.now() + 3600_000).toISOString(),
    }),
    target: ex,
  });
  const session = await adapter.login(TENANT, ACTOR, CREDENTIALS);
  // A datetime handed to a duration parser is unreadable, and null says "no usable expiry"
  // rather than inventing one the way a datetime-parsing fallback would.
  assert.strictEqual(session.expiresIn, null, 'a timestamp must not be silently read as seconds');

  // And a duration under a datetime descriptor is equally refused.
  const asDatetime = {
    ...ex,
    auth: { ...ex.auth, fields: { ...ex.auth.fields, expiresFormat: 'datetime' } },
  };
  const adapter2 = new CredentialAuthAdapter({
    onboardingUrl: EXAMPLE_BASE,
    requestContext: ctxReturning({ session_token: 'ex-at-1', renew_token: 'ex-rt-1', expires_at: 3600 }),
    target: asDatetime,
  });
  const s2 = await adapter2.login(TENANT, ACTOR, CREDENTIALS);
  assert.strictEqual(s2.expiresIn, null, 'a duration must not be silently read as a timestamp');

});

test('EXM-06 rotation is off because the descriptor says so, even though a refresh token came back', async () => {
  const { ctx } = createExampleBackend();
  const session = await exampleAdapter(ctx).login(TENANT, ACTOR, CREDENTIALS);

  // Binder infers rotation from the presence of a token; this target declares it false.
  assert.ok(session.refreshToken, 'the application did return a refresh token');
  assert.strictEqual(session.rotationEnabled, false);
});

test('EXM-07 refresh sends the refresh token in the body, not relying on a cookie', async () => {
  const { ctx, seen } = createExampleBackend();
  const adapter = exampleAdapter(ctx);
  const session = await adapter.login(TENANT, ACTOR, CREDENTIALS);

  const refreshed = await adapter.refresh(session);

  const refreshCall = seen.find((c) => c.path === '/v2/session/renew');
  assert.deepStrictEqual(refreshCall.data, { renew_token: 'ex-rt-1' }, 'the token must be in the body');
  assert.strictEqual(refreshed.accessToken, 'ex-at-1-renewed');
  assert.strictEqual(refreshed.rotated, false, 'the same refresh token came back');
});

test('EXM-08 refresh on a body-token target fails clearly when the token is not sent back', async () => {
  // Guards the guard: if the adapter stopped sending the body token, the backend answers 401 and
  // the test would otherwise pass a broken adapter.
  const { ctx, seen } = createExampleBackend();
  const adapter = exampleAdapter(ctx);
  const session = await adapter.login(TENANT, ACTOR, CREDENTIALS);

  seen.length = 0;
  await assert.rejects(
    adapter.refresh({ accessToken: session.accessToken, refreshToken: 'wrong-token' }),
    (e) => e instanceof CredentialAuthError && e.code === 'INVALID_TOKEN'
  );
});

test('EXM-09 logout accepts 200, the status the descriptor declares, and not only 204', async () => {
  const { ctx, seen } = createExampleBackend();
  const adapter = exampleAdapter(ctx);
  const session = await adapter.login(TENANT, ACTOR, CREDENTIALS);

  const result = await adapter.logout(session);

  assert.strictEqual(result.state, 'logged-out');
  assert.strictEqual(result.count, 1);
  const logoutCall = seen.find((c) => c.path === '/v2/session/end');
  assert.ok(logoutCall, 'the example logout path must be used');
  assert.strictEqual(logoutCall.data, undefined, 'logout declares no request body');
});

test('EXM-10 logout still reports failure when the status is not the declared one', async () => {
  const { ctx, store } = createExampleBackend();
  const adapter = exampleAdapter(ctx);
  const session = await adapter.login(TENANT, ACTOR, CREDENTIALS);
  store.failNext = { status: 204, body: null };

  const result = await adapter.logout(session);

  assert.strictEqual(result.state, 'logout-failed');
  assert.strictEqual(result.count, 0);
  assert.deepStrictEqual(result.invalidated, []);
});

test('EXM-11 session state reads the example profile field names onto the framework shape', async () => {
  const { ctx } = createExampleBackend();
  const adapter = exampleAdapter(ctx);
  const session = await adapter.login(TENANT, ACTOR, CREDENTIALS);

  const state = await adapter.getSessionState(session);

  assert.strictEqual(state.authenticated, true);
  assert.strictEqual(state.state, 'authenticated');
  assert.strictEqual(state.userInfo.userId, 'u-77', 'id -> userId');
  assert.strictEqual(state.userInfo.email, 'someone@example-app.test', 'login -> email');
  assert.strictEqual(state.userInfo.firstName, 'Some', 'given_name -> firstName');
  assert.strictEqual(state.userInfo.tenantName, 'Example Org', 'tenant_label -> tenantName');
  assert.strictEqual(state.userInfo.seatLimit, 10, 'seat_cap -> seatLimit');
  assert.strictEqual(state.userInfo.isTenantAdmin, false);
  // Every documented key is present even where the target sends nothing.
  assert.ok('companySetupRequired' in state.userInfo);
  assert.strictEqual(state.userInfo.tenantLogoUrl, null);
});

test('EXM-12 session state still reports expired on 401 without throwing', async () => {
  const { ctx, store } = createExampleBackend();
  const adapter = exampleAdapter(ctx);
  const session = await adapter.login(TENANT, ACTOR, CREDENTIALS);
  store.failNext = { status: 401, body: { message: 'expired' } };

  const state = await adapter.getSessionState(session);
  assert.strictEqual(state.authenticated, false);
  assert.strictEqual(state.state, 'expired');
  assert.strictEqual(state.code, 'INVALID_TOKEN');
});

test('EXM-13 effective access reads the example grant field names and stays strict about booleans', async () => {
  const { ctx } = createExampleBackend();
  const adapter = exampleAdapter(ctx);
  const session = await adapter.login(TENANT, ACTOR, CREDENTIALS);

  const access = await adapter.getEffectiveAccess(session);

  assert.deepStrictEqual(access.screenCodes, ['EX_SCREEN_A', 'EX_SCREEN_B']);
  assert.deepStrictEqual(access.moduleCodes, ['EX_MOD']);
  assert.deepStrictEqual(access.canApprove, ['EX_SCREEN_A']);
  assert.strictEqual(access.items[0].scope, 'ALL', 'reach -> scope');
  assert.strictEqual(access.items[0].level, 'ADMIN', 'tier -> level');
  // The second row says may_approve: 'yes'. A truthy string is still not an approval.
  assert.strictEqual(access.items[1].canApprove, false);
  assert.strictEqual(access.items[1].canDelete, true, 'may_remove -> canDelete');
});

test('EXM-14 JWT claim extraction follows the descriptor, not Binder claim names', () => {
  const exAdapter = new CredentialAuthAdapter({ onboardingUrl: EXAMPLE_BASE, target: example() });
  const biAdapter = new CredentialAuthAdapter({ onboardingUrl: EXAMPLE_BASE, target: binder() });

  // One token, two claim vocabularies.
  const token = jwtWith({ tenant: 'ten_from_claim', actor: 'u_from_claim', tid: 'tid_value', sub: 'sub_value' });

  assert.strictEqual(exAdapter.tokenTenant(token), 'ten_from_claim');
  assert.strictEqual(exAdapter.tokenUser(token), 'u_from_claim');
  assert.strictEqual(biAdapter.tokenTenant(token), 'tid_value');
  assert.strictEqual(biAdapter.tokenUser(token), 'sub_value');
});

test('EXM-15 missing credentials are refused before any request, whatever the field names', async () => {
  const { ctx, seen } = createExampleBackend();
  const adapter = exampleAdapter(ctx);

  await assert.rejects(
    adapter.login(TENANT, ACTOR, { email: CREDENTIALS.email }),
    (e) => e instanceof CredentialAuthError && e.code === 'MISSING_CREDENTIALS'
  );
  await assert.rejects(
    adapter.login(TENANT, ACTOR, { password: 'x' }),
    (e) => e.code === 'MISSING_CREDENTIALS'
  );
  assert.strictEqual(seen.length, 0, 'no request may be issued without both credentials');
});

test('EXM-16 a full session lifecycle against one backend instance stays coherent', async () => {
  const { ctx } = createExampleBackend();
  const adapter = exampleAdapter(ctx);

  const session = await adapter.login(TENANT, ACTOR, CREDENTIALS);
  const before = await adapter.getSessionState(session);
  const access = await adapter.getEffectiveAccess(session);
  const refreshed = await adapter.refresh(session);
  const after = await adapter.getSessionState({ ...session, accessToken: refreshed.accessToken });
  const out = await adapter.logout(session);

  assert.strictEqual(before.authenticated, true);
  assert.deepStrictEqual(access.screenCodes, ['EX_SCREEN_A', 'EX_SCREEN_B']);
  assert.notStrictEqual(refreshed.accessToken, session.accessToken);
  assert.strictEqual(after.authenticated, true);
  assert.strictEqual(after.state, 'authenticated');
  assert.strictEqual(out.state, 'logged-out');
  assert.strictEqual(out.count, 1);
});

test('EXM-17 the adapter maps a refusal status to the same code whatever the field names', async () => {
  const { ctx, store } = createExampleBackend();
  const adapter = exampleAdapter(ctx);

  store.failNext = { status: 422, body: { message: 'bad' } };
  await assert.rejects(
    adapter.login(TENANT, ACTOR, CREDENTIALS),
    (e) => e instanceof CredentialAuthError && e.code === 'INVALID_CREDENTIALS'
  );

  store.failNext = { status: 404, body: {} };
  await assert.rejects(
    adapter.login(TENANT, ACTOR, CREDENTIALS),
    (e) => e.code === 'ENDPOINT_NOT_FOUND'
  );

  // A 429 is retried by the transport, so a single scripted refusal is absorbed by the retry.
  // Retries disabled here to observe the status the adapter would finally see.
  const noRetry = exampleAdapter(ctx, {
    apiFactory: (c, o) => new HttpTransport(c, { ...o, retries: 0 }),
  });
  store.failNext = { status: 429, body: {} };
  await assert.rejects(
    noRetry.login(TENANT, ACTOR, CREDENTIALS),
    (e) => e.code === 'RATE_LIMITED'
  );
});

test('EXM-18 a 429 is retried by the transport and then succeeds, on the example paths too', async () => {
  const { ctx, store } = createExampleBackend();
  const adapter = exampleAdapter(ctx);
  store.failNext = { status: 429, headers: { 'retry-after': '0' }, body: { message: 'slow down' } };

  const session = await adapter.login(TENANT, ACTOR, CREDENTIALS);

  assert.strictEqual(session.accessToken, 'ex-at-1', 'the retry succeeded');
  assert.strictEqual(adapter.client(undefined).constructor.name, 'HttpTransport');
});

// ------------------------------------------------------------------------------------------
// EXM-18  Redis prefixes come from the target
// ------------------------------------------------------------------------------------------

test('EXM-18 the example Redis prefixes are composed from the target and an environment', () => {
  const ex = example();
  assert.strictEqual(composeKeyPrefix(ex, { namespace: 'qa:ex1' }), 'qa:ex1session/');
  assert.strictEqual(sessionKey(ex, 'sess_x', { namespace: 'qa:ex1', deploymentPrefix: 'stage:' }), 'stage:qa:ex1session/sess_x');
  assert.strictEqual(composeKeyPrefix(binder(), { namespace: 'qa:ex1' }), 'qa:ex1sess:');
});

// ------------------------------------------------------------------------------------------
// EXM-19  Descriptor surface
// ------------------------------------------------------------------------------------------

test('EXM-19 describeTarget reports the example contract without a host or a credential', () => {
  const d = describeTarget(example());
  assert.strictEqual(d.name, 'example');
  assert.deepStrictEqual(d.paths.login, '/v2/session/start');
  assert.strictEqual(d.cookieAuth, false);
  assert.strictEqual(d.rotationEnabled, false);
  assert.strictEqual(d.logoutSuccessStatus, 200);
  assert.strictEqual(d.expiresFormat, 'seconds');
  assert.ok(!JSON.stringify(d).includes('secret'));
  assert.ok(!('baseUrl' in d));
});

test('EXM-20 the descriptor-driven transport reports status, and refusals become coded errors', async () => {
  const { ctx, store } = createExampleBackend();
  const adapter = exampleAdapter(ctx);
  const session = await adapter.login(TENANT, ACTOR, CREDENTIALS);

  // The transport is generic: it reports the status and only throws when a caller asserts one.
  const transport = adapter.client(session.accessToken);
  const missing = await transport.get('/v2/not-a-route', {});
  assert.strictEqual(missing.status, 404);
  assert.throws(() => missing.expect(200), (e) => e instanceof HttpStatusError && e.response.status === 404);

  // A refusal on a declared path becomes a coded auth error, and the body the server echoed
  // back never reaches the message: a server that reflects the submitted password must not turn
  // a failed login into a leaked credential in a report.
  store.failNext = {
    status: 422,
    body: { message: 'nope', user_name: CREDENTIALS.email, secret: CREDENTIALS.password },
  };
  let caught = null;
  try {
    await adapter.login(TENANT, ACTOR, CREDENTIALS);
  } catch (e) {
    caught = e;
  }

  assert.ok(caught instanceof CredentialAuthError, 'the refusal must surface as a coded auth error');
  assert.strictEqual(caught.code, 'INVALID_CREDENTIALS');
  assert.ok(!caught.message.includes(CREDENTIALS.password), 'the error must not echo the password');
  assert.ok(!caught.message.includes(CREDENTIALS.email), 'the error must not echo the account');
});







