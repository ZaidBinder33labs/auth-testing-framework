'use strict';
/**
 * Target descriptors.
 *
 * A target descriptor is data describing what an application IS: its endpoint paths, the field
 * names it uses for tokens and expiry, whether the refresh token rides in a cookie or a body,
 * whether rotation is on, what a successful logout looks like, and the Redis key prefixes the
 * application itself writes.
 *
 * What is deliberately NOT here: where the application runs. Base URL, Redis connection, TLS,
 * mode and namespace belong to the environment descriptor, because they differ between a
 * developer's laptop and production while the application contract does not.
 *
 * Credentials NEVER appear in a descriptor. An environment descriptor names the variables to
 * read; this file neither reads nor stores any.
 *
 * Validation follows the same shape as tests/support/tenant-config.js: a coded error class,
 * offending values never echoed, and frozen output.
 */

const fs = require('fs');
const path = require('path');

// Descriptors live with the framework, not with the package, because a target is a property of
// the deployment being tested rather than of the loader that reads it.
const DEFAULT_TARGETS_DIR = path.resolve(__dirname, '..', '..', '..', 'config', 'targets');

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// A path is a fragment, never a full URL: the base URL is the environment's to supply, and a
// descriptor that carried one could point a test at the wrong host. A leading "//" is refused
// because it is how a protocol-relative URL is spelled.
const PATH_RE = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,254}$/;
// Redis key prefixes are free-form text. "/" and ":" are both ordinary in them ("session/",
// "qa:fx1sess:"), so the pattern is deliberately permissive about characters and strict about
// length and about characters that would corrupt a key or a terminal.
const PREFIX_RE = /^[A-Za-z0-9._~:@/-]{1,64}$/;

class TargetConfigError extends Error {
  constructor(message, { code, field, target } = {}) {
    super(message);
    this.name = 'TargetConfigError';
    this.code = code || 'TARGET_CONFIG_ERROR';
    this.field = field || null;
    this.target = target || null;
  }
}

function requireString(value, field, target, { pattern, maxLength = 512 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new TargetConfigError(`target field '${field}' is required`, { code: 'MISSING_FIELD', field, target });
  }
  const s = String(value).trim();
  if (s.length > maxLength) {
    throw new TargetConfigError(`target field '${field}' exceeds ${maxLength} characters`, {
      code: 'FIELD_TOO_LONG', field, target,
    });
  }
  if (pattern && !pattern.test(s)) {
    // The offending value is deliberately not echoed.
    throw new TargetConfigError(`target field '${field}' has an invalid format`, { code: 'INVALID_FORMAT', field, target });
  }
  return s;
}

function optionalString(value, field, target, opts = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return requireString(value, field, target, opts);
}

function requireBoolean(value, field, target) {
  if (typeof value !== 'boolean') {
    throw new TargetConfigError(`target field '${field}' must be a boolean`, { code: 'INVALID_TYPE', field, target });
  }
  return value;
}

function requireInt(value, field, target, { min = 100, max = 599 } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    // Neither the number nor any other supplied value is echoed: a wrong status could be
    // someone's guess at a private endpoint, and an error message ends up in a report.
    throw new TargetConfigError(`target field '${field}' must be an HTTP status code between ${min} and ${max}`, {
      code: 'INVALID_TYPE', field, target,
    });
  }
  return n;
}

function requireEnum(value, field, target, allowed) {
  const s = String(value).trim();
  if (!allowed.includes(s)) {
    throw new TargetConfigError(`target field '${field}' must be one of: ${allowed.join(', ')}`, {
      code: 'INVALID_VALUE', field, target,
    });
  }
  return s;
}

/** A flat { frameworkField: targetField } map. Rejected if a target field name is not an identifier. */
function requireFieldMap(value, field, target, { required = [], pattern = FIELD_RE } = {}) {
  if (value === undefined || value === null) {
    if (required.length === 0) return Object.freeze({});
    throw new TargetConfigError(`target field '${field}' is required`, { code: 'MISSING_FIELD', field, target });
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TargetConfigError(`target field '${field}' must be an object mapping framework fields to target field names`, {
      code: 'INVALID_TYPE', field, target,
    });
  }
  const out = {};
  for (const [key, mapped] of Object.entries(value)) {
    out[key] = requireString(mapped, `${field}.${key}`, target, { pattern, maxLength: 64 });
  }
  for (const key of required) {
    if (!out[key]) {
      throw new TargetConfigError(`target field '${field}' is missing the '${key}' entry`, {
        code: 'MISSING_FIELD', field: `${field}.${key}`, target,
      });
    }
  }
  return Object.freeze(out);
}

