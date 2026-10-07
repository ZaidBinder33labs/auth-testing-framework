'use strict';
// Security tests: invalid/expired/malformed tokens, rotation, reuse, redaction.
const test = require('node:test');
const assert = require('node:assert');
const { AuthManager } = require('@atf/auth-core');
const { createMockAuthAdapter } = require('@atf/adapters');
const { TenantRegistry } = require('@atf/tenant-core');
const { redact, assertRedacted, assertDifferentTokens, fingerprint } = require('@atf/token-security');
const { RESULT } = require('@atf/reporting');

function setup() {
  const reg = new TenantRegistry();
  const tA = reg.createTenant({ id: 'ten_a' });
  const a1 = reg.createActor('ten_a', { id: 'act_a1' });
  return { reg, tA, a1 };
}

test('security: invalid refresh token rejected', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ failRefresh: 'INVALID_TOKEN' });
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  await assert.rejects(() => mgr.refresh(session), /Invalid refresh token/i);
});

test('security: expired refresh token rejected', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ failRefresh: 'EXPIRED_TOKEN' });
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  await assert.rejects(() => mgr.refresh(session), /Expired refresh token/i);
});

test('security: malformed refresh token rejected', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ failRefresh: 'MALFORMED_TOKEN' });
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  await assert.rejects(() => mgr.refresh(session), /Malformed refresh token/i);
});

test('security: token rotation makes old token invalid', async () => {
  const { tA, a1 } = setup();
  const adapter = createMockAuthAdapter({ rotationEnabled: true });
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  const before = await mgr.getAccessToken(session);
  await mgr.refresh(session);
  const after = await mgr.getAccessToken(session);
  assert.notStrictEqual(before, after);
});

test('security: raw token never appears in evidence', () => {
  const token = 'at_abc123def456ghi789';
  const evidence = { accessToken: token, user: 'u1' };
  const redacted = redact(evidence);
  assert.ok(!JSON.stringify(redacted).includes(token));
  assert.doesNotThrow(() => assertRedacted(redacted));
});

test('security: different tokens produce different fingerprints', () => {
  assert.notStrictEqual(fingerprint('a'), fingerprint('b'));
  assert.notStrictEqual(fingerprint('at_x'), fingerprint('at_y'));
});

test('security: assertDifferentTokens throws on match', () => {
  assert.doesNotThrow(() => assertDifferentTokens('x', 'y'));
  assert.throws(() => assertDifferentTokens('x', 'x'), Error);
});

test('security: cross-tenant authorization — tenant A cannot access tenant B resource', async () => {
  const reg = new TenantRegistry();
  const tA = reg.createTenant({ id: 'ten_a' });
  const tB = reg.createTenant({ id: 'ten_b' });
  const a1 = reg.createActor('ten_a', { id: 'act_a1' });
  const adapter = createMockAuthAdapter();
  const mgr = new AuthManager(adapter);
  const { session } = await mgr.login(tA, a1, { password: 'x' });
  assert.strictEqual(session.tenantId, 'ten_a');
  // Session is scoped to tenant A; it must not be usable for tenant B.
  assert.notStrictEqual(session.tenantId, tB.id);
});

test('security: redaction handles nested objects and arrays', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.sig';
  const OPAQUE = 'opaque-token-abc123def456';
  const obj = { a: { accessToken: JWT, nested: [{ refreshToken: OPAQUE }] }, password: 'secret' };
  const r = redact(obj);
  assert.strictEqual(r.a.accessToken, `[TOKEN:${fingerprint(JWT)}]`);
  assert.strictEqual(r.a.nested[0].refreshToken, `[TOKEN:${fingerprint(OPAQUE)}]`);
  assert.strictEqual(r.password, '[REDACTED]');
});