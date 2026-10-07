'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  fingerprint,
  fingerprintFull,
  sameToken,
  isOpaque,
  isJwtLike,
  inspect,
  redact,
  assertRedacted,
  assertDifferentTokens,
  TokenFingerprintError,
} = require('../src');

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAwMDB9.signature';
const OPAQUE = 'opaque-token-abc123def456';

test('token-security: fingerprint is deterministic', () => {
  assert.strictEqual(fingerprint(JWT), fingerprint(JWT));
  assert.strictEqual(fingerprint(OPAQUE), fingerprint(OPAQUE));
});

test('token-security: different tokens produce different fingerprints', () => {
  assert.notStrictEqual(fingerprint(JWT), fingerprint(OPAQUE));
  assert.notStrictEqual(fingerprint('a'), fingerprint('b'));
});

test('token-security: sameToken matches identical tokens', () => {
  assert.strictEqual(sameToken(JWT, JWT), true);
  assert.strictEqual(sameToken(JWT, OPAQUE), false);
});

test('token-security: raw token never appears in serialized evidence', () => {
  const evidence = { token: JWT, user: 'u1' };
  const redacted = redact(evidence);
  assert.strictEqual(redacted.token, `[TOKEN:${fingerprint(JWT)}]`);
  assert.ok(!JSON.stringify(redacted).includes(JWT));
  assert.doesNotThrow(() => assertRedacted(redacted));
});

test('token-security: redaction handles nested objects and arrays', () => {
  const obj = { a: { accessToken: JWT, nested: [{ refreshToken: OPAQUE }] }, password: 'secret' };
  const r = redact(obj);
  assert.strictEqual(r.a.accessToken, `[TOKEN:${fingerprint(JWT)}]`);
  assert.strictEqual(r.a.nested[0].refreshToken, `[TOKEN:${fingerprint(OPAQUE)}]`);
  assert.strictEqual(r.password, '[REDACTED]');
});

test('token-security: malformed token handling does not throw', () => {
  assert.strictEqual(isJwtLike('not-a-jwt'), false);
  assert.strictEqual(isOpaque('not-a-jwt'), true);
  assert.strictEqual(isJwtLike(JWT), true);
  assert.strictEqual(isOpaque(JWT), false);
});

test('token-security: JWT inspection extracts claims', () => {
  const info = inspect(JWT);
  assert.strictEqual(info.kind, 'JWT');
  assert.strictEqual(info.claims.subject, 'user');
  assert.strictEqual(info.claims.issuedAt, 1700000000);
  assert.ok(typeof info.fingerprint === 'string' && info.fingerprint.length === 16);
});

test('token-security: opaque token inspection', () => {
  const info = inspect(OPAQUE);
  assert.strictEqual(info.kind, 'OPAQUE');
  assert.strictEqual(info.length, OPAQUE.length);
});

test('token-security: assertDifferentTokens throws on match', () => {
  assert.doesNotThrow(() => assertDifferentTokens(JWT, OPAQUE));
  assert.throws(() => assertDifferentTokens(JWT, JWT), TokenFingerprintError);
});

test('token-security: fingerprint rejects null', () => {
  assert.throws(() => fingerprint(null), TokenFingerprintError);
  assert.throws(() => fingerprint(undefined), TokenFingerprintError);
});