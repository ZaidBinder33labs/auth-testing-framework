
'use strict';

/**
 * QA report generator.
 *
 * Runs the real suites with node:test, parses their actual TAP output,
 * and writes every report format from one normalised result.
 *
 * Timestamps are stored in UTC and additional IST display fields are
 * provided for reports that want to show India Standard Time.
 *
 * Usage:
 *   node tools/qa-report/index.js [--out DIR] [--redis] [--http] [--no-run]
 *
 *   --out DIR   output directory (default: reports/auth/latest)
 *   --redis     include the real Redis integration suite
 *   --http      include the real Binder HTTP integration suite
 *   --no-run    only rebuild reports from existing raw output
 *
 * The original test exit code is preserved.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const {
  parse,
} = require('./tap-parser');

const {
  buildSuites,
  summarise,
  verificationCoverage,
  compareWithPrevious,
} = require('./status');

const {
  buildReport,
  renderJson,
  renderJUnit,
  renderMarkdown,
  renderSecuritySummary,
  renderHtml,
} = require('./renderers');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT = path.join(ROOT, 'reports', 'auth', 'latest');

/**
 * Format a timestamp in India Standard Time.
 *
 * Example:
 *   15 Oct 2026, 01:35:01 PM IST
 *
 * This is for display only. Original ISO timestamps remain in UTC.
 */
function formatIST(timestamp) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(new Date(timestamp)) + ' IST';
}

// Suite groups. `required` groups must produce results or the run is BLOCKED.
const GROUPS = {
  unit: [
    'packages',
    'tests/selftest',
    'tests/authentication',
    'tests/session',
    'tests/token',
    'tests/security',
    'tests/tenancy',
    'tests/concurrency',
    'tests/integration',
    'tests/redis',
    'tests/multitenant',
  ],
  redis: ['tests/redis-integration'],
  http: ['tests/http-integration'],
};

function parseArgs(argv) {
  const out = {
    outDir: DEFAULT_OUT,
    groups: ['unit'],
    noRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--out') {
      out.outDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--redis') {
      out.groups.push('redis');
    } else if (arg === '--http') {
      out.groups.push('http');
    } else if (arg === '--no-run') {
      out.noRun = true;
    }
  }

  out.groups = [...new Set(out.groups)];
  return out;
}

function git(args) {
  try {
    const result = spawnSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
    });

    return result.status === 0
      ? String(result.stdout || '').trim()
      : null;
  } catch (_) {
    return null;
  }
}

/** Discover test files under the given relative directories. */
function discover(dirs) {
  const found = [];

  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;

    for (const entry of fs.readdirSync(dir, {
      withFileTypes: true,
    })) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        /\.(test|spec)\.js$/.test(entry.name) &&
        !/\.dev\.(test|spec)\.js$/.test(entry.name)
      ) {
        found.push(fullPath);
      }
    }
  };

  for (const dir of dirs) {
    walk(
      path.isAbsolute(dir)
        ? dir
        : path.join(ROOT, dir),
    );
  }

  return found.sort();
}

/** Run one group and return { tests, warnings, exitCode }. */
function runGroup(name, dirs) {
  const files = discover(dirs);

  if (!files.length) {
    return {
      tests: [],
      warnings: [
        `GROUP_NOT_CONFIGURED: group '${name}' matched no test files (${dirs.join(', ')})`,
      ],
      exitCode: 0,
      discovered: 0,
    };
  }

  const tests = [];
  const warnings = [];
  let exitCode = 0;

  for (const file of files) {
    const relativeFile = path
      .relative(ROOT, file)
      .replace(/\\/g, '/');

    const result = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', file],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: process.env,
      },
    );

    const stdout = String(result.stdout || '');
    const stderr = String(result.stderr || '');

    const parsed = parse(stdout, {
      currentFile: relativeFile,
    });

    tests.push(...parsed.tests);

    warnings.push(
      ...parsed.warnings.map(
        (warning) => `${relativeFile}: ${warning}`,
      ),
    );

    const fileExit = result.status === null
      ? 1
      : result.status;

    if (fileExit !== 0) {
      exitCode = 1;

      if (
        parsed.tests.filter(
          (test) => test.status === 'failed',
        ).length === 0
      ) {
        const detail = (stderr || stdout)
          .split('\n')
          .filter((line) => /error/i.test(line))
          .slice(0, 3)
          .join(' | ');

        warnings.push(
          `UNPARSED_FAILURE: ${relativeFile} exited ${fileExit} but no failure was parsed` +
          (detail ? `: ${detail}` : ''),
        );
      }
    }
  }

  return {
    tests,
    warnings,
    exitCode,
    discovered: files.length,
  };
}

