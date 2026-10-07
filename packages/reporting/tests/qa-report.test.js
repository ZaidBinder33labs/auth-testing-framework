'use strict';
/**
 * Report generator tests.
 *
 * The reports are the artefact people trust when a run goes wrong, so they are tested like
 * any other production code: totals must agree, blocked verification must never read as a
 * pass, secrets must never survive redaction, and untrusted test names must not become markup.
 *
 * These tests run as part of the normal suite (tools/run-tests.js packages and
 * tools/qa-report/index.js both discover this directory).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { parse } = require('../../../tools/qa-report/tap-parser');
const { buildSuites, summarise, compareWithPrevious } = require('../../../tools/qa-report/status');
const { buildReport, renderJson, renderJUnit, renderMarkdown, renderSecuritySummary, renderHtml } = require('../../../tools/qa-report/renderers');
const { redactString, redactValue, escapeHtml } = require('../../../tools/qa-report/redact');

const GENERATOR = path.join(__dirname, '..', '..', '..', 'tools', 'qa-report', 'index.js');

/** Build a complete report from synthetic TAP, exactly as the CLI does. */
function reportFrom(tap, { currentFile = 'tests/multitenant/sample.spec.js', warnings = [] } = {}) {
  const { tests, warnings: parseWarnings } = parse(tap, { currentFile });
  const allWarnings = [...warnings, ...parseWarnings];
  const aggregated = buildSuites(tests);
  const bySuite = new Map();
  for (const t of tests) {
    if (!bySuite.has(t.suiteId)) bySuite.set(t.suiteId, []);
    bySuite.get(t.suiteId).push(t);
  }
  const suites = aggregated.map((s) => ({ ...s, tests: bySuite.get(s.id) || [] }));
  const summary = summarise(tests, aggregated, allWarnings);
  return {
    report: buildReport({
      run: {
        runId: 'qa-test-run', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:10.000Z',
        durationMs: 10000, commit: 'abc123', branch: 'test', environment: 'local', ciRunId: null,
        node: process.version, groups: ['unit'],
      },
      tests, suites, summary, warnings: allWarnings, coverage: {}, prereqs: {},
    }),
    tests,
    warnings: allWarnings,
  };
}

const MIXED_TAP = `TAP version 13
# Subtest: a passing test
ok 1 - a passing test
  ---
  duration_ms: 1.5
  ...
# Subtest: a failing test
not ok 2 - a failing test
  ---
  duration_ms: 2.5
  error: |-
    Expected values to be strictly equal:
    1 !== 2
  code: 'ERR_ASSERTION'
  ...
# Subtest: a deliberately skipped test
ok 3 - a deliberately skipped test # SKIP TODO later
  ---
  duration_ms: 0.5
  ...
# Subtest: a blocked test
ok 4 - a blocked test # SKIP BLOCKED: Redis integration target unreachable
  ---
  duration_ms: 0.5
  ...
1..4
# tests 4
# pass 3
# fail 1
`;

// ---------------------------------------------------------------------------------------------
// RPT-01  All formats agree on totals
// ---------------------------------------------------------------------------------------------

