'use strict';
/**
 * No descriptor may carry a credential.
 *
 * Credentials are environment variables, full stop: never in a target descriptor, never in an
 * environment descriptor, never in a policy. This is the test that says so about every file under
 * config/, present and future, rather than about the files that exist today.
 *
 * The scan walks the parsed JSON rather than grepping the text, because a target descriptor
 * legitimately contains the *word* "password": auth.loginFields maps the framework's credential
 * names onto the application's field names, so {"password": "password"} means "the application
 * calls it password" and stores nothing. Those maps are held to a different rule instead: every
 * value in them must be a bare identifier, which by construction cannot be a secret.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONFIG_DIR = path.join(ROOT, 'config');

/** Descriptor keys whose contents are remote field names, not stored values. */
const FIELD_MAP_KEYS = new Set(['loginFields', 'userFields', 'accessFields', 'claims', 'fields']);

/** Key names that would indicate a value was stored rather than named. */
const CREDENTIAL_KEY_RE = /^(?:password|passwd|pwd|secret|token|apiKey|api_key|accessKey|access_key|privateKey|private_key|clientSecret|client_secret|bearer|authorization|credential|credentials|passphrase|refreshToken|accessToken)$/i;

/** Keys allowed to name a credential, because they only ever point at an environment variable. */
const CREDENTIAL_NAMING_KEY_RE = /(?:Env|EnvVar|EnvVars|Variables?)$/;

/** An identifier: what a remote field name must be. */
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** An env-var name in the shape the framework documents: UPPER_SNAKE. */
const ENV_VAR_SHAPE_RE = /^[A-Z][A-Z0-9_]*$/;

const URL_RE = /^https?:\/\//i;

/** Every descriptor under config/, parsed. */
function descriptors(dir = CONFIG_DIR, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) descriptors(p, out);
    else if (entry.name.endsWith('.json')) {
      out.push({ relative: path.relative(ROOT, p).replace(/\\/g, '/'), data: JSON.parse(fs.readFileSync(p, 'utf8')) });
    }
  }
  return out;
}

