'use strict';
/**
 * Environment descriptors and safety policies.
 *
 * An environment says where a target RUNS: the base URL, the Redis connection, which credential
 * environment variables to read, and which policy applies. It is deliberately not the same thing
 * as the target, which says what the application IS, and not the same thing as the policy, which
 * says what the suite may do there.
 *
 * Credentials NEVER appear here. A descriptor names the variables to read and the loader reads
 * them from process.env at the moment of use; nothing is stored, echoed or returned.
 *
 * Production guardrails hold here regardless of policy, and each one raises a coded error rather
 * than a warning, because a warning is a thing a CI log scrolls past.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const ENVIRONMENTS_DIR = path.join(CONFIG_DIR, 'environments');
const POLICIES_DIR = path.join(CONFIG_DIR, 'policies');

/** Every capability the framework knows about. A policy must answer for all of them. */
const CAPABILITIES = Object.freeze([
  'mutatesOwnSession',
  'mutatesRedis',
  'concurrentLoad',
  'tokenRotation',
  'ttlWaits',
]);

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ENV_VAR_RE = /^[A-Z][A-Z0-9_]*$/;
const REDIS_MODES = ['MOCK_REDIS', 'READ_ONLY', 'DEDICATED_TEST_REDIS', 'TEST_NAMESPACE'];

class EnvConfigError extends Error {
  constructor(message, { code, field, environment } = {}) {
    super(message);
    this.name = 'EnvConfigError';
    this.code = code || 'ENV_CONFIG_ERROR';
    this.field = field || null;
    this.environment = environment || null;
  }
}

function requireString(value, field, environment, { pattern, maxLength = 512 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new EnvConfigError(`environment field '${field}' is required`, { code: 'MISSING_FIELD', field, environment });
  }
  const s = String(value).trim();
  if (s.length > maxLength) {
    throw new EnvConfigError(`environment field '${field}' exceeds ${maxLength} characters`, { code: 'FIELD_TOO_LONG', field, environment });
  }
  if (pattern && !pattern.test(s)) {
    // Never echoed: an environment descriptor's values are where a private host would live.
    throw new EnvConfigError(`environment field '${field}' has an invalid format`, { code: 'INVALID_FORMAT', field, environment });
  }
  return s;
}

function requireEnvVarName(value, field, environment) {
  const s = requireString(value, field, environment, { pattern: ENV_VAR_RE, maxLength: 128 });
  return s;
}

/** A base URL is required to be an http(s) URL with a host. */
function requireBaseUrl(value, field, environment) {
  const s = requireString(value, field, environment, { maxLength: 2048 });
  let parsed;
  try {
    parsed = new URL(s);
  } catch (_) {
    throw new EnvConfigError(`environment field '${field}' is not a valid URL`, { code: 'INVALID_URL', field, environment });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EnvConfigError(`environment field '${field}' must use http or https`, { code: 'INVALID_URL', field, environment });
  }
  if (!parsed.hostname) {
    throw new EnvConfigError(`environment field '${field}' has no host`, { code: 'INVALID_URL', field, environment });
  }
  // A path on a base URL is legitimate (an app served under a prefix) but a query or fragment is
  // not: it would silently change which requests the transport makes.
  if (parsed.search || parsed.hash) {
    throw new EnvConfigError(`environment field '${field}' must not carry a query or fragment`, { code: 'INVALID_URL', field, environment });
  }
  return parsed.toString().replace(/\/+$/, '');
}

function readJson(file, kind) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    throw new EnvConfigError(`${kind} descriptor could not be read`, { code: 'DESCRIPTOR_NOT_READABLE' });
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (_) {
    throw new EnvConfigError(`${kind} descriptor is not valid JSON`, { code: 'INVALID_JSON' });
  }
}

// =============================================================================================
// Policies
// =============================================================================================

/**
 * Validate a raw policy. Every capability must be answered explicitly: a policy that omits one
 * is refused rather than defaulted, because silence must never read as permission.
 */
function validatePolicy(raw, name = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EnvConfigError('policy descriptor must be an object', { code: 'INVALID_ENTRY' });
  }
  const policyName = requireString(raw.name, 'name', null, { pattern: NAME_RE, maxLength: 64 });
  const caps = raw.capabilities;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    throw new EnvConfigError("policy field 'capabilities' is required", { code: 'MISSING_FIELD', field: 'capabilities' });
  }

  const out = {};
  for (const cap of CAPABILITIES) {
    if (typeof caps[cap] !== 'boolean') {
      throw new EnvConfigError(
        `policy '${policyName}' must state '${cap}' as true or false; an omitted capability is not permission`,
        { code: 'CAPABILITY_UNSTATED', field: `capabilities.${cap}`, environment: policyName }
      );
    }
    out[cap] = caps[cap];
  }
  for (const key of Object.keys(caps)) {
    if (!CAPABILITIES.includes(key)) {
      throw new EnvConfigError(`policy '${policyName}' declares an unknown capability`, {
        code: 'UNKNOWN_CAPABILITY', field: `capabilities.${key}`, environment: policyName,
      });
    }
  }

  return Object.freeze({
    name: policyName,
    displayName: raw.displayName || policyName,
    description: raw.description || null,
    capabilities: Object.freeze(out),
  });
}

