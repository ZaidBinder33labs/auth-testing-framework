'use strict';
// Rate-limit key generation.
// The actual key pattern is discovered from the target; this module provides a
// configurable generator and a discovery record. It NEVER invents keys.
const crypto = require('crypto');

const SCOPE_TYPES = Object.freeze({
  USER: 'user',
  OFFICE: 'office',
  IP: 'ip',
  GLOBAL: 'global',
  TENANT: 'tenant',
});

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/** Build a key from a pattern template. Unknown fields are left as-is so the
 * caller can see what was not substituted. */
function buildKey(pattern, fields = {}) {
  return String(pattern).replace(/\{(\w+)\}/g, (_, k) =>
    fields[k] !== undefined && fields[k] !== null && fields[k] !== '' ? String(fields[k]) : `{${k}}`);
}

/** Normalise an IPv6 address per the configured prefix length.
 * Returns { address, network, prefix, normalized }. */
function normalizeIpv6(address, prefixLength = 64) {
  if (!address || typeof address !== 'string') return { address: null, network: null, prefix: null, normalized: null };
  const cleaned = address.trim().toLowerCase();
  // Expand :: shorthand
  let expanded = cleaned;
  if (cleaned.includes('::')) {
    const parts = cleaned.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    expanded = [...left, ...Array(missing).fill('0'), ...right].join(':');
  }
  const groups = expanded.split(':').map((g) => g.padStart(4, '0'));
  const pl = Number.parseInt(String(prefixLength).replace(/[^0-9]/g, ''), 10);
  const safePrefix = Number.isFinite(pl) && pl >= 0 && pl <= 128 ? pl : 64;
  const full = groups.join(':');
  // Truncate to the prefix boundary.
  const bits = groups.map((g) => Number.parseInt(g, 16).toString(2).padStart(16, '0')).join('');
  const truncated = bits.slice(0, safePrefix).padEnd(128, '0');
  const outGroups = [];
  for (let i = 0; i < 128; i += 16) outGroups.push(Number.parseInt(truncated.slice(i, i + 16), 2).toString(16));
  const network = outGroups.join(':');
  return {
    address: full,
    network,
    prefix: safePrefix,
    normalized: network,
    fingerprint: fingerprint(full),
  };
}

/** Normalise an IPv4 address. */
function normalizeIpv4(address) {
  if (!address || typeof address !== 'string') return { address: null, normalized: null };
  const parts = address.trim().split('.');
  if (parts.length !== 4) return { address: address.trim(), normalized: null };
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return { address: address.trim(), normalized: null };
  return { address: nums.join('.'), normalized: nums.join('.') };
}

function normalizeIp(address, prefixLength = 64) {
  const trimmed = (address || '').trim();
  if (trimmed.includes(':')) return normalizeIpv6(trimmed, prefixLength);
  return normalizeIpv4(trimmed);
}

class KeyGenerator {
  constructor(cfg, discovery = {}) {
    this.cfg = cfg;
    this.patterns = discovery.patterns || {};
    this.discoveredAt = discovery.discoveredAt || null;
    this.source = discovery.source || null;
  }

  /** Generate a key for a scope. Returns { key, pattern, fields, discovered }. */
  generate(scope, fields = {}) {
    const pattern = this.patterns[scope];
    if (!pattern) {
      return {
        key: null,
        pattern: null,
        fields,
        discovered: false,
        reason: `no pattern discovered for scope ${scope}`,
      };
    }
    const key = buildKey(pattern, fields);
    return { key, pattern, fields, discovered: true };
  }

  /** Record a discovered pattern. */
  discover(scope, pattern, source = 'observed') {
    this.patterns[scope] = pattern;
    this.discoveredAt = new Date().toISOString();
    this.source = source;
    return pattern;
  }

  hasPattern(scope) {
    return !!this.patterns[scope];
  }
}

module.exports = {
  SCOPE_TYPES,
  KeyGenerator,
  buildKey,
  normalizeIpv6,
  normalizeIpv4,
  normalizeIp,
  fingerprint,
};