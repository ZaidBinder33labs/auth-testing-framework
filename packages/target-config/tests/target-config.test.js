'use strict';
/**
 * @atf/target-config
 *
 * The loader is only useful if a malformed descriptor is refused before it can retarget a test
 * at the wrong host or leak a secret, so most of these tests are about refusal.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  TargetConfigError,
  validateTarget,
  loadTarget,
  loadTargetFile,
  listTargets,
  targetsDir,
  describeTarget,
  composeKeyPrefix,
  sessionKey,
  DEFAULT_TARGETS_DIR,
} = require('@atf/target-config');

/** A minimal valid descriptor; tests override one field at a time. */
function validTarget(overrides = {}) {
  return {
    name: 'unit',
    auth: {
      loginPath: '/login',
      refreshPath: '/refresh',
      logoutPath: '/logout',
      mePath: '/me',
      accessPath: '/me/access',
      loginFields: { email: 'email', password: 'password' },
      cookieAuth: true,
      rotationEnabled: true,
      globalLogout: false,
      logoutSuccessStatus: 204,
      fields: { accessToken: 'access_token', refreshToken: 'refresh_token', expires: 'expires_at', expiresFormat: 'datetime' },
      claims: { tenant: 'tid', user: 'sub' },
      accessFields: { screenCode: 's', moduleCode: 'm', scope: 'sc', level: 'lv', canApprove: 'ca', canDelete: 'cd' },
    },
    redis: { sessionPrefix: 'sess:', tokenPrefix: 'tok:', tenantPrefix: 'ten:' },
    ...overrides,
  };
}

// ------------------------------------------------------------------------------------------
// TGT-01  Shape and normalisation
// ------------------------------------------------------------------------------------------

test('TGT-01 a valid descriptor validates and freezes', () => {
  const t = validateTarget(validTarget());
  assert.strictEqual(t.name, 'unit');
  assert.strictEqual(t.auth.loginPath, '/login');
  assert.ok(Object.isFrozen(t));
  assert.ok(Object.isFrozen(t.auth));
  assert.ok(Object.isFrozen(t.auth.fields));
  assert.ok(Object.isFrozen(t.redis));
});

test('TGT-02 displayName falls back to the name and description/version may be absent', () => {
  const t = validateTarget(validTarget());
  assert.strictEqual(t.displayName, 'unit');
  assert.strictEqual(t.description, null);
  assert.strictEqual(t.version, null);
});

test('TGT-03 expiresFormat defaults to datetime and tokenType is optional', () => {
  const t = validateTarget(validTarget());
  assert.strictEqual(t.auth.fields.expiresFormat, 'datetime');
  assert.strictEqual(t.auth.tokenTypeField, null);
});

test('TGT-04 logoutSuccessStatus defaults to 204', () => {
  const t = validateTarget(validTarget({ auth: { ...validTarget().auth, logoutSuccessStatus: undefined } }));
  assert.strictEqual(t.auth.logoutSuccessStatus, 204);
});

test('TGT-05 userFields is optional and defaults to empty', () => {
  const t = validateTarget(validTarget());
  assert.deepStrictEqual({ ...t.auth.userFields }, {});
});

// ------------------------------------------------------------------------------------------
// TGT-06  Refusals
// ------------------------------------------------------------------------------------------

test('TGT-06 a non-object descriptor is refused', () => {
  for (const bad of [null, 'binder', 42, ['binder'], true]) {
    assert.throws(() => validateTarget(bad), (e) => e.code === 'INVALID_ENTRY');
  }
});

test('TGT-07 a missing name is refused with MISSING_FIELD', () => {
  const d = validTarget();
  delete d.name;
  assert.throws(() => validateTarget(d), (e) => e.code === 'MISSING_FIELD' && e.field === 'name');
});

test('TGT-08 a missing or empty path is refused', () => {
  for (const field of ['loginPath', 'refreshPath', 'logoutPath', 'mePath', 'accessPath']) {
    const d = validTarget();
    d.auth[field] = '';
    assert.throws(() => validateTarget(d), (e) => e.code === 'MISSING_FIELD' && e.field === `auth.${field}`);
  }
});

test('TGT-09 a path that is not a path fragment is refused', () => {
  for (const bad of ['api/v1/auth/login', '/api?q=1#frag', '//evil.example.test', '/api v1', '/api/<x>']) {
    const d = validTarget();
    d.auth.loginPath = bad;
    assert.throws(() => validateTarget(d), (e) => e.code === 'INVALID_FORMAT' && e.field === 'auth.loginPath', `accepted ${bad}`);
  }
});

