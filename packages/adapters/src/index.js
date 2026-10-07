'use strict';
// Pluggable adapters: auth, tenant, api, browser, and mock adapters.
// Adapters translate between the framework's abstract model and a concrete target application.
// A real adapter (e.g. CredentialAuthAdapter) implements these contracts; mock adapters are used
// for self-tests and contract verification.
//
// Requiring this module loads contracts and mocks only. Target adapters are opt-in through
// `@atf/adapters/targets`, so `require('@atf/adapters')` never pulls in one application's
// endpoints, transports or dependencies. A framework that serves many applications must not
// make every consumer depend on all of them.
const { MockAuthAdapter, createMockAuthAdapter } = require('./mock-auth');
const { MockTenantAdapter, createMockTenantAdapter } = require('./mock-tenant');
const { MockRedisAdapter, createMockRedisAdapter } = require('./mock-redis');

class AuthAdapterContract extends Error {
  constructor(method) { super(`adapter must implement ${method}()`); this.name = 'AuthAdapterContract'; }
}

class RedisAdapterContract extends Error {
  constructor(method) { super(`redis adapter must implement ${method}()`); this.name = 'RedisAdapterContract'; }
}

class TenantAdapterContract extends Error {
  constructor(method) { super(`tenant adapter must implement ${method}()`); this.name = 'TenantAdapterContract'; }
}

/** Verify an object satisfies the AuthAdapter contract. */
function assertAuthAdapter(adapter, label = 'adapter') {
  for (const fn of ['login', 'logout', 'refresh', 'getSessionState']) {
    if (typeof adapter[fn] !== 'function') throw new AuthAdapterContract(`${label}.${fn}`);
  }
  return true;
}

/**
 * Verify an adapter can answer effective-access questions.
 * Optional capability: adapters that cannot (e.g. the mock) are not contract violations.
 */
function assertEffectiveAccessAdapter(adapter, label = 'adapter') {
  if (typeof adapter.getEffectiveAccess !== 'function') {
    throw new AuthAdapterContract(`${label}.getEffectiveAccess`);
  }
  return true;
}

/** True when the adapter supports effective-access lookups. */
function supportsEffectiveAccess(adapter) {
  return !!adapter && typeof adapter.getEffectiveAccess === 'function';
}

/** Verify an object satisfies the RedisAdapter contract. */
function assertRedisAdapter(adapter, label = 'adapter') {
  for (const fn of ['inspect', 'snapshot', 'discoverKeys']) {
    if (typeof adapter[fn] !== 'function') throw new RedisAdapterContract(`${label}.${fn}`);
  }
  return true;
}

/** Verify an object satisfies the TenantAdapter contract. */
function assertTenantAdapter(adapter, label = 'adapter') {
  for (const fn of ['getTenant', 'getActor', 'listTenants']) {
    if (typeof adapter[fn] !== 'function') throw new TenantAdapterContract(`${label}.${fn}`);
  }
  return true;
}

module.exports = {
  AuthAdapterContract,
  RedisAdapterContract,
  TenantAdapterContract,
  assertAuthAdapter,
  assertEffectiveAccessAdapter,
  supportsEffectiveAccess,
  assertRedisAdapter,
  assertTenantAdapter,
  MockAuthAdapter,
  createMockAuthAdapter,
  MockTenantAdapter,
  createMockTenantAdapter,
  MockRedisAdapter,
  createMockRedisAdapter,
};

/**
 * Target adapters, opt-in.
 *
 * `require('@atf/adapters/targets')` is the only way to reach a concrete application adapter.
 * Kept as a getter so the main entry point cannot accidentally require one.
 */
Object.defineProperty(module.exports, 'targets', {
  enumerable: true,
  get() {
    return require('./targets');
  },
});
