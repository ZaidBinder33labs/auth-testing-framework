'use strict';
// Tenant and session isolation validation.
// Compares Redis state across tenants and reports cross-tenant contamination.
const { diffSnapshots } = require('@atf/state-diff');

const ISOLATION_RESULTS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNVERIFIED: 'UNVERIFIED',
});

const MUTATION_TYPES = new Set([
  'ADDED', 'REMOVED', 'MODIFIED', 'TTL_CHANGED', 'TYPE_CHANGED', 'TENANT_CHANGED', 'SESSION_CHANGED',
]);

function tenantKeys(snapshot, tenantId) {
  return Object.keys(snapshot || {}).filter((k) => {
    const entry = snapshot[k];
    return entry && entry.tenantId === tenantId;
  });
}

/** Check that every tenant OTHER than sourceTenantId is unchanged between before/after. */
function validateNoCrossTenantContamination(before, after, sourceTenantId, opts = {}) {
  const tenants = opts.tenants || [];
  const diff = diffSnapshots(before, after);
  const otherTenants = tenants.filter((t) => t !== sourceTenantId);
  const contaminated = [];
  for (const change of diff.changes) {
    if (!MUTATION_TYPES.has(change.type)) continue;
    const entry = change.after || change.before;
    if (!entry || !entry.tenantId) continue;
    if (otherTenants.includes(entry.tenantId)) {
      contaminated.push({
        tenant: entry.tenantId,
        key: change.key,
        change: change.type,
      });
    }
  }
  return {
    result: contaminated.length ? ISOLATION_RESULTS.FAIL : ISOLATION_RESULTS.PASS,
    sourceTenantId,
    otherTenants,
    contamination: contaminated,
    diff,
  };
}

/** Check that a specific tenant's state changed as expected. */
function validateExpectedTenantChange(before, after, tenantId, opts = {}) {
  const beforeKeys = tenantKeys(before, tenantId);
  const afterKeys = tenantKeys(after, tenantId);
  const added = afterKeys.filter((k) => !beforeKeys.includes(k));
  const removed = beforeKeys.filter((k) => !afterKeys.includes(k));
  const changed = beforeKeys.filter((k) => afterKeys.includes(k))
    .filter((k) => before[k].value !== after[k].value || before[k].ttl !== after[k].ttl);
  const ok = opts.expectChange ? (added.length + removed.length + changed.length) > 0 : true;
  return {
    result: ok ? ISOLATION_RESULTS.PASS : ISOLATION_RESULTS.FAIL,
    tenantId,
    added,
    removed,
    changed,
  };
}

/** Check that sessions for the same tenant are isolated: logout A leaves B intact. */
function validateSessionIsolation(before, after, sessions, opts = {}) {
  const { loggedOutSessionId, tenantId } = opts;
  const diff = diffSnapshots(before, after);
  const issues = [];
  for (const s of sessions) {
    const beforeKeys = tenantKeys(before, tenantId).filter((k) => before[k].sessionId === s.id);
    const afterKeys = tenantKeys(after, tenantId).filter((k) => after[k].sessionId === s.id);
    if (s.id === loggedOutSessionId) {
      if (afterKeys.length > 0) {
        issues.push({ sessionId: s.id, issue: 'SESSION_STILL_ACTIVE_AFTER_LOGOUT', keys: afterKeys });
      }
    } else {
      if (afterKeys.length === 0 && beforeKeys.length > 0) {
        issues.push({ sessionId: s.id, issue: 'UNEXPECTED_SESSION_REMOVAL', keys: beforeKeys });
      }
    }
  }
  return {
    result: issues.length ? ISOLATION_RESULTS.FAIL : ISOLATION_RESULTS.PASS,
    issues,
    diff,
  };
}

module.exports = {
  ISOLATION_RESULTS,
  tenantKeys,
  validateNoCrossTenantContamination,
  validateExpectedTenantChange,
  validateSessionIsolation,
};