'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildRegistry, get, TENANTS, ACTORS } = require('../src');

test('fixtures: buildRegistry creates all tenants and actors', () => {
  const reg = buildRegistry();
  assert.strictEqual(reg.listTenants().length, 3);
  assert.ok(reg.getTenant('ten_a'));
  assert.ok(reg.getTenant('ten_b'));
  assert.ok(reg.getTenant('ten_c'));
});

test('fixtures: actor belongs to correct tenant', () => {
  const reg = buildRegistry();
  const { tenant: tA, actor: a1 } = get(reg, 'ten_a', 'act_a1');
  assert.strictEqual(a1.tenantId, 'ten_a');
  assert.strictEqual(a1.belongsTo(tA), true);
  const { tenant: tB } = get(reg, 'ten_b', 'act_b1');
  assert.strictEqual(a1.belongsTo(tB), false);
});

test('fixtures: all actors present', () => {
  const reg = buildRegistry();
  for (const a of ACTORS) {
    assert.ok(reg.getTenant(a.tenantId).getActor(a.id), `missing ${a.id}`);
  }
});

test('fixtures: TENANTS and ACTORS are immutable', () => {
  assert.ok(Object.isFrozen(TENANTS));
  assert.ok(Object.isFrozen(ACTORS));
});