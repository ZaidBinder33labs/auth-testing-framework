'use strict';
/**
 * TAP parser for node:test output.
 *
 * node:test emits nested subtests as indented TAP. This parser keeps the nesting so a test's
 * suite is the file that declared it, and so a file-level load failure is reported as one
 * failed entry instead of silently disappearing.
 *
 * Anything it cannot understand is reported through `parse.warnings` rather than dropped, so a
 * malformed run is visible in the report instead of producing a smaller, greener total.
 */

const { suiteFor } = require('./suites');

const RESULT_RE = /^(not ok|ok)\s+(\d+)\s*-\s?(.*)$/;
const DIRECTIVE_RE = /\s#\s(SKIP|TODO)\s*(.*)$/;

function parseDuration(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Split a TAP name into its bare name and skip/todo directive. */
function splitDirective(raw) {
  const m = DIRECTIVE_RE.exec(raw);
  if (!m) return { name: raw.trim(), directive: null, directiveReason: null };
  return { name: raw.replace(DIRECTIVE_RE, '').trim(), directive: m[1], directiveReason: (m[2] || '').trim() || null };
}

/**
 * Parse the YAML-ish diagnostic block node:test writes between `---` and `...`.
 * Values may be scalars or `|-` block scalars.
 */
function parseDiagnostics(lines) {
  const out = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];
    if (rest === '|-' || rest === '|' || rest === '>-') {
      const block = [];
      let j = i + 1;
      const indentOf = line.match(/^\s*/)[0].length + 2;
      while (j < lines.length) {
        const candidate = lines[j];
        const indent = candidate.match(/^\s*/)[0].length;
        if (candidate.trim() !== '' && indent < indentOf) break;
        block.push(candidate.slice(indentOf));
        j += 1;
      }
      out[key] = block.join('\n');
      i = j - 1;
    } else {
      out[key] = rest.trim().replace(/^'(.*)'$/, '$1');
    }
  }
  return out;
}

/**
 * @param {string} tap raw TAP text
 * @param {Object} [opts]
 * @param {string} [opts.currentFile] file the output belongs to (used when the runner does not name it)
 * @returns {{tests: Object[], warnings: string[], summary: Object}}
 */
function parse(tap, opts = {}) {
  const text = String(tap || '');
  const lines = text.split(/\r?\n/);
  const warnings = [];

  if (text.trim() === '') {
    return { tests: [], warnings: ['EMPTY_RUN: the runner produced no output'], summary: {} };
  }
  if (!/^TAP version/m.test(lines.find((l) => l.trim() !== '') || '')) {
    warnings.push('MALFORMED_OUTPUT: no TAP version header found');
  }

  const tests = [];
  const summary = {};
  let currentFile = opts.currentFile || null;
  const fileIsAuthoritative = !!opts.currentFile;
  let pending = null;      // test awaiting its diagnostics
  let inDiagnostics = false;
  let diagLines = [];
  let diagIndent = 0;

  const indentOf = (l) => l.match(/^\s*/)[0].length;

  const flush = () => {
    if (!pending) return;
    const diagnostics = parseDiagnostics(diagLines);
    pending.durationMs = parseDuration(diagnostics.duration_ms);
    if (diagnostics.error) pending.failureMessage = diagnostics.error;
    if (diagnostics.code) pending.code = diagnostics.code;
    if (diagnostics.stack) pending.stack = diagnostics.stack;
    if (diagnostics.expected !== undefined) pending.expected = diagnostics.expected;
    if (diagnostics.actual !== undefined) pending.actual = diagnostics.actual;
    if (diagnostics.location) pending.location = diagnostics.location;
    tests.push(pending);
    pending = null;
    diagLines = [];
    inDiagnostics = false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;

    // Summary comments emitted by node:test.
    const sum = /^#\s(tests|pass|fail|skipped|todo|cancelled|suites)\s+(\d+)\s*$/.exec(line.trim());
    if (sum) {
      summary[sum[1]] = Number.parseInt(sum[2], 10);
      continue;
    }

    // A file-level header: node:test re-emits "TAP version 13" per file when nesting.
    if (/^\s*TAP version/.test(line)) continue;

    const subtest = /^(\s*)#\sSubtest:\s?(.*)$/.exec(line);
    if (subtest) {
      flush();
      // When the caller already knows which file produced this output (per-file runs), that
      // file is authoritative: `# Subtest:` carries the test name, not the file name.
      if (!fileIsAuthoritative) currentFile = subtest[2].trim();
      continue;
    }

    const diagStart = /^(\s*)---\s*$/.exec(line);
    if (diagStart) {
      inDiagnostics = true;
      diagIndent = diagStart[1].length;
      continue;
    }
    if (inDiagnostics && /^\s*\.\.\.\s*$/.test(line)) {
      flush();
      continue;
    }
    if (inDiagnostics) {
      diagLines.push(line);
      continue;
    }

    const result = RESULT_RE.exec(line);
    if (result) {
      flush();
      const [, verdict, , rawName] = result;
      const { name, directive, directiveReason } = splitDirective(rawName);
      const indent = indentOf(line);
      const isFileLevel = indent === 0;

      pending = {
        verdict,
        name,
        directive,
        directiveReason,
        file: currentFile,
        isFileLevel,
        durationMs: null,
        failureMessage: null,
        stack: null,
      };
      continue;
    }

    // A plan line ends the stream.
    if (/^\s*1\.\./.test(line)) {
      flush();
      continue;
    }

    if (/^\s*#/.test(line)) continue;           // informational comment
    if (inDiagnostics) continue;
    if (/^\s*[A-Za-z]/.test(line) && !line.startsWith('#')) {
      warnings.push(`UNPARSED_LINE: ${line.slice(0, 120)}`);
    }
  }
  flush();

  const normalised = tests.map((t) => normalise(t));
  return { tests: normalised, warnings, summary };
}

/** Map a raw TAP entry onto the normalised result model. */
function normalise(t) {
  const suite = suiteFor(t.file);
  let status;

  if (t.verdict === 'not ok') {
    status = 'failed';
  } else if (t.directive === 'SKIP') {
    // A skip whose reason says infrastructure is unavailable is BLOCKED, not merely skipped.
    const reason = t.directiveReason || '';
    status = /blocked|unavailable|not configured|missing prerequisite/i.test(reason) ? 'blocked' : 'skipped';
  } else if (t.directive === 'TODO') {
    status = 'skipped';
  } else {
    status = 'passed';
  }

  return {
    id: t.name,
    name: t.name,
    suiteId: suite.id,
    suiteName: suite.name,
    category: suite.category,
    verification: suite.verification,
    required: suite.required,
    file: t.file || null,
    status,
    durationMs: t.durationMs,
    failureMessage: t.failureMessage || null,
    code: t.code || null,
    stack: t.stack || null,
    expected: t.expected === undefined ? null : t.expected,
    actual: t.actual === undefined ? null : t.actual,
    skipReason: t.directive === 'SKIP' ? (t.directiveReason || 'skipped without a stated reason') : null,
    location: t.location || null,
    isFileLevel: !!t.isFileLevel,
  };
}

module.exports = { parse, normalise };