test('TGT-10 a descriptor carrying a base URL is refused, so it cannot retarget a test', () => {
  for (const field of ['baseUrl', 'apiUrl']) {
    const d = validTarget();
    d[field] = 'https://private.example.test';
    assert.throws(() => validateTarget(d), (e) => e.code === 'BASE_URL_NOT_ALLOWED', `accepted ${field}`);
  }
});

test('TGT-11 a non-boolean flag is refused rather than coerced', () => {
  for (const field of ['cookieAuth', 'rotationEnabled', 'globalLogout']) {
    for (const bad of ['true', 1, null, undefined]) {
      const d = validTarget();
      d.auth[field] = bad;
      assert.throws(() => validateTarget(d), (e) => e.code === 'INVALID_TYPE' && e.field === `auth.${field}`);
    }
  }
});

test('TGT-12 an out-of-range or non-numeric logout status is refused', () => {
  for (const bad of [99, 600, 'no', 204.5, null, true]) {
    const d = validTarget();
    d.auth.logoutSuccessStatus = bad;
    assert.throws(() => validateTarget(d), (e) => e.code === 'INVALID_TYPE');
  }
});

test('TGT-13 a non-integer expiresFormat is refused', () => {
  const d = validTarget();
  d.auth.fields.expiresFormat = 'iso-string';
  assert.throws(() => validateTarget(d), (e) => e.code === 'INVALID_VALUE');
});

test('TGT-14 a missing token, refresh or expiry field name is refused', () => {
  for (const field of ['accessToken', 'refreshToken', 'expires']) {
    const d = validTarget();
    delete d.auth.fields[field];
    assert.throws(() => validateTarget(d), (e) => e.code === 'MISSING_FIELD', `accepted missing ${field}`);
  }
});

test('TGT-15 a field name that is not an identifier is refused', () => {
  const d = validTarget();
  d.auth.fields.accessToken = 'access token';
  assert.throws(() => validateTarget(d), (e) => e.code === 'INVALID_FORMAT');
});

test('TGT-16 an incomplete field map is refused, naming the missing entry', () => {
  const d = validTarget();
  d.auth.claims = { tenant: 'tid' };
  assert.throws(() => validateTarget(d), (e) => e.code === 'MISSING_FIELD' && e.field === 'auth.claims.user');

  const d2 = validTarget();
  d2.auth.loginFields = { email: 'email' };
  assert.throws(() => validateTarget(d2), (e) => e.field === 'auth.loginFields.password');

  const d3 = validTarget();
  d3.auth.accessFields = { screenCode: 's' };
  assert.throws(() => validateTarget(d3), (e) => e.code === 'MISSING_FIELD');
});

test('TGT-17 an array where an object is required is refused', () => {
  const d = validTarget();
  d.auth.accessFields = ['screen_code'];
  assert.throws(() => validateTarget(d), (e) => e.code === 'INVALID_TYPE');

  const d2 = validTarget();
  d2.auth = [];
  assert.throws(() => validateTarget(d2), (e) => e.code === 'MISSING_SECTION');

  const d3 = validTarget();
  d3.redis = 'sess:';
  assert.throws(() => validateTarget(d3), (e) => e.code === 'MISSING_SECTION' && e.field === 'redis');
});

test('TGT-18 missing Redis prefixes are refused', () => {
  for (const field of ['sessionPrefix', 'tokenPrefix', 'tenantPrefix']) {
    const d = validTarget();
    delete d.redis[field];
    assert.throws(() => validateTarget(d), (e) => e.code === 'MISSING_FIELD' && e.field === `redis.${field}`);
  }
});

test('TGT-19 an over-long value is refused', () => {
  const d = validTarget();
  d.displayName = 'x'.repeat(200);
  assert.throws(() => validateTarget(d), (e) => e.code === 'FIELD_TOO_LONG');
});

// ------------------------------------------------------------------------------------------
// TGT-20  Errors never echo the offending value
// ------------------------------------------------------------------------------------------

test('TGT-20 no error message ever contains the value that caused it', () => {
  const secretish = 'https://private.staging.example.test/real?token=abc123';
  const attempts = [
    () => { const d = validTarget(); d.auth.loginPath = secretish; return validateTarget(d); },
    () => { const d = validTarget(); d.baseUrl = secretish; return validateTarget(d); },
    () => { const d = validTarget(); d.auth.fields.accessToken = secretish; return validateTarget(d); },
    () => { const d = validTarget(); d.redis.sessionPrefix = secretish; return validateTarget(d); },
    () => { const d = validTarget(); d.auth.logoutSuccessStatus = secretish; return validateTarget(d); },
  ];
  for (const attempt of attempts) {
    let caught = null;
    try {
      attempt();
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof TargetConfigError, 'expected a TargetConfigError');
    assert.ok(!caught.message.includes(secretish), `message leaked the value: ${caught.message}`);
    assert.ok(caught.code, 'every error carries a code');
  }
});

