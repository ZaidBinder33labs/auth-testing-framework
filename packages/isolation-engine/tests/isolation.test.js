'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateNoCrossTenantContamination, validateExpectedTenantChange, validateSessionIsolation, ISOLATION_RESULTS } = require('../src');

const before = {
  'sess:a': { type: 'hash', value: 'va', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a' },
  'sess:b': { type: 'hash', value: 'vb', ttl: 3600, tenantId: 'ten_b', sessionId: 'sess-b' },
};

test('isolation: tenant A unchanged when tenant B acts', () => {
  const after = { ...before, 'sess:a2': { type: 'hash', value: 'va2', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a2' } };
  const r = validateNoCrossTenantContamination(before, after, 'ten_a', { tenants: ['ten_a', 'ten_b'] });
  assert.strictEqual(r.result, ISOLATION_RESULTS.PASS);
  assert.strictEqual(r.contamination.length, 0);
});

test('isolation: unexpected cross-tenant state change detected', () => {
  const after = { ...before, 'sess:b2': { type: 'hash', value: 'vb2', ttl: 3600, tenantId: 'ten_b', sessionId: 'sess-b2' } };
  const r = validateNoCrossTenantContamination(before, after, 'ten_a', { tenants: ['ten_a', 'ten_b'] });
  assert.strictEqual(r.result, ISOLATION_RESULTS.FAIL);
  assert.ok(r.contamination.some((c) => c.tenant === 'ten_b'));
});

test('isolation: expected tenant change passes', () => {
  const after = { ...before, 'sess:a2': { type: 'hash', value: 'va2', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a2' } };
  const r = validateExpectedTenantChange(before, after, 'ten_a', { expectChange: true });
  assert.strictEqual(r.result, ISOLATION_RESULTS.PASS);
  assert.strictEqual(r.added.length, 1);
});

test('isolation: session isolation — logout A leaves B valid', () => {
  const after = {
    'sess:a': { type: 'hash', value: 'va', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a' }, // would be removed in real state
    'sess:b': { type: 'hash', value: 'vb', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-b' },
  };
  const sessions = [{ id: 'sess-a' }, { id: 'sess-b' }];
  const r = validateSessionIsolation(before, after, sessions, { loggedOutSessionId: 'sess-a', tenantId: 'ten_a' });
  // sess-a is still present in after → FAIL (contamination)
  assert.strictEqual(r.result, ISOLATION_RESULTS.FAIL);
  assert.ok(r.issues.some((i) => i.issue === 'SESSION_STILL_ACTIVE_AFTER_LOGOUT'));
});

test('isolation: session isolation — A removed, B remains', () => {
  const after = {
    'sess:b': { type: 'hash', value: 'vb', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-b' },
  };
  const sessions = [{ id: 'sess-a' }, { id: 'sess-b' }];
  const r = validateSessionIsolation(before, after, sessions, { loggedOutSessionId: 'sess-a', tenantId: 'ten_a' });
  assert.strictEqual(r.result, ISOLATION_RESULTS.PASS);
});