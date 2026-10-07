'use strict';
/**
 * Shared Auth service.
 *
 * One place where "log in, hold a session, refresh, log out, assert the tenant boundary"
 * is implemented. Business modules (IPO, Couriers, Inventory, QR, ...) consume this service
 * instead of writing their own login or session handling.
 *
 * It adds no transport of its own: the adapter owns HTTP, AuthManager owns session
 * bookkeeping, and this service only binds a tenant configuration to both and exposes
 * the assertions that every module needs.
 */

const { AuthManager, AuthStateError } = require('@atf/auth-core');
const { assertAuthAdapter, supportsEffectiveAccess } = require('@atf/adapters');
const { TenantRegistry } = require('@atf/tenant-core');

class TenantBoundaryError extends Error {
  constructor(message, { code, expected, actual } = {}) {
    super(message);
    this.name = 'TenantBoundaryError';
    this.code = code || 'TENANT_BOUNDARY_VIOLATION';
    this.expected = expected || null;
    this.actual = actual || null;
  }
}

/**
 * A tenant-bound session handle.
 *
 * Every method re-checks the tenant binding, so a module cannot accidentally use a session
 * against a different tenant even if it holds the wrong handle.
 */
class TenantSession {
  constructor({ service, tenantConfig, tenant, actor, session }) {
    this.service = service;
    this.tenantConfig = tenantConfig;
    this.tenant = tenant;
    this.actor = actor;
    this.session = session;
  }

  get id() {
    return this.session.id;
  }

  get tenantId() {
    return this.tenant.id;
  }

  get alias() {
    return this.tenantConfig.alias;
  }

  /** Fail unless this handle is being used with the tenant it was created for. */
  assertTenant(tenantId) {
    if (tenantId !== undefined && tenantId !== null && String(tenantId) !== this.tenant.id) {
      throw new TenantBoundaryError(
        `session of tenant '${this.alias}' cannot be used for tenant '${tenantId}'`,
        { code: 'CROSS_TENANT_SESSION_USE', expected: this.tenant.id, actual: String(tenantId) }
      );
    }
    if (this.session.tenantId !== this.tenant.id) {
      throw new TenantBoundaryError('session tenant binding does not match its tenant', {
        code: 'SESSION_TENANT_MISMATCH', expected: this.tenant.id, actual: this.session.tenantId,
      });
    }
    return this;
  }

  /** True when the server reports this session as authenticated. */
  isAuthenticated() {
    return this.service.manager.isAuthenticated(this.session);
  }

  async refresh() {
    this.assertTenant();
    return this.service.manager.refresh(this.session);
  }

  async getEffectiveAccess() {
    this.assertTenant();
    return this.service.manager.getEffectiveAccess(this.session);
  }

  /** Fingerprints only — safe to attach to evidence. */
  safeDescriptor() {
    const adapterDescriptor = this.service.adapter.safeSession
      ? this.service.adapter.safeSession(this.session)
      : { fingerprint: null };
    return { tenantAlias: this.alias, tenantId: this.tenant.id, sessionFingerprint: adapterDescriptor.fingerprint };
  }

  async logout() {
    this.assertTenant();
    const result = await this.service.manager.logout(this.session);
    this.service.forget(this);
    return result;
  }
}

class AuthService {
  /**
   * @param {Object} opts
   * @param {Object} opts.adapter            AuthAdapter implementation (mock or real).
   * @param {Object[]} opts.tenantConfigs    Validated tenant configurations.
   */
  constructor({ adapter, tenantConfigs = [] }) {
    if (!adapter) throw new AuthStateError('AuthService requires an adapter', { code: 'NO_ADAPTER' });
    assertAuthAdapter(adapter, 'AuthService.adapter');

    this.adapter = adapter;
    this.manager = new AuthManager(adapter);
    this.registry = new TenantRegistry();
    this.tenants = new Map();
    this.sessions = new Set();

    for (const cfg of tenantConfigs) {
      // tenant-core requires tenant ids to match /^ten_/ and actor ids /^act_/.
      // When a backend issues tenant context only after login, the alias stands in until /me
      // returns a real id; both fallbacks still satisfy the framework's own ID contract.
      const tenant = this.registry.createTenant({ id: cfg.tenantId || `ten_${cfg.alias}`, name: cfg.alias });
      const actor = this.registry.createActor(tenant.id, {
        id: `act_${cfg.alias}`,
        label: cfg.alias,
        email: cfg.credentials.email || null,
      });
      this.tenants.set(cfg.alias, { cfg, tenant, actor });
    }
  }

  get aliases() {
    return [...this.tenants.keys()];
  }

  require(alias) {
    const entry = this.tenants.get(alias);
    if (!entry) {
      throw new TenantBoundaryError(`unknown tenant alias '${alias}'`, { code: 'UNKNOWN_TENANT', actual: alias });
    }
    return entry;
  }

  /**
   * Authenticate as a configured tenant.
   * @param {string} alias
   * @param {Object} [credentials] override for negative tests (e.g. wrong password)
   */
  async loginAs(alias, credentials) {
    const { cfg, tenant, actor } = this.require(alias);
    const creds = credentials || cfg.credentials;
    const result = await this.manager.login(tenant, actor, {
      email: creds.email || 'fixture@example.invalid',
      password: creds.password || 'fixture-password',
    });
    const handle = new TenantSession({
      service: this,
      tenantConfig: cfg,
      tenant,
      actor,
      session: result.session,
    });
    // The session must be bound to the tenant it was issued for.
    handle.assertTenant(tenant.id);
    this.sessions.add(handle);
    return handle;
  }

  forget(handle) {
    this.sessions.delete(handle);
  }

  /** Remove every session this service created. Safe to call repeatedly. */
  async cleanup() {
    const results = [];
    for (const handle of [...this.sessions]) {
      try {
        results.push(await handle.logout());
      } catch (_) {
        results.push({ state: 'cleanup-failed' });
      }
    }
    return results;
  }

  get supportsEffectiveAccess() {
    return supportsEffectiveAccess(this.adapter);
  }
}

module.exports = { AuthService, TenantSession, TenantBoundaryError };