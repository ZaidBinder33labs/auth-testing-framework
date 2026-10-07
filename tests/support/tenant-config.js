'use strict';
/**
 * Dynamic multi-tenant configuration.
 *
 * The auth implementation must work for any number of configured tenants with no
 * tenant-specific code and no hardcoded tenant IDs. Tenants are described by data:
 *
 *   BINDER_TENANTS=[{"alias":"a","tenantId":"...","baseUrl":"https://...",
 *                    "email":"...","password":"...","redisNamespace":"...",
 *                    "expect":{"userType":"TENANT_ADMIN","isTenantAdmin":true}}]
 *
 * or, without JSON, one variable per alias:
 *   BINDER_TENANT_A_ALIAS / _TENANTID / _BASEURL / _EMAIL / _PASSWORD / _REDIS_NAMESPACE
 *
 * Credentials are read from the environment only, are never returned by describeTenant()
 * or any error message, and never reach a report.
 *
 * Verification levels are explicit and carried with every tenant so a report can never
 * present fixture coverage as backend proof:
 *   'fixture'  - deterministic local fixtures, no backend involved
 *   'redis'    - a real Redis instance is involved
 *   'http'     - a real non-production HTTP endpoint is involved
 */

const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const NAMESPACE_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/i;
// tenant-core enforces /^ten_[a-z0-9_]{1,64}$/i for tenant identifiers, so a misconfigured
// tenant is rejected here rather than at AuthService construction time.
const TENANT_ID_RE = /^ten_[a-z0-9_]{1,64}$/i;

class TenantConfigError extends Error {
  constructor(message, { code, field, alias } = {}) {
    super(message);
    this.name = 'TenantConfigError';
    this.code = code || 'TENANT_CONFIG_ERROR';
    this.field = field || null;
    this.alias = alias || null;
  }
}

function requireString(value, field, alias, { pattern, maxLength = 512 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new TenantConfigError(`tenant config field '${field}' is required`, { code: 'MISSING_FIELD', field, alias });
  }
  const s = String(value).trim();
  if (s.length > maxLength) {
    throw new TenantConfigError(`tenant config field '${field}' exceeds ${maxLength} characters`, {
      code: 'FIELD_TOO_LONG', field, alias,
    });
  }
  if (pattern && !pattern.test(s)) {
    // The offending value is deliberately not echoed.
    throw new TenantConfigError(`tenant config field '${field}' has an invalid format`, {
      code: 'INVALID_FORMAT', field, alias,
    });
  }
  return s;
}

/** Validate one raw tenant record into a normalised tenant configuration. */
function validateTenant(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TenantConfigError(`tenant entry #${index} must be an object`, { code: 'INVALID_ENTRY' });
  }

  const alias = requireString(raw.alias, 'alias', null, { pattern: ALIAS_RE, maxLength: 32 });

  // Tenant id is optional: a backend may issue tenant context only after login, in which
  // case the tenant is identified by alias until /me returns one.
  let tenantId = null;
  if (raw.tenantId !== undefined && raw.tenantId !== null && String(raw.tenantId).trim() !== '') {
    tenantId = requireString(raw.tenantId, 'tenantId', alias, { pattern: TENANT_ID_RE, maxLength: 128 });
  }

  let baseUrl = null;
  if (raw.baseUrl !== undefined && raw.baseUrl !== null && String(raw.baseUrl).trim() !== '') {
    baseUrl = requireString(raw.baseUrl, 'baseUrl', alias, { maxLength: 2048 });
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch (_) {
      throw new TenantConfigError('tenant config field \'baseUrl\' is not a valid URL', {
        code: 'INVALID_URL', field: 'baseUrl', alias,
      });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new TenantConfigError('tenant config field \'baseUrl\' must use http or https', {
        code: 'INVALID_URL', field: 'baseUrl', alias,
      });
    }
    baseUrl = parsed.toString().replace(/\/+$/, '');
  }

  const credentials = {
    email: raw.email === undefined || raw.email === null ? '' : String(raw.email).trim(),
    // Passwords are only validated for presence; never stored on the object in clear text
    // beyond what a login call needs, and never rendered.
    password: raw.password === undefined || raw.password === null ? '' : String(raw.password),
  };
  if (credentials.email && !credentials.email.includes('@')) {
    throw new TenantConfigError('tenant config field \'email\' is not a valid address', {
      code: 'INVALID_FORMAT', field: 'email', alias,
    });
  }
  const hasCredentials = !!(credentials.email && credentials.password);

  let redisNamespace = null;
  if (raw.redisNamespace !== undefined && raw.redisNamespace !== null && String(raw.redisNamespace).trim() !== '') {
    redisNamespace = requireString(raw.redisNamespace, 'redisNamespace', alias, { pattern: NAMESPACE_RE, maxLength: 64 });
  }

  const expect = raw.expect && typeof raw.expect === 'object' && !Array.isArray(raw.expect) ? raw.expect : {};

  return Object.freeze({
    alias,
    tenantId,
    baseUrl,
    credentials: Object.freeze({ ...credentials }),
    hasCredentials,
    redisNamespace,
    expect: Object.freeze({
      userType: expect.userType || null,
      isTenantAdmin: typeof expect.isTenantAdmin === 'boolean' ? expect.isTenantAdmin : null,
      buyerScopeMode: expect.buyerScopeMode || null,
    }),
    session: Object.freeze({
      // Rotation expectation drives negative tests; default matches the verified contract,
      // where the refresh token is HttpOnly and rotation is server-driven.
      rotationEnabled: typeof raw.rotationEnabled === 'boolean' ? raw.rotationEnabled : true,
      expectEffectiveAccess: raw.expectEffectiveAccess === undefined ? true : !!raw.expectEffectiveAccess,
    }),
  });
}

