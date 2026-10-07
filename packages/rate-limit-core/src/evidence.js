'use strict';
// Rate-limit evidence: safe, redaction-consistent reporting.
const { redact, assertRedacted } = require('@atf/token-security');

class RateLimitEvidence {
  constructor(testId, opts = {}) {
    this.testId = testId;
    this.service = opts.service || null;
    this.environment = opts.environment || null;
    this.tenant = opts.tenant || null;
    this.actor = opts.actor || null;
    this.scope = opts.scope || null;
    this.configuredLimit = opts.configuredLimit || null;
    this.observedLimit = opts.observedLimit || null;
    this.requestCount = opts.requestCount || 0;
    this.httpStatus = opts.httpStatus || null;
    this.redisObservation = opts.redisObservation || null;
    this.ttl = opts.ttl || null;
    this.result = opts.result || null;
    this.evidence = opts.evidence || null;
    this.notes = [];
    this.timestamp = new Date().toISOString();
  }

  addNote(note) { this.notes.push(note); }

  serialize() {
    const out = {
      testId: this.testId,
      service: this.service,
      environment: this.environment,
      tenant: this.tenant,
      actor: this.actor,
      scope: this.scope,
      configuredLimit: this.configuredLimit,
      observedLimit: this.observedLimit,
      requestCount: this.requestCount,
      httpStatus: this.httpStatus,
      redisObservation: this.redisObservation,
      ttl: this.ttl,
      result: this.result,
      evidence: this.evidence,
      notes: this.notes,
      timestamp: this.timestamp,
    };
    assertRedacted(out, `rate-limit:${this.testId}`);
    return redact(out);
  }
}

module.exports = { RateLimitEvidence };