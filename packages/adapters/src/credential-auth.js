'use strict';
// CredentialAuthAdapter â€” the session lifecycle for an application described by a target descriptor.
//
// Transport: @atf/http-transport, which is application-agnostic. The request context is injected
// by the caller; this adapter never creates one, because a request context owns cookie state and
// must be shared for the whole session lifecycle (an HttpOnly refresh cookie is set by the
// server, not by us).
//
// The base URL comes from the environment descriptor via resolveBaseUrl, never from a global
// configuration singleton, so this file depends on no other repository.
//
// What the application IS â€” endpoint paths, credential and token field names, expiry format,
// rotation, cookie-vs-body refresh, the logout success status, JWT claim names and the Redis key
// prefixes â€” comes from config/targets/<name>.json. Response validation follows the OpenAPI
// contract that was verified against the onboarding service.
//
// What stays in code is the flow itself: login, then refresh, then logout, then a session-state
// lookup, with the access token carried in an Authorization: Bearer header. A target whose flow
// departs from that shape needs its own adapter; see docs/INTEGRATION.md for the boundary.

const crypto = require('crypto');
const { HttpTransport } = require('@atf/http-transport');
const { fingerprint } = require('@atf/token-security');
const { loadTarget, validateTarget, TargetConfigError } = require('@atf/target-config');

/**
 * The userInfo keys the framework always publishes, in a stable order.
 * A target maps its own field names onto these; an unmapped or unsent field is null.
 */
const USER_INFO_FIELDS = [
  'userId', 'email', 'username', 'firstName', 'lastName', 'designation', 'userType',
  'tenantId', 'tenantName', 'tenantSlug', 'tenantLogoUrl', 'subscriptionStatus',
  'seatLimit', 'seatsUsed', 'trialEndsAt', 'buyerScopeMode', 'isTenantAdmin',
  'companySetupRequired',
];

// Session IDs must satisfy SESSION_ID_RE in @atf/auth-core: /^sess_[a-z0-9_]{3,64}$/i
function generateSessionId() {
  return `sess_${crypto.randomBytes(12).toString('hex')}`;
}

/** Error with a stable machine-readable code so callers and tests never match on message text. */
class CredentialAuthError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'CredentialAuthError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** An APIRequestContext-compatible object: anything exposing fetch(url, init). */
function isRequestContext(ctx) {
  return !!ctx && typeof ctx.fetch === 'function';
}

class CredentialAuthAdapter {
  /**
   * @param {Object} opts
   * @param {Object}  [opts.target]               A validated target descriptor. Defaults to
   *                                             config/targets/binder.json.
   * @param {string}  [opts.targetName]           Name of a descriptor to load instead.
   * @param {string}  [opts.onboardingUrl]        Base URL of the onboarding service.
   * @param {Function}[opts.resolveBaseUrl]      Injection seam returning the environment's base
   *                                             URL. Consulted only when onboardingUrl is
   *                                             empty, so an explicit URL always wins. This
   *                                             replaces a global config singleton: the
   *                                             adapter reads no ambient configuration.
   * @param {Object}  [opts.requestContext]      Injected request context (must expose .fetch).
   * @param {number}  [opts.apiTimeout]           Per-request timeout in ms.
   * @param {Function}[opts.apiFactory]           Injection seam for tests: (ctx, opts) => client.
   */
  constructor(opts = {}) {
    const resolved = opts.onboardingUrl
      || (typeof opts.resolveBaseUrl === 'function' ? opts.resolveBaseUrl() : null);
    this.onboardingUrl = resolved || null;
    this.apiTimeout = opts.apiTimeout || 90000;
    this.requestContext = opts.requestContext || null;
    this.apiFactory = opts.apiFactory || ((ctx, o) => new HttpTransport(ctx, o));

    this.target = resolveTarget(opts);

    if (!this.onboardingUrl) {
      throw new CredentialAuthError('CredentialAuthAdapter requires onboardingUrl configuration', 'NO_ONBOARDING_URL');
    }
  }

  /** True when a request context has been injected and the adapter can issue real requests. */
  get available() {
    return isRequestContext(this.requestContext);
  }

  /**
   * Build a client for one call.
   * The context is required: without it there is no transport, and silently returning a
   * client that throws deep inside the request would hide a configuration error.
   */
  client(token) {
    if (!isRequestContext(this.requestContext)) {
      throw new CredentialAuthError(
        'CredentialAuthAdapter requires an injected requestContext (APIRequestContext) to call the onboarding API',
        'NO_REQUEST_CONTEXT'
      );
    }
    return this.apiFactory(this.requestContext, {
      base: this.onboardingUrl,
      token,
      timeout: this.apiTimeout,
    });
  }