function parseJsonTenants(env) {
  const raw = env.BINDER_TENANTS;
  if (!raw || !String(raw).trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new TenantConfigError('BINDER_TENANTS is not valid JSON', { code: 'INVALID_JSON', field: 'BINDER_TENANTS' });
  }
  if (!Array.isArray(parsed)) {
    throw new TenantConfigError('BINDER_TENANTS must be a JSON array of tenant objects', {
      code: 'INVALID_JSON', field: 'BINDER_TENANTS',
    });
  }
  return parsed;
}

function parsePrefixedTenants(env) {
  const out = [];
  const seen = new Set();
  for (const [key, value] of Object.entries(env)) {
    const m = /^BINDER_TENANT_([A-Z0-9]+)_ALIAS$/.exec(key);
    if (!m || seen.has(m[1])) continue;
    const scope = `BINDER_TENANT_${m[1]}_`;
    const alias = String(value).trim();
    seen.add(m[1]);
    out.push({
      alias,
      tenantId: env[`${scope}TENANTID`],
      baseUrl: env[`${scope}BASEURL`],
      email: env[`${scope}EMAIL`],
      password: env[`${scope}PASSWORD`],
      redisNamespace: env[`${scope}REDIS_NAMESPACE`],
      rotationEnabled: env[`${scope}ROTATION_ENABLED`],
    });
  }
  return out;
}

/**
 * Load and validate every configured tenant.
 * @returns {Object[]} frozen tenant configurations
 * @throws  {TenantConfigError} on the first invalid entry, including duplicate aliases
 */
function loadTenantConfigs(env = process.env) {
  const raw = parseJsonTenants(env) || parsePrefixedTenants(env) || [];
  if (!Array.isArray(raw)) {
    throw new TenantConfigError('tenant configuration must be an array', { code: 'INVALID_ENTRY' });
  }
  const tenants = raw.map((t, i) => validateTenant(t, i));
  const aliases = new Set();
  for (const t of tenants) {
    if (aliases.has(t.alias)) {
      throw new TenantConfigError(`duplicate tenant alias '${t.alias}'`, { code: 'DUPLICATE_ALIAS', alias: t.alias });
    }
    aliases.add(t.alias);
  }
  return tenants;
}

/** Tenants that can actually authenticate: they need a base URL and credentials. */
function httpCapableTenants(tenants) {
  return tenants.filter((t) => t.baseUrl && t.hasCredentials);
}

/** Report prerequisites for real HTTP verification without asserting them. */
function httpReadiness(tenants) {
  const missing = [];
  if (tenants.length === 0) missing.push({ prerequisite: 'At least one tenant configured (BINDER_TENANTS)' });
  for (const t of tenants) {
    if (!t.baseUrl) missing.push({ tenant: t.alias, prerequisite: 'baseUrl' });
    if (!t.credentials.email) missing.push({ tenant: t.alias, prerequisite: 'email' });
    if (!t.credentials.password) missing.push({ tenant: t.alias, prerequisite: 'password' });
  }
  return { ready: missing.length === 0, missing };
}

/**
 * Safe description for reports and logs.
 * Credentials are reduced to a presence flag; no secret material is included.
 */
function describeTenant(tenant) {
  return {
    alias: tenant.alias,
    tenantId: tenant.tenantId,
    baseUrl: tenant.baseUrl,
    hasCredentials: tenant.hasCredentials,
    redisNamespace: tenant.redisNamespace,
    expect: tenant.expect,
    session: tenant.session,
  };
}

/**
 * Deterministic local tenants for fixture-level tests.
 * These carry no credentials and never contact a backend; they exist so the shared auth
 * implementation can be exercised with several tenants on any machine.
 */
function fixtureTenants(count = 2) {
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    const suffix = String.fromCharCode(96 + i);
    out.push(
      validateTenant({
        alias: `fx${suffix}`,
        tenantId: `ten_fixture_${i}`,
        baseUrl: 'https://fixture.invalid',
        redisNamespace: `qa:fx${suffix}`,
        expect: { userType: i === 1 ? 'TENANT_ADMIN' : 'TENANT_MEMBER', isTenantAdmin: i === 1, buyerScopeMode: 'SELECTED' },
      })
    );
  }
  return out;
}

module.exports = {
  TenantConfigError,
  loadTenantConfigs,
  httpCapableTenants,
  httpReadiness,
  describeTenant,
  fixtureTenants,
  validateTenant,
};