/** The auth block: paths, credential mapping, token lifecycle and the field names used in bodies. */
function validateAuth(raw, target) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TargetConfigError("target section 'auth' must be an object", { code: 'MISSING_SECTION', field: 'auth', target });
  }

  const fields = raw.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TargetConfigError("target field 'auth.fields' is required", { code: 'MISSING_FIELD', field: 'auth.fields', target });
  }

  // Validation is idempotent: a descriptor that has already been through here carries the
  // normalised spellings, and re-validating one must not fail. Callers hold normalised
  // descriptors and pass them straight back in, so this is the normal path, not an edge case.
  const accessTokenField = requireString(
    fields.accessToken ?? fields.accessTokenField, 'auth.fields.accessToken', target, { pattern: FIELD_RE, maxLength: 64 }
  );
  const refreshTokenField = requireString(
    fields.refreshToken ?? fields.refreshTokenField, 'auth.fields.refreshToken', target, { pattern: FIELD_RE, maxLength: 64 }
  );
  const expiresField = requireString(
    fields.expires ?? fields.expiresField, 'auth.fields.expires', target, { pattern: FIELD_RE, maxLength: 64 }
  );
  const expiresFormat = requireEnum(
    fields.expiresFormat === undefined ? 'datetime' : fields.expiresFormat, 'auth.fields.expiresFormat', target, ['datetime', 'seconds']
  );

  return Object.freeze({
    loginPath: requireString(raw.loginPath, 'auth.loginPath', target, { pattern: PATH_RE, maxLength: 256 }),
    refreshPath: requireString(raw.refreshPath, 'auth.refreshPath', target, { pattern: PATH_RE, maxLength: 256 }),
    logoutPath: requireString(raw.logoutPath, 'auth.logoutPath', target, { pattern: PATH_RE, maxLength: 256 }),
    mePath: requireString(raw.mePath, 'auth.mePath', target, { pattern: PATH_RE, maxLength: 256 }),
    accessPath: requireString(raw.accessPath, 'auth.accessPath', target, { pattern: PATH_RE, maxLength: 256 }),

    // Which of the framework's two credential names the application calls what.
    loginFields: requireFieldMap(raw.loginFields, 'auth.loginFields', target, { required: ['email', 'password'] }),

    // When true the refresh token arrives in an HttpOnly cookie set at login and the transport
    // replays it; when false it travels in the JSON body and must be sent back on refresh.
    cookieAuth: requireBoolean(raw.cookieAuth, 'auth.cookieAuth', target),
    rotationEnabled: requireBoolean(raw.rotationEnabled, 'auth.rotationEnabled', target),
    // Descriptive: a true value means one logout invalidates every session for the account,
    // not only the caller's. It changes what a report should claim, not what is requested.
    globalLogout: requireBoolean(raw.globalLogout, 'auth.globalLogout', target),
    logoutSuccessStatus: requireInt(raw.logoutSuccessStatus === undefined ? 204 : raw.logoutSuccessStatus, 'auth.logoutSuccessStatus', target),

    fields: Object.freeze({ accessTokenField, refreshTokenField, expiresField, expiresFormat }),
    tokenTypeField: optionalString(fields.tokenType ?? raw.tokenTypeField, 'auth.fields.tokenType', target, { pattern: FIELD_RE, maxLength: 64 }),
    claims: requireFieldMap(raw.claims, 'auth.claims', target, { required: ['tenant', 'user'] }),
    userFields: requireFieldMap(raw.userFields, 'auth.userFields', target, {}),
    accessFields: requireFieldMap(raw.accessFields, 'auth.accessFields', target, {
      required: ['screenCode', 'moduleCode', 'scope', 'level', 'canApprove', 'canDelete'],
    }),
  });
}

/** The Redis key prefixes the application itself writes. Identical in every environment. */
function validateRedis(raw, target) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TargetConfigError("target section 'redis' must be an object", { code: 'MISSING_SECTION', field: 'redis', target });
  }
  return Object.freeze({
    sessionPrefix: requireString(raw.sessionPrefix, 'redis.sessionPrefix', target, { pattern: PREFIX_RE, maxLength: 64 }),
    tokenPrefix: requireString(raw.tokenPrefix, 'redis.tokenPrefix', target, { pattern: PREFIX_RE, maxLength: 64 }),
    tenantPrefix: requireString(raw.tenantPrefix, 'redis.tenantPrefix', target, { pattern: PREFIX_RE, maxLength: 64 }),
  });
}

