'use strict';
// Mock TenantAdapter: deterministic tenant/actor registry backed by tenant-core.
const { TenantRegistry } = require('@atf/tenant-core');

class MockTenantAdapter {
  constructor(opts = {}) {
    this.registry = new TenantRegistry();
    this.tenants = opts.tenants || [];
    this.actors = opts.actors || [];
    for (const t of this.tenants) this.registry.createTenant({ id: t.id, name: t.name });
    for (const a of this.actors) this.registry.createActor(a.tenantId, { id: a.id, label: a.label, email: a.email });
  }

  async getTenant(tenantId) {
    return this.registry.getTenant(tenantId);
  }

  async requireTenant(tenantId) {
    return this.registry.requireTenant(tenantId);
  }

  async getActor(tenantId, actorId) {
    const t = this.registry.getTenant(tenantId);
    if (!t) return null;
    return t.getActor(actorId);
  }

  async listTenants() {
    return this.registry.listTenants();
  }

  async createTenant({ id, name }) {
    return this.registry.createTenant({ id, name });
  }

  async createActor(tenantId, { id, label, email }) {
    return this.registry.createActor(tenantId, { id, label, email });
  }
}

function createMockTenantAdapter(opts = {}) {
  return new MockTenantAdapter(opts);
}

module.exports = { MockTenantAdapter, createMockTenantAdapter };