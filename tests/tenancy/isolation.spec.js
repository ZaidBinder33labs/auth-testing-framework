'use strict';
// Multi-tenant isolation and cross-tenant contamination tests.
const test = require('node:test');
const assert = require('node:assert');
const { validateNoCrossTenantContamination, validateExpectedTenantChange, validateSessionIsolation, ISOLATION_RESULTS } = require('@atf/isolation-engine');
const { diffSnapshots } = require('@atf/state-diff');

function snapshot(entries) {
  const out = {};
  for (const e of entries) out[e.key] = e;
  return out;
}

test('tenancy: tenant A unchanged when tenant B acts', () => {
  const before = snapshot([
    { key: 'sess:a', type: 'hash', value: 'va', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a' },
    { key: 'sess:b', type: 'hash', value: 'vb', ttl: 3600, tenantId: 'ten_b', sessionId: 'sess-b' },
  ]);
  const after = snapshot([
    { key: 'sess:a', type: 'hash', value: 'va', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a' },
    { key: 'sess:b', type: 'hash', value: 'vb', ttl: 3600, tenantId: 'ten_b', sessionId: 'sess-b' },
    { key: 'sess:a2', type: 'hash', value: 'va2', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a2' },
  ]);
  const r = validateNoCrossTenantContamination(before, after, 'ten_a', { tenants: ['ten_a', 'ten_b'] });
  assert.strictEqual(r.result, ISOLATION_RESULTS.PASS);
});

test('tenancy: unexpected cross-tenant state change detected', () => {
  const before = snapshot([
    { key: 'sess:a', type: 'hash', value: 'va', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a' },
    { key: 'sess:b', type: 'hash', value: 'vb', ttl: 3600, tenantId: 'ten_b', sessionId: 'sess-b' },
  ]);
  const after = snapshot([
    { key: 'sess:a', type: 'hash', value: 'va', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a' },
    { key: 'sess:b', type: 'hash', value: 'vb-changed', ttl: 3600, tenantId: 'ten_b', sessionId: 'sess-b' },
  ]);
  const r = validateNoCrossTenantContamination(before, after, 'ten_a', { tenants: ['ten_a', 'ten_b'] });
  assert.strictEqual(r.result, ISOLATION_RESULTS.FAIL);
  assert.ok(r.contamination.some((c) => c.tenant === 'ten_b'));
});

test('tenancy: expected tenant state change passes', () => {
  const before = snapshot([
    { key: 'sess:a', type: 'hash', value: 'va', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a' },
  ]);
  const after = snapshot([
    { key: 'sess:a', type: 'hash', value: 'va', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a' },
    { key: 'sess:a2', type: 'hash', value: 'va2', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a2' },
  ]);
  const r = validateExpectedTenantChange(before, after, 'ten_a', { expectChange: true });
  assert.strictEqual(r.result, ISOLATION_RESULTS.PASS);
});

test('tenancy: session isolation — logout A leaves B valid', () => {
  const before = snapshot([
    { key: 'sess:a', type: 'hash', value: 'va', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a' },
    { key: 'sess:b', type: 'hash', value: 'vb', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-b' },
  ]);
  const after = snapshot([
    { key: 'sess:b', type: 'hash', value: 'vb', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-b' },
  ]);
  const r = validateSessionIsolation(before, after, [{ id: 'sess-a' }, { id: 'sess-b' }], { loggedOutSessionId: 'sess-a', tenantId: 'ten_a' });
  assert.strictEqual(r.result, ISOLATION_RESULTS.PASS);
});

test('tenancy: cross-tenant resource access via diff', () => {
  const before = snapshot([
    { key: 'tok:a', type: 'string', value: 'ta', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a' },
    { key: 'tok:b', type: 'string', value: 'tb', ttl: 3600, tenantId: 'ten_b', sessionId: 'sess-b' },
  ]);
  const after = snapshot([
    { key: 'tok:a', type: 'string', value: 'ta', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a' },
    { key: 'tok:b', type: 'string', value: 'tb', ttl: 3600, tenantId: 'ten_b', sessionId: 'sess-b' },
  ]);
  const diff = diffSnapshots(before, after);
  assert.strictEqual(diff.added.length, 0);
  assert.strictEqual(diff.removed.length, 0);
  assert.strictEqual(diff.modified.length, 0);
});