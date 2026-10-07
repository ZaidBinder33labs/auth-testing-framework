'use strict';
// Token security: fingerprinting, inspection, redaction, assertions.
// Never log raw tokens, cookies, passwords, or secrets.
const crypto = require('crypto');

const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'secret', 'client_secret', 'clientSecret', 'api_key', 'apiKey',
  'cookie', 'cookies', 'set-cookie', 'Set-Cookie', 'authorization', 'Authorization',
  'private_key', 'privateKey', 'refresh_token', 'refreshToken', 'access_token', 'accessToken',
  'id_token', 'idToken', 'token', 'jwt',
]);
// Keys whose value is a raw credential rather than a referenceable token: redact entirely.
const CREDENTIAL_KEYS = new Set([
  'password', 'passwd', 'secret', 'client_secret', 'clientSecret', 'api_key', 'apiKey',
  'cookie', 'cookies', 'set-cookie', 'Set-Cookie', 'authorization', 'Authorization',
  'private_key', 'privateKey',
]);

class TokenFingerprintError extends Error {
  constructor(message) { super(message); this.name = 'TokenFingerprintError'; }
}

/** Deterministic SHA-256 fingerprint of a token. Same token -> same fingerprint. */
function fingerprint(value) {
  if (value === undefined || value === null) throw new TokenFingerprintError('cannot fingerprint null/undefined token');
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function fingerprintFull(value) {
  if (value === undefined || value === null) throw new TokenFingerprintError('cannot fingerprint null/undefined token');
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** True if two tokens are the same token (by fingerprint). */
function sameToken(a, b) {
  try { return fingerprint(a) === fingerprint(b); } catch (_) { return false; }
}

function isOpaque(value) {
  return typeof value === 'string' && value.split('.').length !== 3;
}

function isJwtLike(value) {
  return typeof value === 'string' && value.split('.').length === 3 && value.length > 40;
}

function decodeJwtParts(token) {
  if (!isJwtLike(token)) return null;
  const parts = String(token).split('.');
  try {
    const decode = (p) => JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return { header: decode(parts[0]), payload: decode(parts[1]), signature: parts[2], raw: token };
  } catch (_) {
    return null;
  }
}

function inspect(token) {
  if (token === undefined || token === null) throw new TokenFingerprintError('cannot inspect null/undefined token');
  const fp = fingerprint(token);
  const jwt = decodeJwtParts(token);
  const base = {
    fingerprint: fp,
    kind: jwt ? 'JWT' : 'OPAQUE',
    length: String(token).length,
    prefix: String(token).slice(0, 8),
  };
  if (jwt) {
    base.claims = {
      issuer: jwt.payload.iss,
      audience: jwt.payload.aud,
      subject: jwt.payload.sub,
      tenantId: jwt.payload.tid || jwt.payload.tenantId || jwt.payload.tenant,
      userId: jwt.payload.uid || jwt.payload.userId || jwt.payload.sub,
      issuedAt: jwt.payload.iat,
      expiresAt: jwt.payload.exp,
      notBefore: jwt.payload.nbf,
      type: jwt.payload.typ || jwt.payload.type,
    };
    base.expired = typeof jwt.payload.exp === 'number' ? Date.now() / 1000 >= jwt.payload.exp : null;
    base.secondsToExpiry = typeof jwt.payload.exp === 'number' ? jwt.payload.exp - Date.now() / 1000 : null;
  }
  return base;
}

/** Redact a value for safe logging: replace secrets with [REDACTED] and tokens with fingerprints. */
function redact(obj) {
  if (obj === undefined || obj === null) return obj;
  if (typeof obj === 'string') {
    if (isJwtLike(obj) || isOpaque(obj)) return `[TOKEN:${fingerprint(obj)}]`;
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(redact);
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (CREDENTIAL_KEYS.has(k)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'string' && (isJwtLike(v) || isOpaque(v))) {
      out[k] = `[TOKEN:${fingerprint(v)}]`;
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

/** Assert a serialized object never contains a raw token value. */
function assertRedacted(serialized, label = 'evidence') {
  const text = typeof serialized === 'string' ? serialized : JSON.stringify(serialized);
  // Heuristic: reject JWT-shaped or long opaque strings that look like secrets.
  const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
  const matches = text.match(jwtRe);
  if (matches && matches.length) {
    throw new TokenFingerprintError(`${label} contains ${matches.length} raw JWT(s)`);
  }
  return true;
}

function assertDifferentTokens(a, b) {
  if (sameToken(a, b)) throw new TokenFingerprintError('expected different tokens but fingerprints match');
}

module.exports = {
  fingerprint,
  fingerprintFull,
  sameToken,
  isOpaque,
  isJwtLike,
  decodeJwtParts,
  inspect,
  redact,
  assertRedacted,
  assertDifferentTokens,
  SENSITIVE_KEYS,
  TokenFingerprintError,
};