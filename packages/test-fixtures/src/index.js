'use strict';
// Deterministic test data and fixtures for self-tests.
// Never hard-code real credentials.
const { TenantRegistry } = require('@atf/tenant-core');

const TENANTS = Object.freeze([
  { id: 'ten_a', name: 'Tenant A' },
  { id: 'ten_b', name: 'Tenant B' },
  { id: 'ten_c', name: 'Tenant C' },
]);

const ACTORS = Object.freeze([
  { tenantId: 'ten_a', id: 'act_a1', label: 'User A1', email: 'a1@example.test' },
  { tenantId: 'ten_a', id: 'act_a2', label: 'User A2', email: 'a2@example.test' },
  { tenantId: 'ten_b', id: 'act_b1', label: 'User B1', email: 'b1@example.test' },
  { tenantId: 'ten_b', id: 'act_b2', label: 'User B2', email: 'b2@example.test' },
  { tenantId: 'ten_c', id: 'act_c1', label: 'User C1', email: 'c1@example.test' },
]);

function buildRegistry() {
  const reg = new TenantRegistry();
  for (const t of TENANTS) reg.createTenant({ id: t.id, name: t.name });
  for (const a of ACTORS) reg.createActor(a.tenantId, { id: a.id, label: a.label, email: a.email });
  return reg;
}

function get(reg, tenantId, actorId) {
  const t = reg.getTenant(tenantId);
  if (!t) throw new Error(`tenant ${tenantId} not in fixtures`);
  const a = t.getActor(actorId);
  if (!a) throw new Error(`actor ${actorId} not in fixtures`);
  return { tenant: t, actor: a };
}

module.exports = { TENANTS, ACTORS, buildRegistry, get };