function listPolicies() {
  try {
    return fs.readdirSync(POLICIES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  } catch (_) {
    return [];
  }
}

function loadPolicy(name) {
  const safe = requireString(name, 'policy', null, { pattern: NAME_RE, maxLength: 64 });
  const file = path.join(POLICIES_DIR, `${safe}.json`);
  if (!fs.existsSync(file)) {
    throw new EnvConfigError(`unknown policy '${safe}'; available policies: ${listPolicies().join(', ')}`, {
      code: 'POLICY_NOT_FOUND', field: 'policy',
    });
  }
  return validatePolicy(readJson(file, 'policy'), safe);
}

// =============================================================================================
// Environments
// =============================================================================================

function validateEnvironment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EnvConfigError('environment descriptor must be an object', { code: 'INVALID_ENTRY' });
  }
  const name = requireString(raw.name, 'name', null, { pattern: NAME_RE, maxLength: 64 });

  if (typeof raw.production !== 'boolean') {
    throw new EnvConfigError(`environment '${name}' must state 'production' as true or false`, {
      code: 'MISSING_FIELD', field: 'production', environment: name,
    });
  }

  const redis = raw.redis;
  if (!redis || typeof redis !== 'object' || Array.isArray(redis)) {
    throw new EnvConfigError(`environment '${name}' field 'redis' is required`, { code: 'MISSING_FIELD', field: 'redis', environment: name });
  }
  const mode = requireString(redis.mode, 'redis.mode', name, { maxLength: 32 });
  if (!REDIS_MODES.includes(mode)) {
    throw new EnvConfigError(`environment '${name}' redis.mode must be one of: ${REDIS_MODES.join(', ')}`, {
      code: 'INVALID_VALUE', field: 'redis.mode', environment: name,
    });
  }

  const creds = raw.credentials;
  if (!creds || typeof creds !== 'object' || Array.isArray(creds)) {
    throw new EnvConfigError(`environment '${name}' field 'credentials' is required`, { code: 'MISSING_FIELD', field: 'credentials', environment: name });
  }

  // A descriptor names the variables holding credentials. It must never hold the values.
  for (const forbidden of ['email', 'password', 'secret', 'token', 'username']) {
    if (creds[forbidden] !== undefined) {
      throw new EnvConfigError(
        `environment '${name}' must not carry a credential value; name the environment variable instead`,
        { code: 'CREDENTIAL_NOT_ALLOWED', field: `credentials.${forbidden}`, environment: name }
      );
    }
  }

  const production = raw.production;
  // Guardrail: production is read-only, always, and the descriptor may not weaken it.
  if (production && mode !== 'READ_ONLY') {
    throw new EnvConfigError(
      `environment '${name}' is production, so redis.mode must be READ_ONLY; it is set to a mode that permits writes`,
      { code: 'PRODUCTION_MUST_BE_READ_ONLY', field: 'redis.mode', environment: name }
    );
  }

  return Object.freeze({
    name,
    displayName: raw.displayName || name,
    target: requireString(raw.target, 'target', name, { pattern: NAME_RE, maxLength: 64 }),
    baseUrl: requireBaseUrl(raw.baseUrl, 'baseUrl', name),
    policy: requireString(raw.policy, 'policy', name, { pattern: NAME_RE, maxLength: 64 }),
    production,
    redis: Object.freeze({
      mode,
      namespace: redis.namespace === undefined || redis.namespace === null || redis.namespace === ''
        ? null
        : requireString(redis.namespace, 'redis.namespace', name, { pattern: /^[a-z0-9][a-z0-9:_-]{0,63}$/i, maxLength: 64 }),
      urlEnvVar: requireEnvVarName(redis.urlEnvVar, 'redis.urlEnvVar', name),
      tls: typeof redis.tls === 'boolean' ? redis.tls : false,
      db: redis.db === undefined || redis.db === null || redis.db === '' ? null : redis.db,
    }),
    credentials: Object.freeze({
      emailEnvVar: requireEnvVarName(creds.emailEnvVar, 'credentials.emailEnvVar', name),
      passwordEnvVar: requireEnvVarName(creds.passwordEnvVar, 'credentials.passwordEnvVar', name),
      accountIdentityEnvVar: creds.accountIdentityEnvVar
        ? requireEnvVarName(creds.accountIdentityEnvVar, 'credentials.accountIdentityEnvVar', name)
        : null,
      requireDedicatedTestAccount: creds.requireDedicatedTestAccount === true,
      expectAccountIdentitySuffix: typeof creds.expectAccountIdentitySuffix === 'string'
        ? creds.expectAccountIdentitySuffix
        : null,
    }),
    verification: Object.freeze({
      httpExpected: raw.verification ? raw.verification.httpExpected === true : false,
      redisExpected: raw.verification ? raw.verification.redisExpected === true : false,
    }),
    notes: Object.freeze(Array.isArray(raw.notes) ? raw.notes.map(String) : []),
  });
}

