'use strict';
/**
 * Result aggregation and overall status rules.
 *
 * Status vocabulary:
 *   passed  - the test executed and its assertions held
 *   failed  - the test executed and failed
 *   skipped - deliberately not executed (TODO, opt-in)
 *   blocked - could not execute because a prerequisite is missing (Redis, credentials, tenant)
 *   not-run - the suite was expected but produced no result at all
 *
 * Overall status:
 *   FAIL    - any failed test, or a parse problem that could hide results
 *   BLOCKED - no failures, but a required verification level did not execute
 *   PASS    - everything required ran and passed
 *
 * A run with zero tests is never PASS. Blocked required verification is never PASS.
 */

const REQUIRED_VERIFICATIONS = ['unit', 'redis'];

function emptyCounts() {
  return { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0, notRun: 0 };
}

/** Group normalised tests into suites. */
function buildSuites(tests) {
  const bySuite = new Map();
  for (const t of tests) {
    if (!bySuite.has(t.suiteId)) {
      bySuite.set(t.suiteId, {
        id: t.suiteId,
        name: t.suiteName,
        category: t.category,
        verification: t.verification,
        required: t.required,
        files: new Set(),
        tests: [],
        counts: emptyCounts(),
      });
    }
    const suite = bySuite.get(t.suiteId);
    if (t.file) suite.files.add(t.file);
    suite.tests.push(t);
  }

  for (const suite of bySuite.values()) {
    for (const t of suite.tests) {
      suite.counts.total += 1;
      suite.counts[t.status] += 1;
    }
    suite.files = [...suite.files];
    suite.status = suiteStatus(suite);
    delete suite.tests;
  }

  return [...bySuite.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function suiteStatus(suite) {
  if (suite.counts.failed > 0) return 'failed';
  if (suite.counts.blocked > 0) return 'blocked';
  if (suite.counts.total === 0) return 'not-run';
  if (suite.counts.passed === 0) return 'blocked';
  return 'passed';
}

/**
 * Compute totals and the overall verdict.
 * @param {Object[]} tests normalised tests
 * @param {Object[]} suites suites from buildSuites()
 * @param {string[]} warnings parser warnings
 * @param {Object} [opts]
 * @param {string[]} [opts.requestedLevels] verification levels this run explicitly asked for.
 *   Blocked results inside a requested level mean the run is BLOCKED, never PASS — otherwise
 *   asking for real verification and silently not getting it would look like success.
 */
function summarise(tests, suites, warnings = [], opts = {}) {
  const requestedLevels = opts.requestedLevels || [];
  const totals = emptyCounts();
  for (const t of tests) {
    totals.total += 1;
    totals[t.status] += 1;
  }

  const reasons = [];
  let status = 'PASS';

  if (totals.total === 0) {
    status = 'BLOCKED';
    reasons.push('NO_TESTS: the run produced no test results, which is never a pass');
  }
  if (totals.failed > 0) {
    status = 'FAIL';
    reasons.push(`${totals.failed} test(s) failed`);
  }

  // Verification the caller explicitly requested but could not complete.
  for (const level of requestedLevels) {
    const blockedHere = tests.filter((t) => t.verification === level && t.status === 'blocked');
    if (blockedHere.length) {
      if (status !== 'FAIL') status = 'BLOCKED';
      reasons.push(`requested verification level '${level}' is blocked: ${blockedHere.length} test(s) could not execute`);
    }
  }

  // Required verification that did not execute.
  const unmet = suites.filter((s) => s.required && s.status !== 'passed');
  for (const s of unmet) {
    if (status !== 'FAIL') status = 'BLOCKED';
    reasons.push(`required suite '${s.name}' did not pass (status: ${s.status})`);
  }

  // Required verification *levels* that produced no executable result at all.
  for (const level of REQUIRED_VERIFICATIONS) {
    const levelSuites = suites.filter((s) => s.verification === level);
    const executed = levelSuites.some((s) => s.counts.total > 0);
    if (!executed) {
      if (status === 'PASS') status = 'BLOCKED';
      reasons.push(`verification level '${level}' produced no executable result`);
    }
  }

  for (const w of warnings) {
    if (/UNPARSED_LINE|MALFORMED_OUTPUT/.test(w)) {
      if (status === 'PASS') status = 'FAIL';
      reasons.push(`runner output could not be fully parsed: ${w}`);
    }
  }

  return {
    status,
    reasons,
    totals,
    executedSuites: suites.filter((s) => s.counts.total > 0).length,
    configuredSuites: suites.length,
  };
}

/** Levels actually exercised by this run, for honest reporting. */
function verificationCoverage(suites) {
  const coverage = {};
  for (const s of suites) {
    const entry = coverage[s.verification] || { suites: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, notRun: 0 };
    entry.suites += 1;
    entry[s.status] += 1;
    coverage[s.verification] = entry;
  }
  return coverage;
}

/**
 * Compare with a previous run.
 * Returns null when no compatible previous report exists — history is never fabricated.
 */
function compareWithPrevious(current, previous) {
  if (!previous || typeof previous !== 'object') return null;
  if (!previous.runId || !previous.totals) return null;

  const prevTests = new Map();
  for (const s of previous.suites || []) {
    for (const t of s.tests || []) prevTests.set(`${s.id}::${t.name}`, t.status);
  }
  const curTests = new Map();
  for (const s of current.suites || []) {
    for (const t of s.tests || []) curTests.set(`${s.id}::${t.name}`, t.status);
  }

  const newlyFailing = [];
  const resolved = [];
  for (const [key, status] of curTests) {
    const before = prevTests.get(key);
    if (before && before !== 'failed' && status === 'failed') newlyFailing.push(key.split('::')[1]);
  }
  for (const [key, before] of prevTests) {
    const now = curTests.get(key);
    if (before === 'failed' && now && now !== 'failed') resolved.push(key.split('::')[1]);
  }

  return {
    previousRunId: previous.runId,
    previousFinishedAt: previous.finishedAt || null,
    previousStatus: previous.status || null,
    totalDelta: current.totals.total - (previous.totals.total || 0),
    durationDeltaMs: typeof current.durationMs === 'number' && typeof previous.durationMs === 'number'
      ? current.durationMs - previous.durationMs
      : null,
    newlyFailing,
    resolved,
  };
}

module.exports = {
  buildSuites,
  summarise,
  suiteStatus,
  verificationCoverage,
  compareWithPrevious,
  emptyCounts,
  REQUIRED_VERIFICATIONS,
};