  /**
   * Login as an actor.
   * The path, the credential field names, the token field names and the expiry format all come
   * from the target descriptor.
   * The transport takes the JSON body as its second positional argument.
   */
  async login(tenant, actor, credentials = {}) {
    const f = this.target.auth.fields;
    const body = this.credentialBody(credentials);

    if (!tenant || !tenant.id) {
      throw new CredentialAuthError('Missing tenant: a tenant with .id is required', 'MISSING_TENANT');
    }
    if (!actor || !actor.id) {
      throw new CredentialAuthError('Missing actor: an actor with .id is required', 'MISSING_ACTOR');
    }

    const api = this.client(undefined);

    let response;
    try {
      response = await api.post(this.target.auth.loginPath, body);
      // Inside the try: a rejected status must be normalised like any other failure.
      response.expect(200);
    } catch (error) {
      throw this.mapTransportError(error, 'LOGIN_TRANSPORT_FAILED');
    }

    const payload = this.requireBody(response);

    if (!payload[f.accessTokenField]) {
      throw new CredentialAuthError('Login response missing access token', 'MALFORMED_LOGIN_RESPONSE');
    }

    const refreshToken = payload[f.refreshTokenField] || null;
    return {
      sessionId: generateSessionId(),
      tenantId: tenant.id,
      actorId: actor.id,
      accessToken: payload[f.accessTokenField],
      refreshToken,
      expiresIn: this.readExpiry(payload),
      tokenType: (f.tokenTypeField && payload[f.tokenTypeField]) || 'bearer',
      // Rotation is only meaningful when the server hands back a refresh token.
      // A cookie-borne refresh token is HttpOnly, so its presence in the body is the only signal
      // we get; where the descriptor says rotation is off, the token is used until it expires.
      rotationEnabled: this.target.auth.rotationEnabled && !!refreshToken,
    };
  }

  /**
   * Refresh a session.
   * Where the target sets the refresh token in an HttpOnly cookie, the request body is empty and
   * the transport replays the cookie. Where the target returns it in the body, it must be sent
   * back explicitly, because nothing else would carry it.
   */
  async refresh(session) {
    if (!session || !session.accessToken) {
      throw new CredentialAuthError('Session not authenticated', 'NOT_AUTHENTICATED');
    }

    const f = this.target.auth.fields;
    const api = this.client(session.accessToken);

    const body = this.target.auth.cookieAuth
      ? {}
      : { [f.refreshTokenField]: session.refreshToken };

    let response;
    try {
      response = await api.post(this.target.auth.refreshPath, body);
      response.expect(200);
    } catch (error) {
      throw this.mapTransportError(error, 'REFRESH_TRANSPORT_FAILED');
    }

    const payload = this.requireBody(response);

    if (!payload[f.accessTokenField]) {
      throw new CredentialAuthError('Refresh response missing access token', 'MALFORMED_REFRESH_RESPONSE');
    }

    const newRefresh = payload[f.refreshTokenField] || null;
    const rotated = this.target.auth.rotationEnabled
      && !!newRefresh && !!session.refreshToken && newRefresh !== session.refreshToken;

    return {
      accessToken: payload[f.accessTokenField],
      refreshToken: newRefresh || session.refreshToken || null,
      previousRefreshToken: rotated ? session.refreshToken : undefined,
      rotated,
      expiresIn: this.readExpiry(payload),
      tokenType: (f.tokenTypeField && payload[f.tokenTypeField]) || 'bearer',
    };
  }

  /**
   * Log out a session.
   * The contract declares no request body, so the request is sent without one.
   * A logout that cannot be confirmed must not be reported as a successful invalidation.
   */
  async logout(session) {
    if (!session) {
      return { invalidated: [], count: 0, state: 'logout-failed', code: 'NO_SESSION' };
    }
    const sessionRef = session.id || session.sessionId || null;
    if (!session.accessToken) {
      return { invalidated: [], count: 0, state: 'logout-failed', code: 'NOT_AUTHENTICATED' };
    }

    const api = this.client(session.accessToken);

    try {
      const response = await api.send('POST', this.target.auth.logoutPath);
      // The success status is the target's to declare.
      response.expect(this.target.auth.logoutSuccessStatus);
      return { invalidated: sessionRef ? [sessionRef] : [], count: sessionRef ? 1 : 0, state: 'logged-out' };
    } catch (error) {
      const mapped = this.mapTransportError(error, 'LOGOUT_FAILED');
      return {
        invalidated: [],
        count: 0,
        state: 'logout-failed',
        code: mapped.code,
        // Sanitized: never the raw server body or a stack that could carry a token.
        error: mapped.message,
      };
    }
  }

