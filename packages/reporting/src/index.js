'use strict';
// Reporting: evidence capture, redaction-safe serialization, and result aggregation.
const { redact, assertRedacted } = require('@atf/token-security');

const RESULT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNVERIFIED: 'UNVERIFIED',
  SKIPPED: 'SKIPPED',
});

class Evidence {
  constructor(scenarioId, opts = {}) {
    this.scenarioId = scenarioId;
    this.testRunId = opts.testRunId || null;
    this.tenant = opts.tenant || null;
    this.actor = opts.actor || null;
    this.action = opts.action || null;
    this.httpResult = opts.httpResult || null;
    this.beforeSummary = null;
    this.afterSummary = null;
    this.redisDiff = null;
    this.ttlDiff = null;
    this.securityAssertions = [];
    this.tenantIsolationResult = null;
    this.invariants = [];
    this.status = null;
    this.notes = [];
    this.timestamp = new Date().toISOString();
  }

  setBefore(snapshot) {
    this.beforeSummary = summarize(snapshot);
  }

  setAfter(snapshot) {
    this.afterSummary = summarize(snapshot);
  }

  setRedisDiff(diff) {
    this.redisDiff = diff;
  }

  setTtlDiff(diff) {
    this.ttlDiff = diff;
  }

  addSecurityAssertion(a) {
    this.securityAssertions.push(a);
  }

  addInvariant(inv) {
    this.invariants.push(inv);
  }

  setStatus(status) {
    if (!Object.values(RESULT).includes(status)) throw new Error(`unknown result: ${status}`);
    this.status = status;
  }

  addNote(note) {
    this.notes.push(note);
  }

  serialize() {
    const out = {
      scenarioId: this.scenarioId,
      testRunId: this.testRunId,
      tenant: this.tenant,
      actor: this.actor,
      action: this.action,
      httpResult: this.httpResult,
      beforeSummary: this.beforeSummary,
      afterSummary: this.afterSummary,
      redisDiff: this.redisDiff,
      ttlDiff: this.ttlDiff,
      securityAssertions: this.securityAssertions,
      tenantIsolationResult: this.tenantIsolationResult,
      invariants: this.invariants,
      status: this.status,
      notes: this.notes,
      timestamp: this.timestamp,
    };
    assertRedacted(out, `evidence:${this.scenarioId}`);
    return redact(out);
  }
}

function summarize(snapshot) {
  if (!snapshot) return { keyCount: 0, keys: [] };
  const keys = Object.keys(snapshot);
  return {
    keyCount: keys.length,
    keys: keys.slice(0, 50),
    truncated: keys.length > 50,
    types: Object.fromEntries(keys.slice(0, 50).map((k) => [k, snapshot[k].type])),
  };
}

class Reporter {
  constructor(opts = {}) {
    this.results = [];
    this.opts = opts;
  }

  add(evidence) {
    this.results.push(evidence);
  }

  summary() {
    const counts = { [RESULT.PASS]: 0, [RESULT.FAIL]: 0, [RESULT.UNVERIFIED]: 0, [RESULT.SKIPPED]: 0 };
    for (const r of this.results) {
      counts[r.status] = (counts[r.status] || 0) + 1;
    }
    return { total: this.results.length, ...counts };
  }

  serialize() {
    return this.results.map((r) => r.serialize());
  }

  write(filePath) {
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.serialize(), null, 2));
    return filePath;
  }
}

module.exports = { Evidence, Reporter, RESULT, summarize };