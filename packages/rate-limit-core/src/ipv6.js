'use strict';
// IPv6 normalization helpers for rate-limit bypass testing.
const crypto = require('crypto');

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/** Expand an IPv6 address to full 8-group form. Returns null if not IPv6. */
function expandIpv6(address) {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim().toLowerCase();
  if (!trimmed.includes(':')) return null;
  let expanded = trimmed;
  if (trimmed.includes('::')) {
    const parts = trimmed.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    expanded = [...left, ...Array(missing).fill('0'), ...right].join(':');
  }
  const groups = expanded.split(':');
  if (groups.length !== 8) return null;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  }
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

/** Truncate an expanded IPv6 to a prefix length. */
function prefixNetwork(expanded, prefixLength) {
  const pl = Number.parseInt(String(prefixLength).replace(/[^0-9]/g, ''), 10);
  const safe = Number.isFinite(pl) && pl >= 0 && pl <= 128 ? pl : 64;
  const bits = expanded.split(':')
    .map((g) => Number.parseInt(g, 16).toString(2).padStart(16, '0'))
    .join('')
    .slice(0, safe)
    .padEnd(128, '0');
  const out = [];
  for (let i = 0; i < 128; i += 16) out.push(Number.parseInt(bits.slice(i, i + 16), 2).toString(16));
  return out.join(':');
}

/** Analyse a set of IPv6 addresses for bypass potential. */
function analyseIpv6Set(addresses, prefixLength = 64) {
  const analysed = (addresses || []).map((a) => {
    const expanded = expandIpv6(a);
    if (!expanded) return { address: a, valid: false, network: null };
    return {
      address: a,
      valid: true,
      expanded,
      network: prefixNetwork(expanded, prefixLength),
      fingerprint: fingerprint(expanded),
    };
  });
  const valid = analysed.filter((a) => a.valid);
  const networks = new Set(valid.map((a) => a.network));
  return {
    addresses: analysed,
    total: analysed.length,
    validCount: valid.length,
    distinctNetworks: networks.size,
    prefix: Number.parseInt(String(prefixLength).replace(/[^0-9]/g, ''), 10),
    bypassPotential: valid.length > 0 && networks.size === valid.length && valid.length > 1,
  };
}

/** Redact an IP address for safe reporting. */
function redactIp(address) {
  if (!address) return null;
  const expanded = expandIpv6(address);
  if (expanded) {
    return `ipv6:${fingerprint(expanded)}`;
  }
  return `ipv4:${fingerprint(address)}`;
}

module.exports = { expandIpv6, prefixNetwork, analyseIpv6Set, redactIp, fingerprint };