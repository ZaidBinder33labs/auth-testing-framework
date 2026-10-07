# Tenant isolation

The framework validates that authentication in one tenant never mutates state
belonging to another tenant.

## Model

```
Tenant A → User A1, A2
Tenant B → User B1, B2
Tenant C → User C1
```

Every Redis entry is stamped with `tenantId` (and optionally `sessionId`) by the
adapter. The isolation engine then compares snapshots before and after an action.

## Validation rules

### `validateNoCrossTenantContamination(before, after, sourceTenantId, { tenants })`

Returns `PASS` when every tenant other than `sourceTenantId` is unchanged between
`before` and `after`. Returns `FAIL` and lists the contaminated keys when another
tenant's state is added, removed, modified, or has its TTL/type/session changed.

### `validateExpectedTenantChange(before, after, tenantId, { expectChange })`

Returns `PASS` when the source tenant's state changed as expected.

### `validateSessionIsolation(before, after, sessions, { loggedOutSessionId, tenantId })`

Returns `PASS` when the logged-out session is gone and every other session for the
same tenant remains intact. Returns `FAIL` with `SESSION_STILL_ACTIVE_AFTER_LOGOUT`
or `UNEXPECTED_SESSION_REMOVAL`.

## Cross-tenant access

For every cross-tenant test the framework records:

```
sourceTenant, targetTenant, actor, endpoint/resource, HTTP result,
Redis BEFORE, Redis AFTER, Redis DIFF
```

Raw tokens are never recorded; only fingerprints.

## Contamination is not automatically a vulnerability

`UNEXPECTED_CROSS_TENANT_STATE_CHANGE` is reported, not asserted as a
vulnerability. Whether it is a security issue depends on the target application's
declared contract. The framework flags it so a human can decide.

## Session isolation

```
Session A1, Session A2 (same tenant)

logout A1 → A1 invalid, A2 valid
```

unless the target application intentionally implements global logout. The adapter
declares `globalLogout` so the framework adapts.