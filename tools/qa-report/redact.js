'use strict';
/**
 * Report redaction.
 *
 * Two layers, because either one alone is insufficient:
 *   1. Value-based — secret values taken from the environment are replaced wherever they
 *      appear, even inside a message we did not anticipate.
 *   2. Pattern-based — shapes that are secret by nature (Bearer headers, password fields,
 *      credential-bearing URLs, JWTs, long opaque tokens) are replaced structurally.
 *
 * Redaction runs before anything is written to disk. The dashboard never renders raw text.
 */

const crypto = require('crypto');

// Environment variables whose values must never appear in an artifact.
const SECRET_ENV_KEYS = [
  'E2E_PASSWORD', 'API_TOKEN', 'READONLY_TOKEN', 'REDIS_PASSWORD', 'REDIS_USERNAME',
  'ONBOARDING_EXTRA', 'E2E_PASSWORD_ALT', 'API_SECRET', 'CLIENT_SECRET',
];

const MIN_SECRET_LENGTH = 4;

function collectSecretValues(env = process.env) {
  const out = new Set();
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length >= MIN_SECRET_LENGTH) out.add(value.trim());
  }
  // Credentials embedded in a configured Redis/API URL.
  for (const key of ['REDIS_URL', 'IPO_API_URL', 'ONBOARDING_API_URL']) {
    const value = env[key];
    if (typeof value !== 'string' || !value.includes('@')) continue;
    const m = /:\/\/([^:/@]+):([^@/]+)@/.exec(value);
    if (m) {
      if (m[1].length >= MIN_SECRET_LENGTH) out.add(m[1]);
      if (m[2].length >= MIN_SECRET_LENGTH) out.add(m[2]);
    }
  }
  // Longest first so a secret containing another is replaced whole.
  return [...out].sort((a, b) => b.length - a.length);
}

const PATTERNS = [
  // Authorization headers and bearer tokens.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (m) => `${m.split(/\s+/)[0]} [REDACTED]`],
  // JSON / query style secrets.
  [/"(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)"\s*:\s*"[^"]*"/gi,
    (m) => `"${m.split(':')[0].replace(/[" ]/g, '')}":"[REDACTED]"`],
  [/\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*=\s*[^\s&;"']+/gi,
    (m) => `${m.split('=')[0]}=[REDACTED]`],
  // Credential-bearing URLs.
  [/([a-z][a-z0-9+.-]*:\/\/)[^:/@\s]+:[^@/\s]+@/gi, (m) => `${m.split('://')[0]}://[REDACTED]:[REDACTED]@`],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_JWT]'],
  // Cookie values.
  [/\b(set-cookie|cookie)\s*:\s*[^\n]+/gi, (m) => `${m.split(':')[0]}: [REDACTED]`],
];

/**
 * Redact a string.
 * @param {string} input
 * @param {string[]} [secrets] values to scrub; defaults to environment secrets
 */
function redactString(input, secrets = collectSecretValues()) {
  if (input === undefined || input === null) return '';
  let out = String(input);

  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Deep-redact any JSON-compatible value. Keys are preserved; values are scrubbed. */
function redactValue(value, secrets, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, secrets);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function') return undefined;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets, seen));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[redactString(k, secrets)] = redactValue(v, secrets, seen);
    }
    return out;
  }
  return String(value);
}

/** HTML-escape untrusted text. */
function escapeHtml(input) {
  if (input === undefined || input === null) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A stable, non-reversible identifier for a tenant, so reports can correlate tests per tenant
 * without disclosing the tenant identifier itself.
 */
function tenantAlias(alias) {
  if (!alias) return null;
  return `t_${crypto.createHash('sha256').update(String(alias)).digest('hex').slice(0, 8)}`;
}

module.exports = {
  redactString,
  redactValue,
  escapeHtml,
  collectSecretValues,
  tenantAlias,
  SECRET_ENV_KEYS,
};