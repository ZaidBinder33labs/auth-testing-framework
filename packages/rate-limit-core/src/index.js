'use strict';
// Rate-limit testing core: config, key generation, assertions, IPv6, evidence, adapter.
const config = require('./config');
const { KeyGenerator, buildKey, normalizeIpv6, normalizeIpv4, normalizeIp, fingerprint, SCOPE_TYPES } = require('./key-generator');
const { ipv6Expand, ipv6PrefixNetwork, analyseIpv6Set, redactIp } = require('./ipv6');
const {
  RESULT,
  evaluateThreshold,
  evaluateUserIsolation,
  evaluateOfficeCeiling,
  evaluateIpv6Bypass,
  evaluateAtomicity,
} = require('./assertions');
const { RateLimitEvidence } = require('./evidence');
const {
  RateLimitAdapterContract,
  assertRateLimitAdapter,
  MockRateLimitAdapter,
  createMockRateLimitAdapter,
} = require('./adapter');

function createKeyGenerator(cfg, discovery = {}) {
  return new KeyGenerator(cfg || config.load(), discovery);
}

module.exports = {
  config,
  SCOPE_TYPES,
  KeyGenerator,
  createKeyGenerator,
  buildKey,
  normalizeIpv6,
  normalizeIpv4,
  normalizeIp,
  ipv6Expand,
  ipv6PrefixNetwork,
  analyseIpv6Set,
  redactIp,
  RESULT,
  evaluateThreshold,
  evaluateUserIsolation,
  evaluateOfficeCeiling,
  evaluateIpv6Bypass,
  evaluateAtomicity,
  RateLimitEvidence,
  RateLimitAdapterContract,
  assertRateLimitAdapter,
  MockRateLimitAdapter,
  createMockRateLimitAdapter,
};