function listEnvironments() {
  try {
    return fs.readdirSync(ENVIRONMENTS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  } catch (_) {
    return [];
  }
}

function loadEnvironment(name) {
  const safe = requireString(name, 'environment', null, { pattern: NAME_RE, maxLength: 64 });
  const file = path.join(ENVIRONMENTS_DIR, `${safe}.json`);
  if (!fs.existsSync(file)) {
    // The available names are listed so the operator is not left guessing. Nothing else about
    // the environments is disclosed.
    throw new EnvConfigError(`unknown environment '${safe}'; available environments: ${listEnvironments().join(', ')}`, {
      code: 'ENVIRONMENT_NOT_FOUND', field: 'environment',
    });
  }
  return validateEnvironment(readJson(file, 'environment'));
}

// =============================================================================================
// Guardrails
// =============================================================================================

/**
 * Apply the production Redis guardrail.
 *
 * A production environment forces READ_ONLY and an attempt to override it through the REDIS_MODE
 * environment variable is an error, not a warning: a run that thinks it may write to production
 * Redis because a variable said so is exactly the failure this exists to prevent.
 */
function resolveRedisMode(environment, env = process.env) {
  const forced = environment.production ? 'READ_ONLY' : environment.redis.mode;
  const override = env.REDIS_MODE;

  if (environment.production && override && String(override).toUpperCase() !== 'READ_ONLY') {
    throw new EnvConfigError(
      `environment '${environment.name}' is production, so REDIS_MODE is forced to READ_ONLY and cannot be overridden`,
      { code: 'PRODUCTION_REDIS_MODE_OVERRIDE_REFUSED', field: 'REDIS_MODE', environment: environment.name }
    );
  }
  return forced;
}

/**
 * Apply the production run-time opt-in.
 *
 * The confirmation must name the environment exactly. A bare truthy value is refused: it could be
 * set once in a shell profile and then satisfy every future production run by accident.
 */
function assertProductionConsent(environment, env = process.env) {
  if (!environment.production) return true;
  const given = env.CONFIRM_PRODUCTION_RUN;
  if (!given || String(given).trim() !== environment.name) {
    throw new EnvConfigError(
      `environment '${environment.name}' is production; set CONFIRM_PRODUCTION_RUN=${environment.name} to run against it`,
      { code: 'PRODUCTION_CONSENT_MISSING', field: 'CONFIRM_PRODUCTION_RUN', environment: environment.name }
    );
  }
  return true;
}

/**
 * The account identity, which a report may state, and the credentials, which it may not.
 * Returns identity only; the password is never returned, not even to its own caller.
 */
function readAccount(environment, env = process.env) {
  const identityVar = environment.credentials.accountIdentityEnvVar;
  const identity = identityVar && env[identityVar] ? String(env[identityVar]).trim() : null;

  const missing = [];
  if (!env[environment.credentials.emailEnvVar]) missing.push(environment.credentials.emailEnvVar);
  if (!env[environment.credentials.passwordEnvVar]) missing.push(environment.credentials.passwordEnvVar);

  let accountWarning = null;
  const suffix = environment.credentials.expectAccountIdentitySuffix;
  if (environment.credentials.requireDedicatedTestAccount) {
    if (!identity) {
      accountWarning = 'the account identity is not configured, so a dedicated test account could not be confirmed';
    } else if (suffix && !identity.endsWith(suffix)) {
      // The identity is not a secret, so naming it is allowed; naming the credential is not.
      accountWarning = `the configured account identity does not end with the expected dedicated-test suffix ${suffix}`;
    }
  }

  return {
    identity,
    hasCredentials: missing.length === 0,
    missingCredentialVars: missing,
    accountWarning,
  };
}

/** Everything a report needs about where this run happened, with no credential and no URL. */
function describeEnvironment(environment, policy) {
  return {
    environment: environment.name,
    displayName: environment.displayName,
    target: environment.target,
    policy: policy ? policy.name : environment.policy,
    production: environment.production,
    redisMode: environment.redis.mode,
    redisNamespace: environment.redis.namespace,
    capabilities: policy ? { ...policy.capabilities } : null,
  };
}

module.exports = {
  EnvConfigError,
  CAPABILITIES,
  REDIS_MODES,
  validatePolicy,
  loadPolicy,
  listPolicies,
  validateEnvironment,
  loadEnvironment,
  listEnvironments,
  resolveRedisMode,
  assertProductionConsent,
  readAccount,
  describeEnvironment,
  ENVIRONMENTS_DIR,
  POLICIES_DIR,
};