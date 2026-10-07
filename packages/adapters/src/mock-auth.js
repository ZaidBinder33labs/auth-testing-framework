'use strict';
// Mock AuthAdapter: deterministic auth lifecycle driven by in-memory state.
// Supports rotation, session isolation, and configurable failure modes for negative tests.
const crypto = require('crypto');

function makeToken(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

const CODE_MESSAGES = {
  INVALID_CREDENTIALS: 'Invalid credentials: password is wrong or user not found',
  MISSING_CREDENTIALS: 'Missing credentials: password is required',
  INVALID_TOKEN: 'Invalid refresh token',
  EXPIRED_TOKEN: 'Expired refresh token',
  MALFORMED_TOKEN: 'Malformed refresh token',
  NOT_AUTHENTICATED: 'Session not authenticated',
};

class MockAuthAdapter {
  constructor(opts = {}) {
    this.rotationEnabled = !!opts.rotationEnabled;
    this.failRefresh = opts.failRefresh || null; // error code to throw on refresh
    this.failLogin = opts.failLogin || null;     // error code to throw on login
    this.sessions = new Map();                   // sessionId -> session record
    this.tenantSessions = new Map();             // tenantId -> Set(sessionId)
    this.globalLogout = !!opts.globalLogout;     // logout invalidates all sessions for tenant
    this.reuseAllowed = !!opts.reuseAllowed;     // refresh token reuse allowed
  }

  async login(tenant, actor, credentials = {}) {
    if (this.failLogin) {
      const msg = CODE_MESSAGES[this.failLogin] || `login failed (${this.failLogin})`;
      const err = new Error(msg);
      err.code = this.failLogin;
      throw err;
    }
    if (!credentials.password) {
      const err = new Error('Missing credentials: password is required');
      err.code = 'MISSING_CREDENTIALS';
      throw err;
    }
    const sessionId = `sess_${crypto.randomBytes(12).toString('hex')}`;
    const accessToken = makeToken('at');
    const refreshToken = makeToken('rt');
    const record = {
      id: sessionId,
      tenantId: tenant.id,
      actorId: actor.id,
      accessToken,
      refreshToken,
      previousRefreshTokens: [],
      state: 'authenticated',
      createdAt: Date.now(),
      expiresIn: 3600,
      tokenType: 'Bearer',
      rotationEnabled: this.rotationEnabled,
    };
    this.sessions.set(sessionId, record);
    let set = this.tenantSessions.get(tenant.id);
    if (!set) { set = new Set(); this.tenantSessions.set(tenant.id, set); }
    set.add(sessionId);
    return {
      sessionId,
      accessToken,
      refreshToken,
      expiresIn: 3600,
      tokenType: 'Bearer',
      rotationEnabled: this.rotationEnabled,
    };
  }

  async refresh(session) {
    if (this.failRefresh) {
      const msg = CODE_MESSAGES[this.failRefresh] || `refresh failed (${this.failRefresh})`;
      const err = new Error(msg);
      err.code = this.failRefresh;
      throw err;
    }
    const rec = this.sessions.get(session.id);
    if (!rec || rec.state !== 'authenticated') {
      const err = new Error('Session not authenticated');
      err.code = 'NOT_AUTHENTICATED';
      throw err;
    }
    const newAccess = makeToken('at');
    let newRefresh = rec.refreshToken;
    let rotated = false;
    let previousRefreshToken;
    if (this.rotationEnabled) {
      newRefresh = makeToken('rt');
      previousRefreshToken = rec.refreshToken;
      rec.previousRefreshTokens.push(rec.refreshToken);
      rotated = true;
    }
    rec.accessToken = newAccess;
    if (previousRefreshToken) rec.refreshToken = newRefresh;
    rec.refreshedAt = Date.now();
    return {
      accessToken: newAccess,
      refreshToken: newRefresh,
      previousRefreshToken,
      rotated,
      expiresIn: 3600,
      tokenType: 'Bearer',
    };
  }

  async logout(session) {
    const rec = this.sessions.get(session.id);
    if (!rec) return { invalidated: [], count: 0, state: 'not-found' };
    const invalidated = [session.id];
    rec.state = 'logged-out';
    if (this.globalLogout) {
      for (const sid of this.tenantSessions.get(rec.tenantId) || []) {
        const other = this.sessions.get(sid);
        if (other && other.state === 'authenticated') {
          other.state = 'logged-out';
          invalidated.push(sid);
        }
      }
    }
    return { invalidated, count: invalidated.length, state: 'logged-out' };
  }

  async getSessionState(session) {
    const rec = this.sessions.get(session.id);
    if (!rec) return { authenticated: false, state: 'not-found' };
    return {
      authenticated: rec.state === 'authenticated',
      state: rec.state,
      accessToken: rec.accessToken,
      refreshToken: rec.refreshToken,
      refreshTokenFingerprint: rec.refreshToken ? `fp_${rec.refreshToken.slice(4, 12)}` : null,
      rotated: rec.previousRefreshTokens.length > 0,
      previousRefreshTokens: rec.previousRefreshTokens,
    };
  }

  async clearSession(session) {
    this.sessions.delete(session.id);
  }

  // Test helpers
  _sessionCount() { return this.sessions.size; }
  _countForTenant(tenantId) { return (this.tenantSessions.get(tenantId) || new Set()).size; }
}

function createMockAuthAdapter(opts = {}) {
  return new MockAuthAdapter(opts);
}

module.exports = { MockAuthAdapter, createMockAuthAdapter };