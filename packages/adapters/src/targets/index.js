'use strict';
// Target adapters, opt-in.
//
// This is the only entry point to a target adapter. Loading it is a deliberate act:
// `require('@atf/adapters')` deliberately does not, so a consumer that only needs the contracts
// and the mocks never links an application's adapter.
//
// ONE CLASS, MANY TARGETS. `CredentialAuthAdapter` describes a shape — single-step credential
// login, one refresh, one logout, one identity read — and every endpoint path and field name comes
// from a target descriptor. What a target is, therefore, is the descriptor it is bound to, not the
// class. `targets.binder` is that class bound to config/targets/binder.json; `targets.example` is
// the same class bound to config/targets/example.json. Adding an application adds a descriptor, and
// this entry point picks it up from config/targets/ without a line of code changing.

const { CredentialAuthAdapter, CredentialAuthError, generateSessionId, readExpiresIn, resolveTarget } = require('../credential-auth');
const { listTargets, loadTarget } = require('@atf/target-config');

/** Names of the configured targets, read from config/targets/. */
function configuredTargets() {
  return listTargets();
}

/**
 * The class bound to one target: `new targets.binder.CredentialAuthAdapter({...})` behaves exactly
 * like the unbound class with `targetName: 'binder'`. An explicit target in the options still wins.
 */
function bindTo(targetName) {
  return class extends CredentialAuthAdapter {
    constructor(opts = {}) {
      super({ ...opts, targetName: opts.targetName || targetName });
    }

    /** The descriptor this class is bound to. */
    static get targetName() {
      return targetName;
    }

    /** The descriptor itself, loaded on demand. */
    static loadTarget() {
      return loadTarget(targetName);
    }
  };
}

const bound = new Map();

const namespaces = {};
for (const name of configuredTargets()) {
  Object.defineProperty(namespaces, name, {
    enumerable: true,
    get() {
      // Cached: two reads of targets.binder must yield the same class, or `instanceof` would
      // depend on how the consumer happened to import it.
      if (!bound.has(name)) {
        const Adapter = bindTo(name);
        Object.defineProperty(Adapter, 'name', { value: 'CredentialAuthAdapter' });
        bound.set(name, {
          CredentialAuthAdapter: Adapter,
          CredentialAuthError,
          generateSessionId,
          readExpiresIn,
          targetName: name,
        });
      }
      return bound.get(name);
    },
  });
}

module.exports = {
  // The unbound class, for descriptor-driven use where the caller chooses the target.
  CredentialAuthAdapter,
  CredentialAuthError,
  generateSessionId,
  readExpiresIn,
  resolveTarget,
  configuredTargets,
  bindTo,
  ...namespaces,
};