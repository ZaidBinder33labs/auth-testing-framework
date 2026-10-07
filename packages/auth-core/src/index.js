'use strict';
// Authentication lifecycle: login, session, access/refresh tokens, logout.
// AuthManager delegates all I/O to an AuthAdapter (see adapters package). The manager itself
// is stateless except for the session records it owns, so it can be driven by any transport.
const crypto = require('crypto');

const SESSION_ID_RE = /^sess_[a-z0-9_]{3,64}$/i;

function generateSessionId() {
  return `sess_${crypto.randomBytes(12).toString('hex')}`;
}

class AuthStateError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'AuthStateError';
    this.code = code || 'AUTH_STATE_ERROR';
  }
}

function validateSessionId(id) {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) {
    throw new AuthStateError(`invalid session id: ${id}`, { code: 'INVALID_SESSION_ID' });
  }
  return id;
}

class Session {
  constructor({ id, tenantId, actorId, adapter } = {}) {
    this.id = validateSessionId(id);
    this.tenantId = tenantId;
    this.actorId = actorId;
    this.adapter = adapter;
    this.createdAt = Date.now();
    this.state = 'pending'; // pending -> authenticated -> expired -> logged-out
  }

  markAuthenticated(meta = {}) {
    this.state = 'authenticated';
    this.authenticatedAt = Date.now();
    Object.assign(this, meta);
    return this;
  }

  markExpired() {
    this.state = 'expired';
    return this;
  }

  markLoggedOut() {
    this.state = 'logged-out';
    return this;
  }
}

class AuthManager {
  constructor(adapter, opts = {}) {
    if (!adapter) throw new AuthStateError('AuthAdapter is required', { code: 'NO_ADAPTER' });
    if (typeof adapter.login !== 'function') throw new AuthStateError('adapter must implement login()', { code: 'ADAPTER_CONTRACT' });
    if (typeof adapter.logout !== 'function') throw new AuthStateError('adapter must implement logout()', { code: 'ADAPTER_CONTRACT' });
    if (typeof adapter.getSessionState !== 'function') throw new AuthStateError('adapter must implement getSessionState()', { code: 'ADAPTER_CONTRACT' });
    this.adapter = adapter;
    this.sessions = new Map();
    this.refreshLock = opts.refreshLock || null;
  }

  async login(tenant, actor, credentials = {}) {
    const result = await this.adapter.login(tenant, actor, credentials);
    const session = new Session({
      id: result.sessionId || generateSessionId(),
      tenantId: tenant.id,
      actorId: actor.id,
      adapter: this.adapter,
    });
    session.markAuthenticated({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      tokenType: result.tokenType,
      rotationEnabled: !!result.rotationEnabled,
    });
    this.sessions.set(session.id, session);
    return { session, ...result };
  }

  async refresh(session) {
    if (this.refreshLock) await this.refreshLock.acquire(session.id);
    try {
      const state = await this.getSessionState(session);
      if (state.authenticated === false) throw new AuthStateError('session not authenticated', { code: 'NOT_AUTHENTICATED' });
      const result = await this.adapter.refresh(session);
      session.markAuthenticated({
        accessToken: result.accessToken,
        previousAccessToken: session.accessToken,
        refreshToken: result.refreshToken || session.refreshToken,
        previousRefreshToken: result.refreshToken ? session.refreshToken : undefined,
        expiresIn: result.expiresIn,
        refreshedAt: Date.now(),
      });
      return { session, ...result };
    } finally {
      if (this.refreshLock) this.refreshLock.release(session.id);
    }
  }

  async logout(session) {
    const result = await this.adapter.logout(session);
    session.markLoggedOut();
    return result;
  }

  async getSessionState(session) {
    return this.adapter.getSessionState(session);
  }

  async getAccessToken(session) {
    const state = await this.getSessionState(session);
    return state.accessToken || session.accessToken || null;
  }

  async getRefreshTokenState(session) {
    const state = await this.getSessionState(session);
    return {
      present: !!state.refreshToken,
      fingerprint: state.refreshTokenFingerprint || null,
      rotated: state.rotated || false,
    };
  }

  async isAuthenticated(session) {
    const state = await this.getSessionState(session);
    return state.authenticated === true;
  }

  async clearSession(session) {
    if (this.adapter.clearSession) await this.adapter.clearSession(session);
    session.markLoggedOut();
    this.sessions.delete(session.id);
  }

  /**
   * Effective access for the authenticated user, when the adapter supports it.
   *
   * The result is the server's own report of the caller's permissions, not a decision made
   * here. Adapters that cannot answer (e.g. the mock) return an explicit unsupported result
   * rather than an empty list, so a missing capability is never read as "no permissions".
   */
  async getEffectiveAccess(session) {
    if (!this.adapter || typeof this.adapter.getEffectiveAccess !== 'function') {
      return { supported: false, reason: 'ADAPTER_UNSUPPORTED', items: [], screenCodes: [], moduleCodes: [], canApprove: [] };
    }
    const access = await this.adapter.getEffectiveAccess(session);
    return { supported: true, reason: null, ...access };
  }

  /**
   * True when the adapter reports that `screenCode` is granted for this session.
   * Convenience for shared assertions; still only a report, not an authorization decision.
   */
  async hasEffectiveScreen(session, screenCode) {
    const access = await this.getEffectiveAccess(session);
    if (!access.supported) return false;
    return access.screenCodes.includes(screenCode);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  listSessions() {
    return [...this.sessions.values()];
  }
}

module.exports = {
  AuthManager,
  Session,
  AuthStateError,
  generateSessionId,
  SESSION_ID_RE,
};