  /**
   * Validate a session against the server.
    * GET the target's mePath  (Bearer)
   */
  async getSessionState(session) {
    const unauthenticated = (state, extra = {}) => ({
      authenticated: false,
      state,
      accessToken: null,
      refreshToken: null,
      refreshTokenFingerprint: null,
      rotated: false,
      previousRefreshTokens: [],
      ...extra,
    });

    if (!session || !session.accessToken) return unauthenticated('not-found');

    const api = this.client(session.accessToken);

    let response;
    try {
      response = await api.get(this.target.auth.mePath, {});
    } catch (error) {
      const mapped = this.mapTransportError(error, 'ME_TRANSPORT_FAILED');
      // A transport failure is not proof the session is invalid; keep it distinguishable.
      return unauthenticated(mapped.code === 'INVALID_TOKEN' ? 'expired' : 'error', { code: mapped.code });
    }

    try {
      response.expect(200);
    } catch (error) {
      const status = error && error.response ? error.response.status : null;
      if (status === 401 || status === 403) return unauthenticated('expired', { code: 'INVALID_TOKEN' });
      return unauthenticated('error', { code: 'ME_UNEXPECTED_STATUS' });
    }

    const body = this.requireBody(response);

    return {
      authenticated: true,
      state: 'authenticated',
      accessToken: session.accessToken,
      refreshToken: session.refreshToken || null,
      refreshTokenFingerprint: this.safeToken(session.refreshToken).fingerprint,
      rotated: false,
      previousRefreshTokens: [],
      userInfo: this.mapUser(body),
    };
  }

  /**
   * Map the target's profile fields onto the framework's stable userInfo shape.
   * A field the target does not declare, or does not send, is null. Every key the framework
   * publishes is always present, so a consumer never has to test for the key itself.
   */
  mapUser(body) {
    const info = {};
    for (const key of USER_INFO_FIELDS) {
      const targetField = this.target.auth.userFields[key];
      info[key] = targetField ? (body[targetField] ?? null) : null;
    }
    return info;
  }

  /**
   * Effective access for the authenticated user.
   * GET the target's accessPath  (Bearer)
   *
   * Contract: 200 returns an array of grant rows. The field names in each row are the target's,
   * declared in auth.accessFields; screenCode, moduleCode, scope and level are read as-is, while
   * canApprove and canDelete must be strict booleans.
   *
   * This is a report of what the server says the caller may do. It is not an authorization
   * decision made here: callers must still treat every protected resource as server-enforced
   * and verify the outcome of the request they actually make.
   *
   * @returns {Promise<{items: Array<Object>, screenCodes: string[], moduleCodes: string[],
   *                    canApprove: string[]}>}
   */
  async getEffectiveAccess(session) {
    if (!session || !session.accessToken) {
      throw new CredentialAuthError('Session not authenticated', 'NOT_AUTHENTICATED');
    }

    const api = this.client(session.accessToken);

    let response;
    try {
      response = await api.get(this.target.auth.accessPath, {});
    } catch (error) {
      throw this.mapTransportError(error, 'ACCESS_TRANSPORT_FAILED');
    }

    try {
      response.expect(200);
    } catch (error) {
      const status = error && error.response ? error.response.status : null;
      if (status === 401 || status === 403) {
        throw new CredentialAuthError('Effective access request was not authorized', 'INVALID_TOKEN', error);
      }
      throw this.mapTransportError(error, 'ACCESS_UNEXPECTED_STATUS');
    }

    const body = this.requireBody(response);

    // The schema is an array; tolerate a single object defensively but do not invent a wrapper.
    const raw = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : null);
    if (!raw) {
      throw new CredentialAuthError('Effective access response is not an array', 'MALFORMED_ACCESS_RESPONSE');
    }

    const a = this.target.auth.accessFields;
    const items = raw.map((entry) => ({
      screenCode: entry[a.screenCode] ?? null,
      moduleCode: entry[a.moduleCode] ?? null,
      scope: entry[a.scope] ?? null,
      level: entry[a.level] ?? null,
      // Still strictly boolean: a truthy string is not an approval.
      canApprove: entry[a.canApprove] === true,
      canDelete: entry[a.canDelete] === true,
    }));

