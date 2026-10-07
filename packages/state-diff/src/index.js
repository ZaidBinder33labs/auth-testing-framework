'use strict';
// Snapshot diff engine for Redis state.
// Classifies every key change between BEFORE and AFTER snapshots.
const crypto = require('crypto');

const CHANGE_TYPES = Object.freeze({ // eslint-disable-line
  ADDED: 'ADDED',
  REMOVED: 'REMOVED',
  MODIFIED: 'MODIFIED',
  UNCHANGED: 'UNCHANGED',
  TTL_CHANGED: 'TTL_CHANGED',
  TYPE_CHANGED: 'TYPE_CHANGED',
  TENANT_CHANGED: 'TENANT_CHANGED',
  SESSION_CHANGED: 'SESSION_CHANGED',
});

function fingerprint(value) {
  if (value === undefined || value === null) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function fingerprintOf(entry) {
  if (!entry) return null;
  if (entry.fingerprint) return entry.fingerprint;
  if (entry.value !== undefined) return fingerprint(entry.value);
  if (entry.fields) return fingerprint(JSON.stringify(entry.fields));
  if (entry.cardinality !== undefined) return fingerprint(String(entry.cardinality));
  return fingerprint(JSON.stringify(entry));
}

function classify(before, after) {
  const b = before || {};
  const a = after || {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const changes = [];
  for (const key of keys) {
    const beforeEntry = b[key];
    const afterEntry = a[key];
    if (!beforeEntry && afterEntry) {
      changes.push({ key, type: CHANGE_TYPES.ADDED, after: afterEntry });
      continue;
    }
    if (beforeEntry && !afterEntry) {
      changes.push({ key, type: CHANGE_TYPES.REMOVED, before: beforeEntry });
      continue;
    }
    if (!beforeEntry || !afterEntry) continue;

    const beforeType = beforeEntry.type;
    const afterType = afterEntry.type;
    if (beforeType && afterType && beforeType !== afterType) {
      changes.push({ key, type: CHANGE_TYPES.TYPE_CHANGED, before: beforeEntry, after: afterEntry });
      continue;
    }

    const beforeFp = fingerprintOf(beforeEntry);
    const afterFp = fingerprintOf(afterEntry);
    if (beforeFp !== afterFp) {
      changes.push({ key, type: CHANGE_TYPES.MODIFIED, before: beforeEntry, after: afterEntry });
      continue;
    }

    const beforeTtl = beforeEntry.ttl;
    const afterTtl = afterEntry.ttl;
    const ttlChanged = (beforeTtl === null || beforeTtl === undefined) !== (afterTtl === null || afterTtl === undefined)
      || (beforeTtl != null && afterTtl != null && beforeTtl !== afterTtl);
    if (ttlChanged) {
      changes.push({ key, type: CHANGE_TYPES.TTL_CHANGED, before: beforeEntry, after: afterEntry });
      continue;
    }

    const beforeTenant = beforeEntry.tenantId;
    const afterTenant = afterEntry.tenantId;
    if (beforeTenant !== afterTenant) {
      changes.push({ key, type: CHANGE_TYPES.TENANT_CHANGED, before: beforeEntry, after: afterEntry });
      continue;
    }

    const beforeSession = beforeEntry.sessionId;
    const afterSession = afterEntry.sessionId;
    if (beforeSession !== afterSession) {
      changes.push({ key, type: CHANGE_TYPES.SESSION_CHANGED, before: beforeEntry, after: afterEntry });
      continue;
    }

    changes.push({ key, type: CHANGE_TYPES.UNCHANGED, before: beforeEntry, after: afterEntry });
  }
  return changes;
}

function diffSnapshots(before, after, opts = {}) {
  const changes = classify(before, after);
  return {
    beforeCount: Object.keys(before || {}).length,
    afterCount: Object.keys(after || {}).length,
    added: changes.filter((c) => c.type === CHANGE_TYPES.ADDED).map((c) => c.key),
    removed: changes.filter((c) => c.type === CHANGE_TYPES.REMOVED).map((c) => c.key),
    modified: changes.filter((c) => c.type === CHANGE_TYPES.MODIFIED).map((c) => c.key),
    unchanged: changes.filter((c) => c.type === CHANGE_TYPES.UNCHANGED).map((c) => c.key),
    ttlChanged: changes.filter((c) => c.type === CHANGE_TYPES.TTL_CHANGED).map((c) => c.key),
    typeChanged: changes.filter((c) => c.type === CHANGE_TYPES.TYPE_CHANGED).map((c) => c.key),
    tenantChanged: changes.filter((c) => c.type === CHANGE_TYPES.TENANT_CHANGED).map((c) => c.key),
    sessionChanged: changes.filter((c) => c.type === CHANGE_TYPES.SESSION_CHANGED).map((c) => c.key),
    changes,
  };
}

function hasType(summary, type) {
  return (summary.changes || []).some((c) => c.type === type);
}

function keysOfType(summary, type) {
  return (summary.changes || []).filter((c) => c.type === type).map((c) => c.key);
}

module.exports = {
  CHANGE_TYPES,
  classify,
  diffSnapshots,
  hasType,
  keysOfType,
  fingerprint,
  fingerprintOf,
};