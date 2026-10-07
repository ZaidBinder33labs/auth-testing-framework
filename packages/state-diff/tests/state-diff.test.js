'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CHANGE_TYPES, diffSnapshots, hasType, keysOfType } = require('../src');

const before = {
  'sess:a': { type: 'hash', value: 'v1', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-a' },
  'sess:b': { type: 'hash', value: 'v2', ttl: 3600, tenantId: 'ten_b', sessionId: 'sess-b' },
  'tok:x': { type: 'string', value: 'tk1', ttl: 7200, tenantId: 'ten_a', sessionId: 'sess-a' },
};

test('state-diff: UNCHANGED when nothing changes', () => {
  const after = { ...before };
  const s = diffSnapshots(before, after);
  assert.strictEqual(s.added.length, 0);
  assert.strictEqual(s.removed.length, 0);
  assert.strictEqual(s.modified.length, 0);
  assert.strictEqual(s.unchanged.length, 3);
});

test('state-diff: ADDED detected', () => {
  const after = { ...before, 'sess:c': { type: 'hash', value: 'v3', ttl: 3600, tenantId: 'ten_a', sessionId: 'sess-c' } };
  const s = diffSnapshots(before, after);
  assert.strictEqual(s.added.length, 1);
  assert.deepStrictEqual(s.added, ['sess:c']);
  assert.strictEqual(hasType(s, CHANGE_TYPES.ADDED), true);
});

test('state-diff: REMOVED detected', () => {
  const after = { 'sess:a': before['sess:a'], 'tok:x': before['tok:x'] };
  const s = diffSnapshots(before, after);
  assert.strictEqual(s.removed.length, 1);
  assert.deepStrictEqual(s.removed, ['sess:b']);
  assert.strictEqual(hasType(s, CHANGE_TYPES.REMOVED), true);
});

test('state-diff: MODIFIED detected on value change', () => {
  const after = { ...before, 'sess:a': { ...before['sess:a'], value: 'v1-new' } };
  const s = diffSnapshots(before, after);
  assert.strictEqual(s.modified.length, 1);
  assert.deepStrictEqual(s.modified, ['sess:a']);
  assert.strictEqual(hasType(s, CHANGE_TYPES.MODIFIED), true);
});

test('state-diff: TTL_CHANGED detected', () => {
  const after = { ...before, 'sess:a': { ...before['sess:a'], ttl: 3000 } };
  const s = diffSnapshots(before, after);
  assert.strictEqual(hasType(s, CHANGE_TYPES.TTL_CHANGED), true);
  assert.deepStrictEqual(keysOfType(s, CHANGE_TYPES.TTL_CHANGED), ['sess:a']);
});

test('state-diff: TYPE_CHANGED detected', () => {
  const after = { ...before, 'sess:a': { ...before['sess:a'], type: 'string' } };
  const s = diffSnapshots(before, after);
  assert.strictEqual(hasType(s, CHANGE_TYPES.TYPE_CHANGED), true);
});

test('state-diff: TENANT_CHANGED detected', () => {
  const after = { ...before, 'sess:a': { ...before['sess:a'], tenantId: 'ten_c' } };
  const s = diffSnapshots(before, after);
  assert.strictEqual(hasType(s, CHANGE_TYPES.TENANT_CHANGED), true);
});

test('state-diff: SESSION_CHANGED detected', () => {
  const after = { ...before, 'sess:a': { ...before['sess:a'], sessionId: 'sess-a2' } };
  const s = diffSnapshots(before, after);
  assert.strictEqual(hasType(s, CHANGE_TYPES.SESSION_CHANGED), true);
});

test('state-diff: nested field changes classified as MODIFIED', () => {
  const b = { 'h:1': { type: 'hash', fields: { a: '1', b: '2' }, ttl: 100, tenantId: 't', sessionId: 's' } };
  const a = { 'h:1': { type: 'hash', fields: { a: '1', b: '3' }, ttl: 100, tenantId: 't', sessionId: 's' } };
  const s = diffSnapshots(b, a);
  assert.strictEqual(s.modified.length, 1);
});

test('state-diff: missing fields (empty before) handled', () => {
  const s = diffSnapshots({}, before);
  assert.strictEqual(s.added.length, 3);
  assert.strictEqual(s.removed.length, 0);
});

test('state-diff: extra fields (empty after) handled', () => {
  const s = diffSnapshots(before, {});
  assert.strictEqual(s.added.length, 0);
  assert.strictEqual(s.removed.length, 3);
});