    return {
      items,
      screenCodes: items.map((i) => i.screenCode).filter(Boolean),
      moduleCodes: [...new Set(items.map((i) => i.moduleCode).filter(Boolean))],
      canApprove: items.filter((i) => i.canApprove).map((i) => i.screenCode).filter(Boolean),
    };
  }

  // ---------------------------------------------------------------------------------------
  // Token helpers
  // ---------------------------------------------------------------------------------------

  /**
   * Tenant claim from an unverified JWT payload.
   * Decoding proves nothing about authenticity â€” it only reads a claim the server will
   * enforce again on every request. Never treat this as an authorization decision.
   */
  tokenTenant(token) {
    return this.claim(token, this.target.auth.claims.tenant);
  }

  /** Subject (user id) claim from an unverified JWT payload. See tokenTenant(). */
  tokenUser(token) {
    return this.claim(token, this.target.auth.claims.user);
  }

  claim(token, key) {
    try {
      const parts = String(token).split('.');
      if (parts.length < 2) return null;
      const payload = JSON.parse(
        Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      );
      const value = payload[key];
      return value === undefined ? null : value;
    } catch (_) {
      return null;
    }
  }

  /**
   * Safe descriptor for a token: a SHA-256 fingerprint, never any part of the token.
   * Uses @atf/token-security so evidence and reports cannot leak token material.
   */
  safeToken(token) {
    if (token === undefined || token === null || token === '') return { fingerprint: null };
    return { fingerprint: `fp_${fingerprint(token)}` };
  }

  /** Safe descriptor for a session. See safeToken(). */
  safeSession(session) {
    return { fingerprint: this.safeToken(session && session.accessToken).fingerprint };
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------

  /**
   * The login body, with the framework's two credential names mapped to the target's.
   * Missing credentials are refused before any request, so a misconfigured environment cannot
   * turn into a 422 that looks like a wrong password.
   */
  credentialBody(credentials) {
    const map = this.target.auth.loginFields;
    const email = credentials ? credentials.email : undefined;
    const password = credentials ? credentials.password : undefined;
    if (!email || !password) {
      throw new CredentialAuthError('Missing credentials: email and password are required', 'MISSING_CREDENTIALS');
    }
    return { [map.email]: email, [map.password]: password };
  }

  /**
   * Seconds until expiry, in whichever form the target declares.
   * A missing or unparseable value yields null so callers can apply their own default. Zero is a
   * meaningful value (already expired) and is preserved.
   */
  readExpiry(payload) {
    const { expiresField, expiresFormat } = this.target.auth.fields;
    const raw = payload[expiresField];
    if (expiresFormat === 'seconds') {
      if (raw === undefined || raw === null || raw === '') return null;
      const seconds = Number(raw);
      // A relative TTL is returned as-is rather than re-derived from the clock, so a slow test
      // cannot make a live token look expired.
      return Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : null;
    }
    return readExpiresIn(raw);
  }

  requireBody(response) {
    const body = response ? response.body : null;
    if (!body || typeof body !== 'object') {
      throw new CredentialAuthError('API response body is missing or not JSON', 'MALFORMED_RESPONSE');
    }
    return body;
  }

  /**
   * Normalise transport and HTTP failures into a coded, credential-free error.
   * Message text comes from our own vocabulary; the server response is never echoed,
   * because it can contain tokens or credentials.
   */
  mapTransportError(error, fallbackCode) {
    if (error instanceof CredentialAuthError) return error;

    const status = error && error.response ? error.response.status : null;

    if (status === 401 || status === 403) {
      return new CredentialAuthError('Authentication rejected by the onboarding API', 'INVALID_TOKEN', error);
    }
    if (status === 422) {
      return new CredentialAuthError('Request rejected as invalid by the onboarding API', 'INVALID_CREDENTIALS', error);
    }
    if (status === 429) {
      return new CredentialAuthError('Rate limited by the onboarding API', 'RATE_LIMITED', error);
    }
    if (status === 404) {
      return new CredentialAuthError('Endpoint not found on the onboarding API', 'ENDPOINT_NOT_FOUND', error);
    }
    if (status) {
      return new CredentialAuthError(`Unexpected HTTP ${status} from the onboarding API`, 'HTTP_ERROR', error);
    }
    // No response object: timeout, DNS, TLS, connection refused, or a missing context.
    return new CredentialAuthError(
      `Onboarding API request failed before a response (${error && error.name ? error.name : 'unknown'})`,
      fallbackCode,
      error
    );
  }
}

/**
 * Which application this adapter speaks to.
 *
 * `target` is an already-loaded descriptor (or a raw object, which is validated here);
 * `targetName` names a file under config/targets; with neither, the binder target is used.
 * A descriptor that fails validation raises TargetConfigError, whose code identifies the field,
 * because a broken descriptor is a configuration fault rather than an authentication one.
 */
function resolveTarget(opts) {
  if (opts.target) return validateTarget(opts.target);
  return loadTarget(opts.targetName || 'binder');
}

/**
 * Seconds until expiry from an absolute timestamp.
 * A missing or unparseable value yields null so callers can apply their own default.
 * Zero is a meaningful value (the token is already expired) and is preserved.
 */
function readExpiresIn(expiresAt) {
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') return null;
  const expiresDate = new Date(expiresAt);
  const ms = expiresDate.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((ms - Date.now()) / 1000));
}

module.exports = {
  CredentialAuthAdapter,
  CredentialAuthError,
  generateSessionId,
  readExpiresIn,
  resolveTarget,
  TargetConfigError,
  USER_INFO_FIELDS,
};
