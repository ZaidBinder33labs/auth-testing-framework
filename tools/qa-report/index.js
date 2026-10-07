'use strict';
/**
 * QA report generator.
 *
 * Runs the real suites with node:test, parses their actual TAP output, and writes every report
 * format from one normalised result so totals cannot disagree.
 *
 * Usage:
 *   node tools/qa-report/index.js [--out DIR] [--redis] [--http] [--no-run]
 *
 *   --out DIR   output directory (default: reports/auth/latest)
 *   --redis     include the real Redis integration suite
 *   --http      include the real Binder HTTP integration suite (requires configured tenants)
 *   --no-run    only rebuild reports from existing raw output
 *
 * The original test exit code is preserved: the report generator never turns a failing run
 * into a successful command.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const { parse } = require('./tap-parser');
const { buildSuites, summarise, verificationCoverage, compareWithPrevious } = require('./status');
const { buildReport, renderJson, renderJUnit, renderMarkdown, renderSecuritySummary, renderHtml } = require('./renderers');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT = path.join(ROOT, 'reports', 'auth', 'latest');

// Suite groups. `required` groups must produce results or the run is BLOCKED.
const GROUPS = {
  unit: ['packages', 'tests/selftest', 'tests/authentication', 'tests/session', 'tests/token', 'tests/security', 'tests/tenancy', 'tests/concurrency', 'tests/integration', 'tests/redis', 'tests/multitenant'],
  redis: ['tests/redis-integration'],
  http: ['tests/http-integration'],
};

function parseArgs(argv) {
  const out = { outDir: DEFAULT_OUT, groups: ['unit'], noRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') { out.outDir = path.resolve(argv[i + 1]); i += 1; }
    else if (a === '--redis') out.groups.push('redis');
    else if (a === '--http') out.groups.push('http');
    else if (a === '--no-run') out.noRun = true;
  }
  out.groups = [...new Set(out.groups)];
  return out;
}

function git(args) {
  try {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout || '').trim() : null;
  } catch (_) {
    return null;
  }
}

/** Discover test files under the given relative directories. */
function discover(dirs) {
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(test|spec)\.js$/.test(entry.name) && !/\.dev\.(test|spec)\.js$/.test(entry.name)) found.push(full);
    }
  };
  for (const d of dirs) walk(path.isAbsolute(d) ? d : path.join(ROOT, d));
  return found.sort();
}

/** Run one group and return { tests, warnings, exitCode }. */
function runGroup(name, dirs) {
  const files = discover(dirs);
  if (!files.length) {
    return {
      tests: [],
      warnings: [`GROUP_NOT_CONFIGURED: group '${name}' matched no test files (${dirs.join(', ')})`],
      exitCode: 0,
      discovered: 0,
    };
  }
  // Each file runs in its own `node --test` process. Node's TAP stream reports leaf subtests
  // without repeating the file name, so attributing results to suites requires knowing which
  // file produced them; per-file execution makes that unambiguous and also captures a file
  // that fails to load as a single failed entry instead of losing it.
  const tests = [];
  const warnings = [];
  let exitCode = 0;

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    });
    const stdout = String(r.stdout || '');
    const stderr = String(r.stderr || '');
    const parsed = parse(stdout, { currentFile: rel });
    tests.push(...parsed.tests);
    warnings.push(...parsed.warnings.map((w) => `${rel}: ${w}`));

    const fileExit = r.status === null ? 1 : r.status;
    if (fileExit !== 0) {
      exitCode = 1;
      // A non-zero exit with no parsed failure means output we could not read; surface it.
      if (parsed.tests.filter((t) => t.status === 'failed').length === 0) {
        const detail = (stderr || stdout).split('\n').filter((l) => /error/i.test(l)).slice(0, 3).join(' | ');
        warnings.push(`UNPARSED_FAILURE: ${rel} exited ${fileExit} but no failure was parsed${detail ? `: ${detail}` : ''}`);
      }
    }
  }

  return { tests, warnings, exitCode, discovered: files.length };
}

