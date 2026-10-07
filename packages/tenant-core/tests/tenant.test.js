'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TenantRegistry, Tenant, Actor, TenantValidationError, validateTenantId, validateActorId } = require('../src');

test('tenant-core: create and fetch tenant', () => {
  const reg = new TenantRegistry();
  const t = reg.createTenant({ id: 'ten_alpha', name: 'Alpha' });
  assert.strictEqual(t.id, 'ten_alpha');
  assert.strictEqual(t.name, 'Alpha');
  assert.strictEqual(reg.getTenant('ten_alpha'), t);
  assert.strictEqual(reg.getTenant('ten_missing'), null);
});

test('tenant-core: generated id matches format', () => {
  const reg = new TenantRegistry();
  const t = reg.createTenant();
  assert.match(t.id, /^ten_[a-z0-9_]{3,64}$/i);
});

test('tenant-core: duplicate tenant throws', () => {
  const reg = new TenantRegistry();
  reg.createTenant({ id: 'ten_dup' });
  assert.throws(() => reg.createTenant({ id: 'ten_dup' }), TenantValidationError);
});

test('tenant-core: missing tenant throws on require', () => {
  const reg = new TenantRegistry();
  assert.throws(() => reg.requireTenant('ten_nope'), TenantValidationError);
});

test('tenant-core: invalid tenant id format rejected', () => {
  assert.throws(() => validateTenantId('123'), TenantValidationError);
  assert.throws(() => validateTenantId('ten-foo'), TenantValidationError);
  assert.throws(() => validateTenantId('ten with spaces'), TenantValidationError);
  assert.doesNotThrow(() => validateTenantId('ten_alpha_1'));
});

test('tenant-core: actor belongs to tenant', () => {
  const reg = new TenantRegistry();
  const t = reg.createTenant({ id: 'ten_a' });
  const a = reg.createActor('ten_a', { id: 'act_a1', label: 'A1' });
  assert.strictEqual(a.tenantId, 'ten_a');
  assert.strictEqual(a.belongsTo(t), true);
  assert.strictEqual(t.getActor('act_a1'), a);
  assert.strictEqual(t.hasActor('act_a1'), true);
  assert.strictEqual(t.hasActor('act_missing'), false);
});

test('tenant-core: actor cannot belong to wrong tenant', () => {
  const reg = new TenantRegistry();
  const tA = reg.createTenant({ id: 'ten_a' });
  const tB = reg.createTenant({ id: 'ten_b' });
  const a = new Actor({ id: 'act_a1', tenantId: 'ten_a', label: 'A1' });
  assert.strictEqual(a.belongsTo(tA), true);
  assert.strictEqual(a.belongsTo(tB), false);
});

test('tenant-core: duplicate actor in same tenant throws', () => {
  const reg = new TenantRegistry();
  reg.createTenant({ id: 'ten_a' });
  reg.createActor('ten_a', { id: 'act_a1' });
  assert.throws(() => reg.createActor('ten_a', { id: 'act_a1' }), TenantValidationError);
});

test('tenant-core: invalid actor id rejected', () => {
  assert.throws(() => validateActorId('foo'), TenantValidationError);
  assert.throws(() => validateActorId('act-foo'), TenantValidationError);
  assert.doesNotThrow(() => validateActorId('act_a1'));
});

test('tenant-core: tenant context switching returns tenant', () => {
  const reg = new TenantRegistry();
  reg.createTenant({ id: 'ten_a' });
  reg.createTenant({ id: 'ten_b' });
  const switched = reg.switchTenant('ten_b');
  assert.strictEqual(switched.id, 'ten_b');
  assert.throws(() => reg.switchTenant('ten_missing'), TenantValidationError);
});

test('tenant-core: remove tenant', () => {
  const reg = new TenantRegistry();
  reg.createTenant({ id: 'ten_a' });
  assert.strictEqual(reg.removeTenant('ten_a'), true);
  assert.strictEqual(reg.getTenant('ten_a'), null);
  assert.strictEqual(reg.removeTenant('ten_a'), false);
});

test('tenant-core: list tenants', () => {
  const reg = new TenantRegistry();
  reg.createTenant({ id: 'ten_a' });
  reg.createTenant({ id: 'ten_b' });
  const list = reg.listTenants();
  assert.strictEqual(list.length, 2);
  assert.ok(list.find((t) => t.id === 'ten_a'));
  assert.ok(list.find((t) => t.id === 'ten_b'));
});