test('RPT-01 all report formats report identical totals', () => {
  const { report } = reportFrom(MIXED_TAP);
  const t = report.totals;

  const json = JSON.parse(renderJson(report));
  assert.strictEqual(json.totals.total, t.total);
  assert.strictEqual(json.totals.passed, t.passed);
  assert.strictEqual(json.totals.failed, t.failed);

  const junit = renderJUnit(report);
  const header = /testsuites name="binder-auth" tests="(\d+)" failures="(\d+)" skipped="(\d+)"/.exec(junit);
  assert.ok(header, 'JUnit must carry a totals header');
  assert.strictEqual(Number(header[1]), t.total);
  assert.strictEqual(Number(header[2]), t.failed);
  assert.strictEqual(Number(header[3]), t.skipped + t.blocked + t.notRun);
  // One <testcase> per test, so element count and total cannot drift apart.
  assert.strictEqual((junit.match(/<testcase /g) || []).length, t.total);

  const md = renderMarkdown(report);
  assert.ok(md.includes(`| Total tests | ${t.total} |`));
  assert.ok(md.includes(`| Passed | ${t.passed} |`));
  assert.ok(md.includes(`| Failed | ${t.failed} |`));

  const html = renderHtml(report);
  assert.strictEqual((html.match(/data-status="/g) || []).length, t.total);
  assert.ok(html.includes(`<div class="n">${t.total}</div>`));
});

// ---------------------------------------------------------------------------------------------
// RPT-02  Statuses are represented correctly and distinctly
// ---------------------------------------------------------------------------------------------

test('RPT-02 pass, fail, skip and blocked are represented distinctly', () => {
  const { report, tests } = reportFrom(MIXED_TAP);
  const byName = Object.fromEntries(tests.map((t) => [t.name, t.status]));

  assert.strictEqual(byName['a passing test'], 'passed');
  assert.strictEqual(byName['a failing test'], 'failed');
  assert.strictEqual(byName['a deliberately skipped test'], 'skipped', 'a TODO is skipped, not blocked');
  assert.strictEqual(byName['a blocked test'], 'blocked', 'an unavailable prerequisite is blocked');

  assert.strictEqual(report.totals.passed, 1);
  assert.strictEqual(report.totals.failed, 1);
  assert.strictEqual(report.totals.skipped, 1);
  assert.strictEqual(report.totals.blocked, 1);

  // The distinction must survive into every format.
  const junit = renderJUnit(report);
  assert.strictEqual((junit.match(/<skipped /g) || []).length, 2);
  assert.ok(junit.includes('BLOCKED: Redis integration target unreachable'));
  assert.ok(renderMarkdown(report).includes('## Blocked verification'));
  assert.ok(renderHtml(report).includes('<h2>Blocked verification</h2>'));
  assert.ok(renderHtml(report).includes('never counted as a pass'));
});

test('RPT-02b failure details stay useful in the report', () => {
  const { report } = reportFrom(MIXED_TAP);
  const failure = report.tests.find((t) => t.status === 'failed');

  assert.ok(failure.failureMessage.includes('Expected values to be strictly equal'));
  assert.strictEqual(failure.code, 'ERR_ASSERTION');
  assert.ok(renderMarkdown(report).includes('## Failures'));
  assert.ok(renderJUnit(report).includes('ERR_ASSERTION'));
});

// ---------------------------------------------------------------------------------------------
// RPT-03 / RPT-04  Missing suites and empty runs are never a clean pass
// ---------------------------------------------------------------------------------------------

test('RPT-03 a required suite that did not run is never reported as passing', () => {
  const { report } = reportFrom(MIXED_TAP);
  // The file used maps to a required suite; with a failure it cannot be 'passed'.
  const suite = report.suites.find((s) => s.id === 'multitenant-auth');
  assert.ok(suite);
  assert.notStrictEqual(suite.status, 'passed');
  assert.strictEqual(report.status, 'FAIL');
});

test('RPT-03b a required suite present but entirely blocked yields BLOCKED, not PASS', () => {
  const blockedOnly = `TAP version 13
# Subtest: redis check
ok 1 - redis check # SKIP BLOCKED: Redis integration target unreachable
  ---
  duration_ms: 0.2
  ...
`;
  const { report } = reportFrom(blockedOnly, { currentFile: 'tests/redis-integration/redis-integration.spec.js' });
  assert.strictEqual(report.totals.blocked, 1);
  assert.strictEqual(report.totals.passed, 0);
  assert.strictEqual(report.status, 'BLOCKED');
  assert.ok(report.reasons.some((r) => /did not pass|produced no executable result/.test(r)));
});

test('RPT-04 an empty run is never treated as successful verification', () => {
  const { report, warnings } = reportFrom('');
  assert.strictEqual(report.totals.total, 0);
  assert.strictEqual(report.status, 'BLOCKED');
  assert.ok(report.reasons.some((r) => /NO_TESTS/.test(r)));
  assert.ok(warnings.some((w) => /EMPTY_RUN/.test(w)));
});

// ---------------------------------------------------------------------------------------------
// RPT-05 / RPT-07  Redaction
// ---------------------------------------------------------------------------------------------

test('RPT-05 secret-like values are redacted from report output', () => {
  const secrets = ['sup3r-secret-password'];
  const samples = [
    'connecting with password=sup3r-secret-password',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.0123456789.abcdefghijklmnop',
    '{"password":"sup3r-secret-password"}',
    'redis://admin:hunter2hunter2@redis.internal:6379/0',
    'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ];

  for (const sample of samples) {
    const out = redactString(sample, secrets);
    assert.ok(!out.includes('sup3r-secret-password'), `password survived redaction: ${out}`);
    assert.ok(!out.includes('hunter2hunter2'), `redis credential survived: ${out}`);
    assert.ok(!/Bearer\s+[A-Za-z0-9._-]{20,}/.test(out), `bearer token survived: ${out}`);
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), `JWT survived: ${out}`);
  }
});

test('RPT-05b secrets are removed from every generated artifact', () => {
  const secret = 'top-secret-value-1234';
  const tap = `TAP version 13
# Subtest: login failure for tenant
not ok 1 - login failure for tenant
  ---
  duration_ms: 1
  error: |-
    request failed with password=${secret}
  ...
`;
  const { report } = reportFrom(tap);
  const outputs = [renderJson(report), renderJUnit(report), renderMarkdown(report), renderHtml(report), renderSecuritySummary(report)];

  for (const out of outputs) {
    assert.ok(!out.includes(secret), 'a secret reached a generated artifact');
  }
});

test('RPT-07 redactValue walks nested structures without losing shape', () => {
  const input = {
    tenant: 'ten_a',
    nested: { list: ['password=abc12345', { deep: 'Bearer aaaaaaaaaaaaaaaa' }] },
    keep: 42,
    flag: true,
    nothing: null,
  };
  const out = redactValue(input, []);

  assert.strictEqual(out.keep, 42);
  assert.strictEqual(out.flag, true);
  assert.strictEqual(out.nothing, null);
  assert.strictEqual(out.tenant, 'ten_a');
  assert.ok(!out.nested.list[0].includes('abc12345'));
  assert.ok(!out.nested.list[1].deep.includes('Bearer aaaaaaaaaaaaaaaa'));
});

test('RPT-07b circular structures do not crash the redactor', () => {
  const node = { name: 'root' };
  node.self = node;
  const out = redactValue(node, []);
  assert.strictEqual(out.name, 'root');
  assert.strictEqual(out.self, '[CIRCULAR]');
});

// ---------------------------------------------------------------------------------------------
// RPT-06  Malformed runner output
// ---------------------------------------------------------------------------------------------

test('RPT-06 malformed runner output is surfaced, not silently accepted', () => {
  const garbage = 'this is not TAP output at all\njust some text\n';
  const { report, warnings } = reportFrom(garbage);

  assert.ok(warnings.some((w) => /MALFORMED_OUTPUT|UNPARSED_LINE/.test(w)), 'malformed output must raise a warning');
  assert.notStrictEqual(report.status, 'PASS');
});

test('RPT-06b a TAP stream truncated mid-diagnostics still yields a result', () => {
  const truncated = `TAP version 13
# Subtest: incomplete test
not ok 1 - incomplete test
  ---
  duration_ms: 1
  error: |-
    half a messa
`;
  const { tests } = reportFrom(truncated);
  assert.strictEqual(tests.length, 1);
  assert.strictEqual(tests[0].status, 'failed');
});

// ---------------------------------------------------------------------------------------------
// RPT-08  HTML escaping
// ---------------------------------------------------------------------------------------------

test('RPT-08 HTML escapes untrusted test content', () => {
  const xss = '<script>alert("xss")</script>';
  const tap = `TAP version 13
# Subtest: ${xss}
not ok 1 - ${xss}
  ---
  duration_ms: 1
  error: |-
    ${xss}
  ...
`;
  const html = renderHtml(reportFrom(tap).report);

  assert.ok(!html.includes('<script>alert'), 'raw script tag must not survive into the HTML');
  assert.ok(html.includes('&lt;script&gt;'), 'the name must be present in escaped form');
  assert.ok(escapeHtml(xss).includes('&lt;script&gt;'));
});

test('RPT-08b XML output escapes untrusted content', () => {
  const NUL = String.fromCharCode(0);
  const VT = String.fromCharCode(11);
  const tap = `TAP version 13
# Subtest: a & b <c>${NUL}${VT}
not ok 1 - a & b <c>${NUL}${VT}
  ---
  duration_ms: 1
  error: |-
    x < y && z > w
  ...
`;
  const junit = renderJUnit(reportFrom(tap).report);

  assert.ok(junit.includes('a &amp; b &lt;c&gt;'));
  assert.ok(!/<testcase[^>]*name="a & b/.test(junit));
  // Control characters are illegal in XML and must be stripped.
  const controlChars = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
    `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
    `${String.fromCharCode(14)}-${String.fromCharCode(31)}]`
  );
  assert.ok(!controlChars.test(junit), 'control characters must not survive into XML');
});

// ---------------------------------------------------------------------------------------------
// RPT-09  Offline dashboard
// ---------------------------------------------------------------------------------------------

test('RPT-09 the dashboard loads no remote assets', () => {
  const html = renderHtml(reportFrom(MIXED_TAP).report);

  assert.ok(!/(?:src|href)\s*=\s*["']https?:/i.test(html), 'no remote src/href is allowed');
  assert.ok(!/@import\s+url/i.test(html), 'no remote CSS import is allowed');
  assert.ok(!/<link\b/i.test(html), 'no external stylesheet link is allowed');
  // Interaction is inline so the page works from a file:// URL.
  assert.ok(html.includes('<style>'));
  assert.ok(html.includes('function apply()'));
});

// ---------------------------------------------------------------------------------------------
// RPT-10  Reports survive a failing run, and the exit code is not masked
// ---------------------------------------------------------------------------------------------

test('RPT-10 every artifact is produced even when tests failed', () => {
  const { report } = reportFrom(MIXED_TAP);
  assert.strictEqual(report.status, 'FAIL');

  for (const [name, out] of Object.entries({
    json: renderJson(report),
    junit: renderJUnit(report),
    markdown: renderMarkdown(report),
    html: renderHtml(report),
    security: renderSecuritySummary(report),
  })) {
    assert.ok(out && out.length > 0, `${name} artifact must not be empty on failure`);
  }
});

test('RPT-10b the generator exits non-zero when verification is blocked', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-report-blocked-'));
  try {
    // --no-run with no prior results must not be presented as success.
    const r = spawnSync(process.execPath, [GENERATOR, '--out', outDir, '--no-run'], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..', '..', '..'),
    });
    assert.notStrictEqual(r.status, 0, 'a blocked run must not exit 0');
    assert.strictEqual(r.status, 2, 'BLOCKED is reported with exit code 2');
    // Artifacts are still written so the failure is inspectable.
    for (const f of ['index.html', 'results.json', 'junit.xml', 'summary.md', 'security-summary.json']) {
      assert.ok(fs.existsSync(path.join(outDir, f)), `${f} must exist even for a blocked run`);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// RPT-11  History
// ---------------------------------------------------------------------------------------------

test('RPT-11 no comparison is invented when no previous report exists', () => {
  assert.strictEqual(compareWithPrevious({ run: { runId: 'x' }, totals: { total: 1 } }, null), null);
  assert.strictEqual(compareWithPrevious({ run: { runId: 'x' }, totals: { total: 1 } }, {}), null);
  assert.strictEqual(compareWithPrevious({ run: { runId: 'x' }, totals: { total: 1 } }, { nonsense: true }), null);

  const { report } = reportFrom(MIXED_TAP);
  assert.ok(renderMarkdown(report).includes('No comparison available.'));
  assert.ok(renderHtml(report).includes('No comparison available.'));
});

test('RPT-11b a real previous report produces newly failing and resolved tests', () => {
  const previous = {
    runId: 'qa-previous',
    finishedAt: '2025-12-31T00:00:00.000Z',
    status: 'FAIL',
    durationMs: 9000,
    totals: { total: 4, passed: 2, failed: 2 },
    suites: [{
      id: 'multitenant-auth',
      tests: [
        { name: 'a passing test', status: 'failed' },
        { name: 'a failing test', status: 'failed' },
        { name: 'old removed test', status: 'passed' },
      ],
    }],
  };
  const current = {
    run: { runId: 'qa-current' }, durationMs: 11000,
    totals: { total: 4 },
    suites: [{ id: 'multitenant-auth', tests: [{ name: 'a passing test', status: 'passed' }, { name: 'a failing test', status: 'failed' }] }],
  };

  const diff = compareWithPrevious(current, previous);
  assert.ok(diff);
  assert.strictEqual(diff.previousRunId, 'qa-previous');
  assert.deepStrictEqual(diff.resolved, ['a passing test']);
  assert.strictEqual(diff.durationDeltaMs, 2000);
  assert.strictEqual(diff.totalDelta, 0);
});

// ---------------------------------------------------------------------------------------------
// RPT-12  Verification labelling honesty
// ---------------------------------------------------------------------------------------------

test('RPT-12 fixture verification is never labelled as real backend proof', () => {
  const { report } = reportFrom(MIXED_TAP, { currentFile: 'tests/multitenant/sample.spec.js' });
  const suite = report.suites.find((s) => s.id === 'multitenant-auth');

  assert.strictEqual(suite.verification, 'fixture');

  const security = JSON.parse(renderSecuritySummary(report));
  assert.strictEqual(security.isolationChecks.level, 'fixture');
  assert.ok(/does not prove real backend tenant isolation/i.test(security.isolationChecks.note));
  assert.ok(renderMarkdown(report).includes('not** proof of real backend tenant isolation'));
  assert.ok(renderHtml(report).includes('not proof of real backend tenant isolation'));
});

test('RPT-12b the security summary lists findings with a documented status', () => {
  const security = JSON.parse(renderSecuritySummary(reportFrom(MIXED_TAP).report));

  assert.ok(security.findings.length >= 4);
  for (const f of security.findings) {
    assert.ok(f.id, 'every finding needs an id');
    assert.ok(['confirmed', 'unresolved', 'not-verified'].includes(f.status), `unexpected status ${f.status}`);
    assert.ok(f.severity, 'every finding needs a severity');
    assert.ok(f.evidence, 'every finding needs evidence');
  }
  assert.ok(security.limitations.some((l) => /JWT claim decoding is not signature verification/.test(l)));
});

// ---------------------------------------------------------------------------------------------
// RPT-13  Suite registry
// ---------------------------------------------------------------------------------------------

test('RPT-13 every suite declares a verification level and required flag', () => {
  const { allSuites, suiteFor } = require('../../../tools/qa-report/suites');
  const valid = new Set(['unit', 'fixture', 'redis', 'http', 'reporting']);

  for (const s of allSuites()) {
    assert.ok(valid.has(s.verification), `suite ${s.id} has an unknown verification level`);
    assert.strictEqual(typeof s.required, 'boolean');
    assert.ok(s.name);
  }
  assert.strictEqual(suiteFor('packages/adapters/tests/binder-auth.test.js').verification, 'unit');
  assert.strictEqual(suiteFor('tests/redis-integration/redis-integration.spec.js').verification, 'redis');
  assert.strictEqual(suiteFor('tests/http-integration/http.spec.js').verification, 'http');
  assert.strictEqual(suiteFor('some/unknown/file.test.js').id, 'other');
});

// ---------------------------------------------------------------------------------------------
// RPT-14  Report generator participates in the normal suite
// ---------------------------------------------------------------------------------------------

test('RPT-15 requested-but-blocked verification is never a clean PASS', () => {
  const unitPass = `TAP version 13
# Subtest: a unit test that passes
ok 1 - a unit test that passes
  ---
  duration_ms: 1
  ...
`;
  const blockedHttp = `TAP version 13
# Subtest: http login check
ok 1 - http login check # SKIP BLOCKED: real Binder HTTP tests need explicit tenant configuration
  ---
  duration_ms: 0.2
  ...
`;
  const redisPass = `TAP version 13
# Subtest: a redis integration test that passes
ok 1 - a redis integration test that passes
  ---
  duration_ms: 1
  ...
`;
  const tests = [
    ...parse(unitPass, { currentFile: 'packages/auth-core/tests/auth-core.test.js' }).tests,
    ...parse(redisPass, { currentFile: 'tests/redis-integration/redis-integration.spec.js' }).tests,
    ...parse(blockedHttp, { currentFile: 'tests/http-integration/http-integration.spec.js' }).tests,
  ];
  const aggregated = buildSuites(tests);

  // When the caller asked for HTTP verification, blocked results must surface.
  const requested = summarise(tests, aggregated, [], { requestedLevels: ['unit', 'http'] });
  assert.strictEqual(requested.status, 'BLOCKED');
  assert.ok(requested.reasons.some((r) => /requested verification level 'http' is blocked/.test(r)));

  // When it was not requested, a machine without tenants can still reach PASS on what it did run,
  // while the blocked result remains visible in the totals.
  const notRequested = summarise(tests, aggregated, [], { requestedLevels: ['unit'] });
  assert.strictEqual(notRequested.status, 'PASS');
  assert.strictEqual(notRequested.totals.blocked, 1, 'the blocked result is still counted');
});

test('RPT-15b a failure outranks a blocked level', () => {
  const mixed = `TAP version 13
# Subtest: unit failure
not ok 1 - unit failure
  ---
  duration_ms: 1
  error: |-
    boom
  ...
# Subtest: blocked check
ok 2 - blocked check # SKIP BLOCKED: prerequisite unavailable
  ---
  duration_ms: 0.2
  ...
`;
  const parsed = parse(mixed, { currentFile: 'tests/multitenant/mixed.spec.js' });
  const aggregated = buildSuites(parsed.tests);
  const summary = summarise(parsed.tests, aggregated, [], { requestedLevels: ['http'] });

  assert.strictEqual(summary.status, 'FAIL', 'a real failure must not be softened to BLOCKED');
  assert.ok(summary.reasons.some((r) => /failed/.test(r)));
});

test('RPT-16 the generator is runnable as a module and exposes a CLI entry point', () => {
  const generator = require('../../../tools/qa-report/index.js');
  assert.strictEqual(typeof generator.main, 'function');
  assert.ok(fs.existsSync(GENERATOR));
  assert.ok(generator.GROUPS.unit.includes('packages'), 'packages must be part of the default run');
  assert.ok(generator.GROUPS.redis.includes('tests/redis-integration'));
});