function collectPrerequisites(groups) {
  const prerequisites = {};

  prerequisites['redis-integration'] = groups.includes('redis')
    ? (
      process.env.REDIS_URL || process.env.REDIS_HOST
        ? 'configured'
        : 'BLOCKED: no REDIS_URL or REDIS_HOST configured'
    )
    : 'not requested for this run';

  prerequisites['binder-http-integration'] = groups.includes('http')
    ? (
      process.env.BINDER_TENANTS
        ? 'configured'
        : 'BLOCKED: BINDER_TENANTS not configured'
    )
    : 'not requested for this run';

  return prerequisites;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  const startedAt = new Date();

  // Keep the run ID format stable for existing consumers.
  const runId =
    `qa-${startedAt.toISOString().replace(/[:.]/g, '-')}-` +
    `${crypto.randomBytes(3).toString('hex')}`;

  const rawDir = path.join(args.outDir, 'raw');

  fs.mkdirSync(rawDir, {
    recursive: true,
  });

  let tests = [];
  const warnings = [];
  let worstExit = 0;

  if (!args.noRun) {
    for (const group of args.groups) {
      const result = runGroup(
        group,
        GROUPS[group] || [],
      );

      warnings.push(...result.warnings);

      // Keep raw runner output separate from sanitized artifacts.
      fs.writeFileSync(
        path.join(rawDir, `${group}.tap`),
        `[exit ${result.exitCode}]\n`,
        'utf8',
      );

      if (result.exitCode !== 0) {
        worstExit = 1;
      }

      tests.push(...result.tests);
    }
  } else {
    const previousResults = path.join(
      args.outDir,
      'results.json',
    );

    if (fs.existsSync(previousResults)) {
      const previous = JSON.parse(
        fs.readFileSync(previousResults, 'utf8'),
      );

      tests = previous.tests || [];
    } else {
      warnings.push(
        'NO_PREVIOUS_RUN: --no-run was used but no previous results.json exists',
      );
    }
  }

  const suites = buildSuites(tests);

  // Attach each suite's tests back for rendering.
  const testsBySuite = new Map();

  for (const test of tests) {
    if (!testsBySuite.has(test.suiteId)) {
      testsBySuite.set(test.suiteId, []);
    }

    testsBySuite.get(test.suiteId).push(test);
  }

  const suitesForReport = suites.map((suite) => {
    const suiteTests = testsBySuite.get(suite.id) || [];

    return {
      ...suite,
      tests: suiteTests,
      totalDurationMs: suiteTests.reduce(
        (sum, test) => sum + (test.durationMs || 0),
        0,
      ),
    };
  });

  const GROUP_VERIFICATION = {
    unit: 'unit',
    redis: 'redis',
    http: 'http',
  };

  const requestedLevels = [
    ...new Set(
      args.groups
        .map((group) => GROUP_VERIFICATION[group])
        .filter(Boolean),
    ),
  ];

  const summary = summarise(
    tests,
    suites,
    warnings,
    { requestedLevels },
  );

  const coverage = verificationCoverage(suites);
  const prerequisites = collectPrerequisites(args.groups);

  const finishedAt = new Date();

  const run = {
    runId,

    // Preserve UTC ISO timestamps for machine-readable data/history.
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),

    // Human-readable India time for report renderers.
    startedAtIST: formatIST(startedAt),
    finishedAtIST: formatIST(finishedAt),

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

  const previousReportPath = path.join(
    path.dirname(args.outDir),
    'previous',
    'results.json',
  );

  if (fs.existsSync(previousReportPath)) {
    try {
      comparison = compareWithPrevious(
        {
          run,
          totals: summary.totals,
          suites: suitesForReport,
        },
        JSON.parse(
          fs.readFileSync(previousReportPath, 'utf8'),
        ),
      );
    } catch (_) {
      comparison = null;
    }
  }

  const report = buildReport({
    run,
    tests,
    suites: suitesForReport,
    summary,
    warnings,
    coverage,
    comparison,
    prereqs: prerequisites,
  });

  fs.mkdirSync(args.outDir, {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(args.outDir, 'results.json'),
    renderJson(report),
    'utf8',
  );

  fs.writeFileSync(
    path.join(args.outDir, 'junit.xml'),
    renderJUnit(report),
    'utf8',
  );

  fs.writeFileSync(
    path.join(args.outDir, 'summary.md'),
    renderMarkdown(report),
    'utf8',
  );

  fs.writeFileSync(
    path.join(args.outDir, 'security-summary.json'),
    renderSecuritySummary(report),
    'utf8',
  );

  fs.writeFileSync(
    path.join(args.outDir, 'index.html'),
    renderHtml(report),
    'utf8',
  );

  process.stdout.write(
    `\nQA report written to ${args.outDir}\n`,
  );

  process.stdout.write(
    `  overall status : ${report.status}\n`,
  );

  process.stdout.write(
    `  totals         : ${JSON.stringify(report.totals)}\n`,
  );

  process.stdout.write(
    `  started (IST)  : ${run.startedAtIST}\n`,
  );

  process.stdout.write(
    `  finished (IST) : ${run.finishedAtIST}\n`,
  );

  process.stdout.write(
    '  artifacts      : index.html results.json junit.xml summary.md security-summary.json\n',
  );

  if (report.status !== 'PASS') {
    process.stdout.write(
      `  reasons        :\n${report.reasons.map((reason) => `    - ${reason}`).join('\n')}\n`,
    );
  }

  // Reports are generated even when tests fail.
  // Preserve the original test/report exit semantics.
  if (worstExit !== 0) return worstExit;
  if (report.status === 'FAIL') return 1;
  if (report.status === 'BLOCKED') return 2;

  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  main,
  parseArgs,
  discover,
  GROUPS,
  formatIST,
};
