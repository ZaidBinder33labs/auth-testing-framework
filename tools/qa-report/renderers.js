'use strict';
/**
 * Report renderers.
 *
 * Every renderer consumes the same normalised result object, so totals cannot disagree between
 * formats. All text is escaped for HTML, all values are redacted, and no remote asset is loaded.
 */

const { escapeHtml, redactValue, redactString, tenantAlias } = require('./redact');

/** Assemble the canonical report object every format is derived from. */
function buildReport({ run, tests, suites, summary, warnings = [], coverage = {}, comparison = null, prereqs = {} }) {
  return {
    schema: 'binder-auth-qa-report/1',
    run,
    status: summary.status,
    reasons: summary.reasons,
    totals: summary.totals,
    executedSuites: summary.executedSuites,
    configuredSuites: summary.configuredSuites,
    suites,
    tests,
    verificationCoverage: coverage,
    prereqs,
    comparison,
    warnings,
  };
}

// ----------------------------------------------------------------------------JSON

function renderJson(report) {
  return JSON.stringify(redactValue(report), null, 2);
}

// ------------------------------------------------------------------------ JUnit XML

function xmlEscape(input) {
  if (input === undefined || input === null) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters are illegal in XML 1.0.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function renderJUnit(report) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  // Totals are taken from the same object the other formats use.
  const t = report.totals;
  lines.push(`<testsuites name="binder-auth" tests="${t.total}" failures="${t.failed}" skipped="${t.skipped + t.blocked + t.notRun}">`);

  for (const suite of report.suites) {
    const c = suite.counts;
    lines.push(`  <testsuite name="${xmlEscape(suite.name)}" tests="${c.total}" failures="${c.failed}" skipped="${c.skipped + c.blocked + c.notRun}" time="${((c.totalDurationMs || 0) / 1000).toFixed(3)}">`);
    lines.push('    <properties>');
    lines.push(`      <property name="category" value="${xmlEscape(suite.category)}"/>`);
    lines.push(`      <property name="verification" value="${xmlEscape(suite.verification)}"/>`);
    lines.push('    </properties>');

    for (const test of suite.tests || []) {
      const time = ((test.durationMs || 0) / 1000).toFixed(3);
      lines.push(`    <testcase classname="${xmlEscape(suite.name)}" name="${xmlEscape(test.name)}" time="${time}">`);
      if (test.status === 'failed') {
        const message = redactString(test.failureMessage || 'test failed');
        lines.push(`      <failure message="${xmlEscape(firstLine(message))}" type="${xmlEscape(test.code || 'AssertionError')}">${xmlEscape(message)}</failure>`);
      } else if (test.status === 'blocked') {
        lines.push(`      <skipped message="${xmlEscape(`BLOCKED: ${test.skipReason || 'prerequisite unavailable'}`)}"/>`);
      } else if (test.status === 'skipped') {
        lines.push(`      <skipped message="${xmlEscape(test.skipReason || 'skipped')}"/>`);
      }
      lines.push('    </testcase>');
    }
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>');
  return lines.join('\n');
}

function firstLine(text) {
  return String(text).split('\n')[0];
}

// ----------------------------------------------------------------------- Markdown

function renderMarkdown(report) {
  const r = report;
  const t = r.totals;
  const out = [];

  out.push('# Binder Auth QA Report');
  out.push('');
  out.push(`**Overall status: ${r.status}**`);
  if (r.reasons.length) {
    out.push('');
    for (const reason of r.reasons) out.push(`- ${reason}`);
  }
  out.push('');
  out.push('| Metric | Value |');
  out.push('|---|---|');
  out.push(`| Total tests | ${t.total} |`);
  out.push(`| Passed | ${t.passed} |`);
  out.push(`| Failed | ${t.failed} |`);
  out.push(`| Skipped | ${t.skipped} |`);
  out.push(`| Blocked | ${t.blocked} |`);
  out.push(`| Not run | ${t.notRun} |`);
  out.push(`| Suites executed | ${r.executedSuites} of ${r.configuredSuites} |`);
  out.push(`| Run ID | \`${r.run.runId}\` |`);
  out.push(`| Started | ${r.run.startedAtIST || r.run.startedAt} |`);
  out.push(`| Finished | ${r.run.finishedAtIST || r.run.finishedAt} |`);
  out.push(`| Duration | ${r.run.durationMs} ms |`);
  out.push(`| Commit | ${r.run.commit || 'unknown'} |`);
  out.push(`| Branch | ${r.run.branch || 'unknown'} |`);
  out.push(`| Environment | ${r.run.environment} |`);
  out.push('');

  out.push('## Verification coverage');
  out.push('');
  out.push('| Level | Suites | Passed | Failed | Blocked |');
  out.push('|---|---|---|---|---|');
  for (const [level, c] of Object.entries(r.verificationCoverage || {})) {
    out.push(`| ${level} | ${c.suites} | ${c.passed} | ${c.failed} | ${c.blocked} |`);
  }
  out.push('');
  out.push('Mock/fixture coverage is **not** proof of real backend tenant isolation.');
  out.push('');

  out.push('## Suites');
  out.push('');
  out.push('| Suite | Category | Verification | Status | Tests | Passed | Failed | Blocked |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const s of r.suites) {
    out.push(`| ${s.name} | ${s.category} | ${s.verification} | ${s.status} | ${s.counts.total} | ${s.counts.passed} | ${s.counts.failed} | ${s.counts.blocked} |`);
  }
  out.push('');

  const failures = r.tests.filter((x) => x.status === 'failed');
  if (failures.length) {
    out.push('## Failures');
    out.push('');
    for (const f of failures) {
      out.push(`- **${f.name}** (${f.suiteName})`);
      const msg = redactString(f.failureMessage || 'no message');
      for (const line of msg.split('\n').slice(0, 6)) out.push(`  - ${line}`);
    }
    out.push('');
  }

  const blocked = r.tests.filter((x) => x.status === 'blocked');
  if (blocked.length) {
    out.push('## Blocked verification');
    out.push('');
    for (const b of blocked.slice(0, 25)) out.push(`- ${b.name}: ${b.skipReason || 'prerequisite unavailable'}`);
    if (blocked.length > 25) out.push(`- ... and ${blocked.length - 25} more`);
    out.push('');
  }

  out.push('## Comparison with previous run');
  out.push('');
  if (!r.comparison) {
    out.push('No comparison available.');
  } else {
    out.push(`- Previous run: \`${r.comparison.previousRunId}\` (${r.comparison.previousStatus})`);
    out.push(`- Test count change: ${r.comparison.totalDelta >= 0 ? '+' : ''}${r.comparison.totalDelta}`);
    if (r.comparison.durationDeltaMs !== null) {
      out.push(`- Duration change: ${r.comparison.durationDeltaMs >= 0 ? '+' : ''}${r.comparison.durationDeltaMs} ms`);
    }
    out.push(`- Newly failing: ${r.comparison.newlyFailing.length ? r.comparison.newlyFailing.join(', ') : 'none'}`);
    out.push(`- Resolved: ${r.comparison.resolved.length ? r.comparison.resolved.join(', ') : 'none'}`);
  }
  out.push('');

  if (r.prereqs && Object.keys(r.prereqs).length) {
    out.push('## Prerequisites for real verification');
    out.push('');
    for (const [k, v] of Object.entries(r.prereqs)) out.push(`- ${k}: ${redactString(String(v))}`);
    out.push('');
  }

  return out.join('\n');
}

// ---------------------------------------------------------------- Security summary

function renderSecuritySummary(report) {
  const byLevel = {};
  for (const s of report.suites) {
    const e = byLevel[s.verification] || { suites: [], passed: 0, failed: 0, blocked: 0, skipped: 0 };
    e.suites.push(s.name);
    e[s.status] += 1;
    byLevel[s.verification] = e;
  }

  const isolationTests = report.tests.filter((t) => /isolation|contaminat|cross-tenant|tenant boundary|SESSION_TENANT/i.test(t.name));
  const securityTests = report.tests.filter((t) => t.category === 'security' || /redact|fingerprint|password|unauthoriz/i.test(t.name));

  const findings = [
    finding('SEC-001', 'medium', 'packages/adapters/src/binder-auth.js', 'auth-adapter',
      'Session fingerprints are SHA-256 digests, not raw token substrings',
      'status', report.tests.some((t) => /fingerprint/i.test(t.name)) ? 'confirmed' : 'not-verified',
      'Evidence: safeToken/safeSession derive from @atf/token-security fingerprint.'),
    finding('SEC-002', 'high', 'tests/redis-integration', 'redis-integration',
      'Real Redis never receives FLUSHDB or FLUSHALL; cleanup is namespace-scoped',
      'status', report.suites.find((s) => s.id === 'redis-integration')?.status === 'passed' ? 'confirmed' : 'not-verified',
      'Evidence: cleanupNamespace uses SCAN with the run prefix; REDIS-14 asserts no flush command is issued.'),
    finding('SEC-003', 'high', 'tests/multitenant', 'multitenant-auth',
      'Tenant session binding cannot be re-pointed at another tenant',
      'status', report.suites.find((s) => s.id === 'multitenant-auth')?.status === 'passed' ? 'confirmed' : 'not-verified',
      'Evidence: TenantSession.assertTenant rejects cross-tenant use and detects an altered binding.'),
    finding('SEC-004', 'info', 'http-integration', 'http-integration',
      'Real backend cross-tenant authorization enforcement',
      'status', 'not-verified',
      'Prerequisite: configured non-production Binder endpoint plus test tenants. Fixture tests do not prove backend enforcement.'),
  ];

  return JSON.stringify(redactValue({
    schema: 'binder-auth-security-summary/1',
    runId: report.run.runId,
    generatedAt: report.run.finishedAt,
    overallStatus: report.status,
    verificationLevels: byLevel,
    isolationChecks: {
      executed: isolationTests.length,
      passed: isolationTests.filter((t) => t.status === 'passed').length,
      failed: isolationTests.filter((t) => t.status === 'failed').length,
      blocked: isolationTests.filter((t) => t.status === 'blocked').length,
      level: report.suites.find((s) => s.id === 'multitenant-auth')?.verification || 'fixture',
      note: 'Fixture-level isolation evidence does not prove real backend tenant isolation.',
    },
    securityTestCoverage: {
      executed: securityTests.length,
      passed: securityTests.filter((t) => t.status === 'passed').length,
      failed: securityTests.filter((t) => t.status === 'failed').length,
    },
    findings,
    limitations: [
      'Mock/fixture suites validate framework logic only.',
      'Real Redis evidence depends on an available Redis instance.',
      'Real Binder HTTP evidence depends on a configured non-production endpoint and test tenants.',
      'JWT claim decoding is not signature verification and is never used as an authorization decision.',
    ],
    prereqs: report.prereqs || {},
  }), null, 2);
}

function finding(id, severity, component, testRef, title, _field, status, evidence) {
  return { id, severity, component, testReference: testRef, title, status, evidence, remediation: severity === 'info' ? 'Provide a non-production endpoint and test tenants to verify.' : 'No action required while confirmed.' };
}

// -------------------------------------------------------------------------- HTML

const STYLES = `
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e9ef;--muted:#9aa4b2;--pass:#2ea043;--fail:#d13b3b;--warn:#d29922;--skip:#6e7681;--block:#8250df;--accent:#4c8dff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:24px 20px 64px}
header{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;margin-bottom:20px}
h1{font-size:20px;margin:0;letter-spacing:.2px}
h2{font-size:15px;margin:28px 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px}
.badge{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:700;font-size:12px;letter-spacing:.5px}
.badge.PASS{background:rgba(46,160,67,.15);color:var(--pass);border:1px solid rgba(46,160,67,.4)}
.badge.FAIL{background:rgba(209,59,59,.15);color:var(--fail);border:1px solid rgba(209,59,59,.4)}
.badge.BLOCKED{background:rgba(130,80,223,.15);color:var(--block);border:1px solid rgba(130,80,223,.4)}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .n{font-size:24px;font-weight:700}
.card .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.6px}
.card.pass .n{color:var(--pass)}.card.fail .n{color:var(--fail)}.card.block .n{color:var(--block)}.card.skip .n{color:var(--skip)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.6px;background:#1b1f28;position:sticky;top:0}
tr:last-child td{border-bottom:none}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
.pill.passed{background:rgba(46,160,67,.15);color:var(--pass)}
.pill.failed{background:rgba(209,59,59,.15);color:var(--fail)}
.pill.blocked{background:rgba(130,80,223,.15);color:var(--block)}
.pill.skipped{background:rgba(110,118,129,.15);color:var(--skip)}
.pill.not-run{background:rgba(110,118,129,.15);color:var(--skip)}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.controls input,.controls select{background:#12151c;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px}
.note{color:var(--muted);font-size:12px;margin:8px 0}
pre{background:#12151c;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;max-height:260px;font-size:12px;white-space:pre-wrap;word-break:break-word}
ul.reasons{margin:8px 0 0;padding-left:18px}
.lvl{font-size:11px;color:var(--muted)}
`;

function renderHtml(report) {
  const r = report;
  const e = escapeHtml;
  const t = r.totals;

  const counts = [
    { l: 'Total', n: t.total, c: '' },
    { l: 'Passed', n: t.passed, c: 'pass' },
    { l: 'Failed', n: t.failed, c: 'fail' },
    { l: 'Blocked', n: t.blocked, c: 'block' },
    { l: 'Skipped', n: t.skipped, c: 'skip' },
    { l: 'Not run', n: t.notRun, c: 'skip' },
  ];

  const rows = r.tests.map((x) => `
      <tr data-status="${e(x.status)}" data-suite="${e(x.suiteId)}" data-category="${e(x.category)}" data-verification="${e(x.verification)}">
        <td>${e(x.name)}</td>
        <td>${e(x.suiteName)}</td>
        <td>${e(x.category)}</td>
        <td class="lvl">${e(x.verification)}</td>
        <td><span class="pill ${e(x.status)}">${e(x.status)}</span></td>
        <td>${x.durationMs === null ? 'â€”' : e(String(x.durationMs)) + ' ms'}</td>
        <td>${x.failureMessage ? `<pre>${e(redactString(x.failureMessage))}</pre>` : x.skipReason ? `<span class="note">${e(redactString(x.skipReason))}</span>` : 'â€”'}</td>
      </tr>`).join('');

  const suiteRows = r.suites.map((s) => `
      <tr><td>${e(s.name)}</td><td>${e(s.category)}</td><td class="lvl">${e(s.verification)}</td>
      <td><span class="pill ${e(s.status)}">${e(s.status)}</span></td>
      <td>${s.counts.total}</td><td>${s.counts.passed}</td><td>${s.counts.failed}</td><td>${s.counts.blocked}</td></tr>`).join('');

  const coverageRows = Object.entries(r.verificationCoverage || {}).map(([level, c]) => `
      <tr><td>${e(level)}</td><td>${c.suites}</td><td>${c.passed}</td><td>${c.failed}</td><td>${c.blocked}</td></tr>`).join('');

  const blockedList = r.tests.filter((x) => x.status === 'blocked');
  const blockedSection = blockedList.length
    ? `<h2>Blocked verification</h2>
<table><thead><tr><th>Test</th><th>Suite</th><th>Reason</th></tr></thead><tbody>${
      blockedList.map((b) => `<tr><td>${e(b.name)}</td><td>${e(b.suiteName)}</td><td>${e(redactString(b.skipReason || 'prerequisite unavailable'))}</td></tr>`).join('')
    }</tbody></table>
<p class="note">Blocked verification did not execute. It is never counted as a pass.</p>`
    : '';

  const comparison = r.comparison
    ? `<p>Previous run <code>${e(r.comparison.previousRunId)}</code> (${e(r.comparison.previousStatus)}).
       Newly failing: ${e(r.comparison.newlyFailing.join(', ') || 'none')}.
       Resolved: ${e(r.comparison.resolved.join(', ') || 'none')}.</p>`
    : '<p class="note">No comparison available.</p>';

  const prereqRows = Object.entries(r.prereqs || {}).map(([k, v]) => `<tr><td>${e(k)}</td><td>${e(redactString(String(v)))}</td></tr>`).join('');

  const reasonList = r.reasons.length
    ? `<ul class="reasons">${r.reasons.map((x) => `<li>${e(redactString(x))}</li>`).join('')}</ul>`
    : '<p class="note">No status reasons.</p>';

  // No remote scripts or stylesheets: the dashboard works fully offline.
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Binder Auth QA Report â€” ${e(r.status)}</title>
<style>${STYLES}</style>
</head><body><div class="wrap">
<header>
  <div>
    <h1>Binder Auth QA Dashboard</h1>
    <p class="note">Run <code>${e(r.run.runId)}</code> Â· ${e(r.run.environment)} Â· ${e(r.run.startedAt)} â†’ ${e(r.run.finishedAt)} Â· ${e(String(r.run.durationMs))} ms Â· commit ${e(r.run.commit || 'unknown')} Â· branch ${e(r.run.branch || 'unknown')}</p>
  </div>
  <div><span class="badge ${e(r.status)}">${e(r.status)}</span></div>
</header>

<div class="grid">${counts.map((c) => `<div class="card ${c.c}"><div class="n">${e(String(c.n))}</div><div class="l">${e(c.l)}</div></div>`).join('')}</div>

<h2>Status reasons</h2>
${reasonList}

<h2>Suite overview</h2>
<table><thead><tr><th>Suite</th><th>Category</th><th>Verification</th><th>Status</th><th>Tests</th><th>Passed</th><th>Failed</th><th>Blocked</th></tr></thead>
<tbody>${suiteRows}</tbody></table>
<p class="note">Mock/fixture suites are labelled and are not proof of real backend tenant isolation.</p>

<h2>Verification coverage</h2>
<table><thead><tr><th>Level</th><th>Suites</th><th>Passed</th><th>Failed</th><th>Blocked</th></tr></thead>
<tbody>${coverageRows}</tbody></table>

<h2>Test results</h2>
<div class="controls">
  <input id="q" type="search" placeholder="Search testsâ€¦" aria-label="Search tests">
  <select id="fstatus" aria-label="Filter by status"><option value="">All statuses</option>${['passed', 'failed', 'blocked', 'skipped', 'not-run'].map((s) => `<option value="${s}">${s}</option>`).join('')}</select>
  <select id="fsuite" aria-label="Filter by suite"><option value="">All suites</option>${r.suites.map((s) => `<option value="${e(s.id)}">${e(s.name)}</option>`).join('')}</select>
  <select id="fver" aria-label="Filter by verification"><option value="">All levels</option>${Object.keys(r.verificationCoverage || {}).map((v) => `<option value="${e(v)}">${e(v)}</option>`).join('')}</select>
</div>
<table id="tests"><thead><tr><th>Test</th><th>Suite</th><th>Category</th><th>Verification</th><th>Status</th><th>Duration</th><th>Detail</th></tr></thead>
<tbody>${rows}</tbody></table>

${blockedSection}

<h2>Comparison with previous run</h2>
${comparison}

<h2>Prerequisites for real verification</h2>
${prereqRows ? `<table><thead><tr><th>Item</th><th>State</th></tr></thead><tbody>${prereqRows}</tbody></table>` : '<p class="note">None recorded.</p>'}

<p class="note">Generated from actual runner output. Secrets are redacted; no remote assets are loaded.</p>
</div>
<script>
(function(){
  var q=document.getElementById('q'), fs=document.getElementById('fstatus'), fu=document.getElementById('fsuite'), fv=document.getElementById('fver');
  var rows=Array.prototype.slice.call(document.querySelectorAll('#tests tbody tr'));
  function apply(){
    var t=(q.value||'').toLowerCase(), s=fs.value, u=fu.value, v=fv.value;
    rows.forEach(function(r){
      var ok=(!t||r.textContent.toLowerCase().indexOf(t)>-1)
        &&(!s||r.dataset.status===s)
        &&(!u||r.dataset.suite===u)
        &&(!v||r.dataset.verification===v);
      r.style.display=ok?'':'none';
    });
  }
  [q,fs,fu,fv].forEach(function(el){el&&el.addEventListener('input',apply);});
})();
</script>
</body></html>`;
}

module.exports = {
  buildReport,
  renderJson,
  renderJUnit,
  renderMarkdown,
  renderSecuritySummary,
  renderHtml,
  tenantAlias,
};