/** Validate one raw descriptor into a frozen, normalised target configuration. */
function validateTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TargetConfigError('target descriptor must be an object', { code: 'INVALID_ENTRY' });
  }

  const name = requireString(raw.name, 'name', null, { pattern: NAME_RE, maxLength: 64 });
  if (raw.baseUrl !== undefined || raw.apiUrl !== undefined) {
    // A base URL in a target descriptor is a wiring mistake: the same application is reached at
    // different hosts per environment, and a descriptor that pins one would silently retarget
    // every test that loaded it.
    throw new TargetConfigError("target descriptor must not carry 'baseUrl' or 'apiUrl'; the environment supplies the base URL", {
      code: 'BASE_URL_NOT_ALLOWED', field: 'baseUrl', target: name,
    });
  }

  return Object.freeze({
    name,
    displayName: optionalString(raw.displayName, 'displayName', name, { maxLength: 128 }) || name,
    description: optionalString(raw.description, 'description', name, { maxLength: 512 }),
    version: optionalString(raw.version, 'version', name, { maxLength: 32 }),
    auth: validateAuth(raw.auth, name),
    redis: validateRedis(raw.redis, name),
  });
}

/** Read and validate one descriptor from disk. */
function loadTargetFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    // The path itself is not echoed: it can name a private environment.
    throw new TargetConfigError('target descriptor could not be read', { code: 'TARGET_NOT_READABLE' });
  }
  let parsed;
  try {
    // A UTF-8 BOM is stripped: editors on Windows add one silently, and JSON.parse rejects it,
    // which would turn a working descriptor into an unreadable one.
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (_) {
    throw new TargetConfigError('target descriptor is not valid JSON', { code: 'INVALID_JSON' });
  }
  return validateTarget(parsed);
}

/** Directory descriptors are read from. Overridable so tests never depend on the real layout. */
function targetsDir(env = process.env) {
  return env.ATF_TARGETS_DIR ? path.resolve(env.ATF_TARGETS_DIR) : DEFAULT_TARGETS_DIR;
}

/**
 * Load one target by name.
 * @throws {TargetConfigError} TARGET_NOT_FOUND when no descriptor of that name exists.
 */
function loadTarget(name, env = process.env) {
  const safe = requireString(name, 'target', null, { pattern: NAME_RE, maxLength: 64 });
  return loadTargetFile(path.join(targetsDir(env), `${safe}.json`));
}

/** Every configured target name, sorted. Used by documentation and by the credential scan. */
function listTargets(env = process.env) {
  const dir = targetsDir(env);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  return entries.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
}

/**
 * Compose the Redis key prefix for one deployment.
 *
 * A deployment that writes keys under its own prefix puts it here, once, rather than repeating
 * the application's own prefixes in every environment. The target's prefix always comes last,
 * because it is the part the application itself owns.
 */
function composeKeyPrefix(target, { namespace = null, deploymentPrefix = null } = {}) {
  const parts = [deploymentPrefix, namespace, target.redis.sessionPrefix].filter(
    (p) => p !== null && p !== undefined && String(p) !== ''
  );
  return parts.join('');
}

/** A full session key for one session id, composed from the target and the environment. */
function sessionKey(target, sessionId, options = {}) {
  return composeKeyPrefix(target, options) + sessionId;
}

/**
 * Safe description for reports and generated documentation.
 * Carries no credential and no host: the target is an application, not a deployment.
 */
function describeTarget(target) {
  return {
    name: target.name,
    displayName: target.displayName,
    version: target.version,
    paths: {
      login: target.auth.loginPath,
      refresh: target.auth.refreshPath,
      logout: target.auth.logoutPath,
      me: target.auth.mePath,
      access: target.auth.accessPath,
    },
    cookieAuth: target.auth.cookieAuth,
    rotationEnabled: target.auth.rotationEnabled,
    globalLogout: target.auth.globalLogout,
    logoutSuccessStatus: target.auth.logoutSuccessStatus,
    expiresFormat: target.auth.fields.expiresFormat,
    redisPrefixes: { ...target.redis },
  };
}

module.exports = {
  TargetConfigError,
  validateTarget,
  loadTarget,
  loadTargetFile,
  listTargets,
  targetsDir,
  describeTarget,
  composeKeyPrefix,
  sessionKey,
  DEFAULT_TARGETS_DIR,
};
