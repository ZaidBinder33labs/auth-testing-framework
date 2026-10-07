# Architecture

The framework is a **Node.js monorepo** of ten packages plus a shared test tree.
It is application-agnostic: a target application (e.g. Binder) is integrated through
adapters only. The cores never see target-specific schema.

## Packages

| Package | Responsibility | Dependencies |
|---|---|---|
| `@atf/tenant-core` | Tenant/actor identity, registry, validation | none |
| `@atf/auth-core` | AuthManager: login/refresh/logout/session lifecycle | tenant-core, adapters |
| `@atf/redis-observer` | Read-only Redis observation, TTL, fingerprints | ioredis |
| `@atf/state-diff` | Snapshot diff engine (ADDED/REMOVED/MODIFIED/...) | none |
| `@atf/isolation-engine` | Tenant/session isolation validation | tenant-core, state-diff |
| `@atf/token-security` | Fingerprinting, redaction, JWT/opaque inspection | none |
| `@atf/concurrency-engine` | RefreshLock, parallelLimit, waitForRace | none |
| `@atf/test-fixtures` | Deterministic tenants/actors (A/B/C, A1..C1) | tenant-core, auth-core |
| `@atf/reporting` | Evidence, safe serialization, Reporter | token-security |
| `@atf/adapters` | Adapter contracts + MockAuth/MockTenant/MockRedis | auth-core, tenant-core, redis-observer, concurrency-engine |
| `@atf/lifecycle-engine` | BEFORE/AFTER scenario engine | state-diff, reporting, isolation-engine |

## Test tree

```
tests/
â”œâ”€â”€ unit/          # package-local unit tests (mirrored under packages/*/tests)
â”œâ”€â”€ contract/      # adapter contract tests
â”œâ”€â”€ integration/   # end-to-end scenarios
â”œâ”€â”€ security/      # invalid/expired/malformed tokens, rotation, reuse
â”œâ”€â”€ tenancy/       # isolation, cross-tenant, contamination
â”œâ”€â”€ redis/         # snapshot, diff, TTL, consistency
â”œâ”€â”€ authentication/# login
â”œâ”€â”€ session/       # logout, multi-session, isolation
â”œâ”€â”€ token/         # refresh, rotation
â”œâ”€â”€ concurrency/   # refresh races, concurrent login
â”œâ”€â”€ lifecycle/     # BEFORE/AFTER scenario engine
â””â”€â”€ selftest/      # framework self-tests proving the framework itself works
```

## Data flow

```
Tenant â†’ Actor â†’ Login â†’ Session â†’ Access Token â†’ Refresh Token â†’ Redis State
   â†“                â†“        â†“          â†“             â†“               â†“
tenant-core     tenant-core  auth-core  auth-core    token-security   redis-observer
```

## Adapters

A real adapter (e.g. `CredentialAuthAdapter`) implements the contract in
`@atf/adapters` and is verified by the contract tests. Mock adapters let the
framework self-test with no target application.

## Redis modes

- `MOCK_REDIS` (default for self-tests) â€” in-memory mock, no real Redis.
- `READ_ONLY` (default for external targets) â€” mutations blocked.
- `DEDICATED_TEST_REDIS` / `TEST_NAMESPACE` â€” controlled mutation allowed.

`FLUSHALL`/`FLUSHDB`/wildcard deletes are never used. Only test-owned keys are touched.