// ------------------------------------------------------------------------------------------
// TGT-21  Loading from disk
// ------------------------------------------------------------------------------------------

test('TGT-21 an unknown target name is refused without echoing the name', () => {
  assert.throws(() => loadTarget('does-not-exist'), (e) => e.code === 'TARGET_NOT_READABLE');
});

test('TGT-22 a target name that is not a safe identifier is refused', () => {
  for (const bad of ['../secrets', 'a/b', '..', '']) {
    let caught = null;
    try {
      loadTarget(bad);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof TargetConfigError);
    assert.ok(!caught.message.includes('secret'), `message leaked: ${caught.message}`);
  }
});

test('TGT-23 invalid JSON is refused as INVALID_JSON', () => {
  const file = path.join(require('node:os').tmpdir(), `atf-bad-${process.pid}.json`);
  fs.writeFileSync(file, '{ not json');
  try {
    assert.throws(() => loadTargetFile(file), (e) => e.code === 'INVALID_JSON');
  } finally {
    fs.unlinkSync(file);
  }
});

test('TGT-24 the real descriptors on disk all validate', () => {
  const names = listTargets();
  assert.ok(names.length > 0, 'there must be at least one configured target');
  for (const name of names) {
    const t = loadTarget(name);
    assert.strictEqual(t.name, name, `${name}.json declares a matching name`);
  }
});

test('TGT-25 the targets directory is overridable so tests need not depend on the real layout', () => {
  assert.strictEqual(targetsDir({}), DEFAULT_TARGETS_DIR);
  assert.strictEqual(targetsDir({ ATF_TARGETS_DIR: 'config/targets' }), path.resolve('config/targets'));
  assert.deepStrictEqual(listTargets({ ATF_TARGETS_DIR: path.join(__dirname, 'no-such-dir') }), []);
});

// ------------------------------------------------------------------------------------------
// TGT-26  describeTarget
// ------------------------------------------------------------------------------------------

test('TGT-26 describeTarget reports paths and flags but no host and no credential', () => {
  const d = describeTarget(validateTarget(validTarget()));
  assert.deepStrictEqual(d.paths, {
    login: '/login', refresh: '/refresh', logout: '/logout', me: '/me', access: '/me/access',
  });
  assert.strictEqual(d.cookieAuth, true);
  assert.strictEqual(d.expiresFormat, 'datetime');
  assert.ok(!JSON.stringify(d).includes('password'), 'no credential in the description');
  assert.ok(!('baseUrl' in d), 'no host in the description');
});

// ------------------------------------------------------------------------------------------
// TGT-27  Redis key composition
// ------------------------------------------------------------------------------------------

test('TGT-27 the target prefix alone is the key prefix with no environment applied', () => {
  const t = validateTarget(validTarget());
  assert.strictEqual(composeKeyPrefix(t), 'sess:');
  assert.strictEqual(sessionKey(t, 'abc'), 'sess:abc');
});

test('TGT-28 the environment namespace and deployment prefix come before the target prefix', () => {
  const t = validateTarget(validTarget());
  assert.strictEqual(composeKeyPrefix(t, { namespace: 'qa:fx1' }), 'qa:fx1sess:');
  assert.strictEqual(composeKeyPrefix(t, { deploymentPrefix: 'dev:' }), 'dev:sess:');
  assert.strictEqual(composeKeyPrefix(t, { namespace: 'qa:fx1', deploymentPrefix: 'dev:' }), 'dev:qa:fx1sess:');
});

test('TGT-29 empty and absent environment parts are skipped rather than leaving a stray separator', () => {
  const t = validateTarget(validTarget());
  for (const empty of [null, undefined, '']) {
    assert.strictEqual(composeKeyPrefix(t, { namespace: empty, deploymentPrefix: empty }), 'sess:');
  }
});

test('TGT-30 the composed key uses the target prefix, not a prefix copied into the environment', () => {
  const a = validateTarget(validTarget());
  const b = validateTarget(validTarget({ redis: { sessionPrefix: 'other/', tokenPrefix: 't/', tenantPrefix: 'o/' } }));
  assert.notStrictEqual(sessionKey(a, 'x', { namespace: 'ns:' }), sessionKey(b, 'x', { namespace: 'ns:' }));
  assert.strictEqual(sessionKey(b, 'x', { namespace: 'ns:' }), 'ns:other/x');
});
