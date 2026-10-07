'use strict';
// Threshold / assertion logic for rate-limit testing.
// No hardcoded limits; everything is driven by configuration.

const RESULT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNVERIFIED: 'UNVERIFIED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  PARTIAL: 'PARTIAL',
});

/** Compare observed count against configured limit. */
function evaluateThreshold(observed, limit, opts = {}) {
  const { windowMs, tolerance = 0 } = opts;
  if (observed === null || observed === undefined || limit === null || limit === undefined) {
    return { result: RESULT.UNVERIFIED, observed, limit, reason: 'MISSING_DATA' };
  }
  if (observed < limit) {
    return { result: RESULT.PASS, observed, limit, headroom: limit - observed, reason: 'BELOW_LIMIT' };
  }
  if (observed === limit) {
    return { result: RESULT.PASS, observed, limit, headroom: 0, reason: 'AT_LIMIT' };
  }
  return { result: RESULT.FAIL, observed, limit, exceeded: observed - limit, reason: 'ABOVE_LIMIT' };
}

/** Evaluate whether two users share an allowance (isolation check). */
function evaluateUserIsolation(counts, limit, opts = {}) {
  // counts: [{ user, observed }]; each user should be allowed up to `limit`.
  if (!Array.isArray(counts) || counts.length === 0) {
    return { result: RESULT.UNVERIFIED, reason: 'NO_USERS' };
  }
  const results = counts.map((c) => {
    const r = evaluateThreshold(c.observed, limit, opts);
    return { user: c.user, observed: c.observed, ...r };
  });
  const allBelow = results.every((r) => r.result !== RESULT.FAIL);
  // If any user was blocked while under the limit, isolation failed.
  const blockedWhileUnder = results.filter((r) => r.blocked && r.observed < limit);
  const isolated = blockedWhileUnder.length === 0;
  return {
    result: isolated && allBelow ? RESULT.PASS : RESULT.FAIL,
    users: results,
    isolated,
    reason: isolated ? 'USER_ISOLATED' : 'USER_NOT_ISOLATED',
  };
}

/** Evaluate whether the office ceiling aggregates across users. */
function evaluateOfficeCeiling(userCounts, officeLimit, opts = {}) {
  if (!Array.isArray(userCounts) || userCounts.length === 0) {
    return { result: RESULT.UNVERIFIED, reason: 'NO_USERS' };
  }
  const total = userCounts.reduce((s, c) => s + (c.observed || 0), 0);
  const perUser = userCounts.map((c) => ({ user: c.user, observed: c.observed }));
  const withinOffice = total <= officeLimit;
  return {
    result: withinOffice ? RESULT.PASS : RESULT.FAIL,
    total,
    officeLimit,
    perUser,
    headroom: officeLimit - total,
    reason: withinOffice ? 'OFFICE_OK' : 'OFFICE_EXCEEDED',
  };
}

/** Evaluate whether IPv6 rotation bypasses the limit. */
function evaluateIpv6Bypass(addresses, limit, opts = {}) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { result: RESULT.UNVERIFIED, reason: 'NO_ADDRESSES' };
  }
  const total = addresses.reduce((s, a) => s + (a.observed || 0), 0);
  // If each address independently gets `limit`, total == addresses.length * limit.
  // If they share a bucket, total should be ~limit.
  const independentMax = addresses.length * limit;
  const bypassed = total > limit + (opts.tolerance || 0);
  return {
    result: bypassed ? RESULT.FAIL : RESULT.PASS,
    addresses,
    total,
    limit,
    independentMax,
    bypassed,
    reason: bypassed ? 'IPV6_BYPASS_DETECTED' : 'IPV6_AGGREGATED',
  };
}

/** Evaluate atomicity of a rate-limit counter under concurrency. */
function evaluateAtomicity(sent, allowed, limit, opts = {}) {
  if (sent === null || allowed === null) {
    return { result: RESULT.UNVERIFIED, reason: 'MISSING_DATA' };
  }
  const overflow = allowed > limit + (opts.tolerance || 0);
  const undercount = allowed < sent && allowed < limit;
  return {
    result: overflow || undercount ? RESULT.FAIL : RESULT.PASS,
    sent,
    allowed,
    limit,
    overflow,
    undercount,
    reason: overflow ? 'RACE_OVERFLOW' : (undercount ? 'RACE_UNDERCOUNT' : 'ATOMIC_OK'),
  };
}

module.exports = {
  RESULT,
  evaluateThreshold,
  evaluateUserIsolation,
  evaluateOfficeCeiling,
  evaluateIpv6Bypass,
  evaluateAtomicity,
};