/** Every { key, value, path, inFieldMap } string in a descriptor. */
function walk(node, { path: at = '$', inFieldMap = false } = {}, out = []) {
  if (node === null || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    const here = `${at}.${key}`;
    const asMap = inFieldMap || FIELD_MAP_KEYS.has(key);
    if (typeof value === 'string') {
      out.push({ key, value, path: here, inFieldMap: asMap });
    } else {
      walk(value, { path: here, inFieldMap: asMap }, out);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// CRED-01  The scan actually reaches the descriptors
// ------------------------------------------------------------------------------------------

test('CRED-01 the descriptor tree is found and is not empty', () => {
  const files = descriptors();
  assert.ok(files.length > 0, 'there must be at least one descriptor to scan');
  assert.ok(files.every((f) => f.relative.startsWith('config/')), 'only descriptors under config/ are scanned');
});

test('CRED-02 the walk finds the strings it is meant to inspect', () => {
  // Guards the guard: if the walk returned nothing, every assertion below would pass vacuously.
  const found = descriptors().flatMap((f) => walk(f.data));
  assert.ok(found.length > 10, `expected the walk to find strings, found ${found.length}`);
  assert.ok(found.some((s) => s.inFieldMap), 'field-name maps must be recognised');
  assert.ok(found.some((s) => !s.inFieldMap), 'non-field strings must be inspected too');
});

// ------------------------------------------------------------------------------------------
// CRED-03  Credentials
// ------------------------------------------------------------------------------------------

test('CRED-03 no descriptor stores a credential under a credential-named key', () => {
  for (const { relative, data } of descriptors()) {
    for (const { key, value, path: at, inFieldMap } of walk(data)) {
      if (inFieldMap) continue;
      if (!CREDENTIAL_KEY_RE.test(key)) continue;
      assert.ok(
        CREDENTIAL_NAMING_KEY_RE.test(key),
        `${relative}: ${at} stores a credential under a credential-named key; name the environment variable instead`
      );
      assert.strictEqual(value, '', `${relative}: ${at} has a value on a credential-named key`);
    }
  }
});

test('CRED-04 every remote field name is a bare identifier, so it cannot be a secret', () => {
  for (const { relative, data } of descriptors()) {
    for (const { value, path: at, inFieldMap } of walk(data)) {
      if (!inFieldMap) continue;
      assert.ok(
        FIELD_NAME_RE.test(value),
        `${relative}: ${at} is '${value}', which is not a bare field name`
      );
    }
  }
});

test('CRED-05 where a credential is named, the name is an environment variable', () => {
  for (const { relative, data } of descriptors()) {
    for (const { key, value, path: at } of walk(data)) {
      // Only keys that genuinely point at a secret are held to this rule. A Redis key prefix such
      // as tokenPrefix is a naming convention, not a value, and is exempt: it is data the
      // application itself writes and belongs in the target descriptor.
      const namesAVariable = CREDENTIAL_NAMING_KEY_RE.test(key);
      if (!namesAVariable) continue;
      assert.ok(
        ENV_VAR_SHAPE_RE.test(value),
        `${relative}: ${at} names a credential but holds '${value}', which is not an env-var name`
      );
    }
  }
});

test('CRED-06 no descriptor key both looks like a credential and holds a value', () => {
  // A key named exactly like a secret, with a non-empty value, is the shape of a leak.
  // Prefix-style keys (tokenPrefix) are exempt for the reason given in CRED-05.
  for (const { relative, data } of descriptors()) {
    for (const { key, value, path: at, inFieldMap } of walk(data)) {
      if (inFieldMap) continue;
      if (/Prefix$/i.test(key)) continue;
      if (!CREDENTIAL_KEY_RE.test(key)) continue;
      assert.strictEqual(value, '', `${relative}: ${at} holds a value on the credential key '${key}'`);
    }
  }
});

test('CRED-06 no descriptor embeds a URL', () => {
  for (const { relative, data } of descriptors()) {
    for (const { value, path: at } of walk(data)) {
      assert.ok(
        !URL_RE.test(value),
        `${relative}: ${at} embeds a URL ('${value.slice(0, 12)}...'); a host belongs to an environment`
      );
    }
  }
});

test('CRED-07 no descriptor value resembles a token, key or other opaque secret', () => {
  for (const { relative, data } of descriptors()) {
    for (const { value, path: at } of walk(data)) {
      if (value.length < 16) continue;
      // Three dot-separated base64url segments is a JWT shape.
      assert.ok(
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value),
        `${relative}: ${at} holds a JWT-shaped value`
      );
      assert.ok(!value.includes('-----BEGIN'), `${relative}: ${at} holds PEM key material`);
      assert.ok(!/^[A-Za-z0-9+/=]{40,}$/.test(value), `${relative}: ${at} holds a long opaque value`);
      // A value with whitespace is prose, not a secret, and is allowed.
      assert.ok(!/^[^\s]{16,}$/.test(value) || /\s/.test(value) || value.length <= 64);
    }
  }
});

test('CRED-08 descriptor prose mentions no credential value', () => {
  // Descriptions are free text and are the easiest place to paste something by accident.
  for (const { relative, data } of descriptors()) {
    for (const { key, value } of walk(data)) {
      if (!/description|summary|note|comment/i.test(key)) continue;
      assert.ok(!/-----BEGIN|\beyJ[A-Za-z0-9_-]{10,}/.test(value), `${relative}: prose in '${key}' looks like key material`);
      assert.ok(!URL_RE.test(value), `${relative}: prose in '${key}' contains a URL`);
    }
  }
});

// ------------------------------------------------------------------------------------------
// CRED-09  Defence in depth
// ------------------------------------------------------------------------------------------

test('CRED-09 the loader has nowhere to put a credential that was injected anyway', () => {
  const { validateTarget } = require('@atf/target-config');
  const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'targets', 'binder.json'), 'utf8'));
  raw.password = 'hunter2';
  raw.auth.token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
  raw.auth.fields.secret = 'another-secret-value';

  const target = validateTarget(raw);
  const serialised = JSON.stringify(target);

  assert.ok(!serialised.includes('hunter2'), 'an injected password must not survive normalisation');
  assert.ok(!serialised.includes('eyJhbGciOiJIUzI1NiJ9'), 'an injected token must not survive normalisation');
  assert.ok(!serialised.includes('another-secret-value'), 'an injected secret field must not survive');
  assert.ok(!('password' in target), 'no credential key exists on the normalised descriptor');
});

test('CRED-10 a descriptor carrying a base URL is refused outright', () => {
  const { validateTarget } = require('@atf/target-config');
  const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'targets', 'binder.json'), 'utf8'));
  raw.baseUrl = 'https://private.example.test';
  assert.throws(() => validateTarget(raw), (e) => e.code === 'BASE_URL_NOT_ALLOWED');
});