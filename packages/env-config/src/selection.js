'use strict';
/**
 * Run-time selection: TARGET=<target> ENV=<environment>.
 *
 * Resolves the pair into everything a run needs — target descriptor, environment descriptor,
 * policy — and applies the guardrails that hold regardless of policy. An unknown target or
 * environment is a coded error naming what was not found and listing what is available; there is
 * no silent fallback to a default, because a suite that quietly ran against the wrong environment
 * would report a result about a system nobody asked about.
 */

const { loadTarget, listTargets, TargetConfigError } = require('@atf/target-config');
const {
  EnvConfigError,
  loadEnvironment,
  listEnvironments,
  loadPolicy,
  listPolicies,
  resolveRedisMode,
  assertProductionConsent,
  readAccount,
  describeEnvironment,
} = require('@atf/env-config');

/** A run with no explicit selection: fixtures and mocks, no backend. */
const DEFAULT_ENVIRONMENT = null;

function resolveSelection(env = process.env, { applyGuardrails = true } = {}) {
  const targetName = env.TARGET && String(env.TARGET).trim() ? String(env.TARGET).trim() : 'binder';
  const envName = env.ENV && String(env.ENV).trim() ? String(env.ENV).trim() : null;

  if (!listTargets().includes(targetName)) {
    throw new TargetConfigError(`unknown target '${targetName}'; available targets: ${listTargets().join(', ')}`, {
      code: 'TARGET_NOT_FOUND', field: 'TARGET', target: targetName,
    });
  }

  // No environment selected: fixtures and mocks only. This is not an error and is not a default
  // environment; it is the absence of one, and the report says so.
  if (!envName) {
    return Object.freeze({
      target: loadTarget(targetName),
      targetName,
      environment: null,
      environmentName: null,
      policy: null,
      redisMode: null,
      account: null,
      guarded: false,
    });
  }

  if (!listEnvironments().includes(envName)) {
    throw new EnvConfigError(`unknown environment '${envName}'; available environments: ${listEnvironments().join(', ')}`, {
      code: 'ENVIRONMENT_NOT_FOUND', field: 'ENV', environment: envName,
    });
  }

  const environment = loadEnvironment(envName);

  if (!listPolicies().includes(environment.policy)) {
    throw new EnvConfigError(`environment '${envName}' names policy '${environment.policy}', which does not exist; available policies: ${listPolicies().join(', ')}`, {
      code: 'POLICY_NOT_FOUND', field: 'policy', environment: envName,
    });
  }
  const policy = loadPolicy(environment.policy);

  // The environment names a target; it must be the one actually selected, or the run would mix
  // one application's contract with another's host.
  if (environment.target !== targetName) {
    throw new EnvConfigError(`environment '${envName}' is configured for target '${environment.target}', but TARGET=${targetName} was selected`, {
      code: 'TARGET_ENVIRONMENT_MISMATCH', field: 'TARGET', environment: envName,
    });
  }

  if (applyGuardrails) {
    assertProductionConsent(environment, env);
  }
  const redisMode = resolveRedisMode(environment, env);
  const account = readAccount(environment, env);

  return Object.freeze({
    target: loadTarget(targetName),
    targetName,
    environment,
    environmentName: envName,
    policy,
    redisMode,
    account,
    guarded: applyGuardrails,
  });
}

/** True when a capability is granted by the active policy. No policy means nothing is granted. */
function allows(policy, capability) {
  if (!policy) return false;
  return policy.capabilities[capability] === true;
}

/** The capability denied for a set of requirements, or null when all are granted. */
function firstDenied(policy, required) {
  for (const cap of required || []) {
    if (!allows(policy, cap)) return cap;
  }
  return null;
}

module.exports = {
  resolveSelection,
  allows,
  firstDenied,
  describeEnvironment,
  DEFAULT_ENVIRONMENT,
};