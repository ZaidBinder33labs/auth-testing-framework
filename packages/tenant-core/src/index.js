'use strict';
// Tenant and actor identity management.
// No hard-coded tenant IDs: every tenant/actor is created explicitly by the test.
const crypto = require('crypto');

const TENANT_ID_RE = /^ten_[a-z0-9_]{1,64}$/i;
const ACTOR_ID_RE = /^act_[a-z0-9_]{1,64}$/i;

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

class TenantValidationError extends Error {
  constructor(message, { code, field } = {}) {
    super(message);
    this.name = 'TenantValidationError';
    this.code = code || 'TENANT_INVALID';
    this.field = field || null;
  }
}

function validateTenantId(id) {
  if (id === undefined || id === null) throw new TenantValidationError('tenant id is required', { code: 'MISSING_TENANT', field: 'id' });
  if (typeof id !== 'string') throw new TenantValidationError('tenant id must be a string', { code: 'TENANT_INVALID_TYPE', field: 'id' });
  if (!TENANT_ID_RE.test(id)) throw new TenantValidationError(`invalid tenant id: ${id}`, { code: 'TENANT_INVALID_FORMAT', field: 'id' });
  return id;
}

function validateActorId(id) {
  if (id === undefined || id === null) throw new TenantValidationError('actor id is required', { code: 'MISSING_ACTOR', field: 'id' });
  if (typeof id !== 'string') throw new TenantValidationError('actor id must be a string', { code: 'ACTOR_INVALID_TYPE', field: 'id' });
  if (!ACTOR_ID_RE.test(id)) throw new TenantValidationError(`invalid actor id: ${id}`, { code: 'ACTOR_INVALID_FORMAT', field: 'id' });
  return id;
}

class Tenant {
  constructor({ id, name } = {}) {
    this.id = validateTenantId(id);
    this.name = name || this.id;
    this.actors = new Map();
    this.createdAt = Date.now();
  }

  addActor({ id, label, email } = {}) {
    const actorId = validateActorId(id);
    if (this.actors.has(actorId)) throw new TenantValidationError(`duplicate actor ${actorId} in tenant ${this.id}`, { code: 'DUPLICATE_ACTOR', field: 'id' });
    const actor = new Actor({ id: actorId, tenantId: this.id, label: label || actorId, email });
    this.actors.set(actorId, actor);
    return actor;
  }

  getActor(actorId) {
    validateActorId(actorId);
    return this.actors.get(actorId) || null;
  }

  hasActor(actorId) {
    try { return this.actors.has(validateActorId(actorId)); } catch (_) { return false; }
  }
}

class Actor {
  constructor({ id, tenantId, label, email } = {}) {
    this.id = validateActorId(id);
    this.tenantId = validateTenantId(tenantId);
    this.label = label || this.id;
    this.email = email || null;
    this.createdAt = Date.now();
  }

  belongsTo(tenant) {
    if (!tenant) return false;
    return tenant.id === this.tenantId;
  }
}

class TenantRegistry {
  constructor() {
    this.tenants = new Map();
  }

  createTenant({ id, name } = {}) {
    const tenantId = id || generateId('ten');
    if (this.tenants.has(tenantId)) throw new TenantValidationError(`duplicate tenant ${tenantId}`, { code: 'DUPLICATE_TENANT', field: 'id' });
    const tenant = new Tenant({ id: tenantId, name });
    this.tenants.set(tenantId, tenant);
    return tenant;
  }

  getTenant(tenantId) {
    try { validateTenantId(tenantId); } catch (e) { return null; }
    return this.tenants.get(tenantId) || null;
  }

  requireTenant(tenantId) {
    const t = this.getTenant(tenantId);
    if (!t) throw new TenantValidationError(`tenant not found: ${tenantId}`, { code: 'MISSING_TENANT', field: 'id' });
    return t;
  }

  createActor(tenantId, { id, label, email } = {}) {
    const tenant = this.requireTenant(tenantId);
    const actorId = id || generateId('act');
    return tenant.addActor({ id: actorId, label, email });
  }

  // Switch the "current" tenant context for a sequence of operations.
  switchTenant(tenantId) {
    return this.requireTenant(tenantId);
  }

  removeTenant(tenantId) {
    const t = this.getTenant(tenantId);
    if (t) this.tenants.delete(tenantId);
    return !!t;
  }

  listTenants() {
    return [...this.tenants.values()].map((t) => ({ id: t.id, name: t.name }));
  }
}

module.exports = {
  Tenant,
  Actor,
  TenantRegistry,
  TenantValidationError,
  validateTenantId,
  validateActorId,
  generateId,
  TENANT_ID_RE,
  ACTOR_ID_RE,
};