function collectPrerequisites(groups) {
  const prereqs = {};
  prereqs['redis-integration'] = groups.includes('redis')
    ? (process.env.REDIS_URL || process.env.REDIS_HOST ? 'configured' : 'BLOCKED: no REDIS_URL or REDIS_HOST configured')
    : 'not requested for this run';
  prereqs['binder-http-integration'] = groups.includes('http')
    ? (process.env.BINDER_TENANTS ? 'configured' : 'BLOCKED: BINDER_TENANTS not configured')
    : 'not requested for this run';
  return prereqs;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const startedAt = new Date();
  const runId = `qa-${startedAt.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;

  const rawDir = path.join(args.outDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });

  let tests = [];
  let warnings = [];
  let worstExit = 0;

  if (!args.noRun) {
    for (const group of args.groups) {
      const result = runGroup(group, GROUPS[group] || []);
      warnings.push(...result.warnings);
      // Raw runner output is kept separate from sanitized artifacts.
      fs.writeFileSync(path.join(rawDir, `${group}.tap`), `[exit ${result.exitCode}]\n`, 'utf8');
      if (result.exitCode !== 0) worstExit = 1;
      tests.push(...result.tests);
    }
  } else {
    const previousRaw = path.join(args.outDir, 'results.json');
    if (fs.existsSync(previousRaw)) {
      const prev = JSON.parse(fs.readFileSync(previousRaw, 'utf8'));
      tests = prev.tests || [];
    } else {
      warnings.push('NO_PREVIOUS_RUN: --no-run was used but no previous results.json exists');
    }
  }

  const suites = buildSuites(tests);
  // Attach each suite's tests back for rendering (buildSuites strips them for aggregation).
  const bySuite = new Map();
  for (const t of tests) {
    if (!bySuite.has(t.suiteId)) bySuite.set(t.suiteId, []);
    bySuite.get(t.suiteId).push(t);
  }
  const suitesForReport = suites.map((s) => ({
    ...s,
    tests: bySuite.get(s.id) || [],
    totalDurationMs: (bySuite.get(s.id) || []).reduce((sum, t) => sum + (t.durationMs || 0), 0),
  }));

  const GROUP_VERIFICATION = { unit: 'unit', redis: 'redis', http: 'http' };

  const requestedLevels = [...new Set(args.groups.map((g) => GROUP_VERIFICATION[g]).filter(Boolean))];
  const summary = summarise(tests, suites, warnings, { requestedLevels });
  const coverage = verificationCoverage(suites);
  const prereqs = collectPrerequisites(args.groups);

  const finishedAt = new Date();
  const run = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    commit: git(['rev-parse', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    environment: process.env.CI ? 'ci' : 'local',
    ciRunId: process.env.GITHUB_RUN_ID || null,
    node: process.version,
    groups: args.groups,
  };

  // History comparison only when a compatible previous report exists.
  let comparison = null;
  const prevPath = path.join(path.dirname(args.outDir), 'previous', 'results.json');
  if (fs.existsSync(prevPath)) {
    try {
      comparison = compareWithPrevious({ run, totals: summary.totals, suites: suitesForReport }, JSON.parse(fs.readFileSync(prevPath, 'utf8')));
    } catch (_) {
      comparison = null;
    }
  }

  const report = buildReport({ run, tests, suites: suitesForReport, summary, warnings, coverage, comparison, prereqs });

  fs.mkdirSync(args.outDir, { recursive: true });
  fs.writeFileSync(path.join(args.outDir, 'results.json'), renderJson(report), 'utf8');
  fs.writeFileSync(path.join(args.outDir, 'junit.xml'), renderJUnit(report), 'utf8');
  fs.writeFileSync(path.join(args.outDir, 'summary.md'), renderMarkdown(report), 'utf8');
  fs.writeFileSync(path.join(args.outDir, 'security-summary.json'), renderSecuritySummary(report), 'utf8');
  fs.writeFileSync(path.join(args.outDir, 'index.html'), renderHtml(report), 'utf8');

  process.stdout.write(`\nQA report written to ${args.outDir}\n`);
  process.stdout.write(`  overall status : ${report.status}\n`);
  process.stdout.write(`  totals         : ${JSON.stringify(report.totals)}\n`);
  process.stdout.write(`  artifacts      : index.html results.json junit.xml summary.md security-summary.json\n`);
  if (report.status !== 'PASS') {
    process.stdout.write(`  reasons        :\n${report.reasons.map((x) => `    - ${x}`).join('\n')}\n`);
  }

  // Reports are generated even when tests failed; the failure is still reported.
  if (worstExit !== 0) return worstExit;
  if (report.status === 'FAIL') return 1;
  if (report.status === 'BLOCKED') return 2;
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, parseArgs, discover, GROUPS };