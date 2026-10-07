'use strict';
// BEFORE/AFTER scenario engine.
// prepare context -> capture BEFORE -> execute action -> wait for expected state
// -> capture AFTER -> calculate diff -> run assertions -> generate evidence.
const { diffSnapshots } = require('@atf/state-diff');
const { Evidence, RESULT } = require('@atf/reporting');
const { validateNoCrossTenantContamination } = require('@atf/isolation-engine');

class ScenarioError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'ScenarioError';
    this.code = code || 'SCENARIO_ERROR';
  }
}

async function runScenario(opts = {}) {
  const {
    scenarioId,
    testRunId,
    tenant,
    actor,
    action,
    before: captureBefore,
    action: doAction,
    after: captureAfter,
    waitForExpected,
    assertions = [],
    redisAdapter,
    otherTenants = [],
    timeout = 10000,
  } = opts;

  if (!redisAdapter) throw new ScenarioError('redisAdapter is required', { code: 'NO_REDIS_ADAPTER' });
  if (typeof doAction !== 'function') throw new ScenarioError('action must be a function', { code: 'NO_ACTION' });

  const evidence = new Evidence(scenarioId, { testRunId, tenant, actor, action });
  evidence.action = action;

  // 1. Capture BEFORE
  const beforeSnapshot = captureBefore ? await captureBefore() : await redisAdapter.snapshot();
  evidence.setBefore(beforeSnapshot);

  // 2. Execute action
  let actionResult;
  try {
    actionResult = await doAction();
  } catch (err) {
    evidence.addNote(`action threw: ${err.message}`);
    evidence.setStatus(RESULT.FAIL);
    return evidence;
  }

  // 3. Wait for expected state
  if (waitForExpected) {
    try {
      await waitForExpected({ redis: redisAdapter, result: actionResult, before: beforeSnapshot });
    } catch (err) {
      evidence.addNote(`waitForExpected failed: ${err.message}`);
      evidence.setStatus(RESULT.UNVERIFIED);
      // Continue to capture AFTER so we still have diff evidence.
    }
  }

  // 4. Capture AFTER
  const afterSnapshot = captureAfter ? await captureAfter() : await redisAdapter.snapshot();
  evidence.setAfter(afterSnapshot);

  // 5. Diff
  const diff = diffSnapshots(beforeSnapshot, afterSnapshot);
  evidence.setRedisDiff({
    added: diff.added,
    removed: diff.removed,
    modified: diff.modified,
    unchanged: diff.unchanged,
    ttlChanged: diff.ttlChanged,
    typeChanged: diff.typeChanged,
    tenantChanged: diff.tenantChanged,
    sessionChanged: diff.sessionChanged,
  });

  // 6. Assertions
  let assertionFailures = 0;
  for (const assertion of assertions) {
    try {
      const r = await assertion({ before: beforeSnapshot, after: afterSnapshot, diff, result: actionResult, redis: redisAdapter });
      if (r && r.ok === false) {
        evidence.addSecurityAssertion({ name: assertion.name || 'anonymous', ok: false, detail: r.detail || null });
        assertionFailures += 1;
      } else {
        evidence.addSecurityAssertion({ name: assertion.name || 'anonymous', ok: true, detail: r && r.detail ? r.detail : null });
      }
    } catch (err) {
      evidence.addSecurityAssertion({ name: assertion.name || 'anonymous', ok: false, error: err.message });
      assertionFailures += 1;
    }
  }

  // 7. Tenant isolation
  if (otherTenants.length && tenant) {
    const iso = validateNoCrossTenantContamination(beforeSnapshot, afterSnapshot, tenant.id, { tenants: [tenant.id, ...otherTenants] });
    evidence.tenantIsolationResult = iso;
  }

  // 8. Final status
  if (assertionFailures > 0) {
    evidence.setStatus(RESULT.FAIL);
  } else if (evidence.status !== RESULT.UNVERIFIED) {
    evidence.setStatus(RESULT.PASS);
  }

  return evidence;
}

module.exports = { runScenario, ScenarioError };