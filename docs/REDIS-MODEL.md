# Redis model

The framework observes Redis state through the `RedisObserver` and never exposes raw
values or secrets. It works against a real `ioredis` client or the in-memory
`MockRedisClient` test double.

## Observed attributes

For every key the observer records:

- `key` — the key (namespace-stripped when a namespace is configured)
- `exists`
- `type` — `string`, `hash`, `list`, `set`, `zset`, `stream`, `unknown`
- `ttl` — seconds to live, or `null` when no expiry
- `noExpiry` — true when the key has no TTL
- `fingerprint` — SHA-256 (first 16 hex chars) of the value
- `cardinality` — for hash/list/set/zset
- `fields` — hash fields, with sensitive field values redacted
- `value` — string value, redacted when the key looks sensitive
- `tenantId` / `sessionId` — stamped by the adapter layer for isolation checks

## Safe value inspection

- Hash fields named `password`, `secret`, `token`, `refresh`, `access`, `cookie`,
  `authorization`, `api_key` are redacted as `[REDACTED]`.
- String values under sensitive keys are redacted as `[REDACTED]`.
- All other values are returned in full for inspection.
- Fingerprints are SHA-256 so identical values are detectable without exposing them.

## Snapshot / diff

`RedisSnapshotEngine` produces a `{ key: entry }` map. `RedisDiffEngine`
classifies every change between two snapshots:

```
ADDED, REMOVED, MODIFIED, UNCHANGED, TTL_CHANGED, TYPE_CHANGED,
TENANT_CHANGED, SESSION_CHANGED
```

## TTL validation

`TTLValidator` compares actual TTL against an expected value with a tolerance
in milliseconds. It reports:

```
TTL_CREATED, TTL_DECREASED, TTL_EXTENDED, TTL_REMOVED, NO_EXPIRY, TTL_MISMATCH
```

Exact-second equality is never required.

## Modes

- `MOCK_REDIS` — in-memory mock, default for self-tests.
- `READ_ONLY` — mutations blocked; default for external targets.
- `DEDICATED_TEST_REDIS` / `TEST_NAMESPACE` — controlled mutation allowed.

`FLUSHALL`, `FLUSHDB`, and wildcard deletes are never used. Only keys created by
the current test are tracked and cleaned up.

## Phase 2 — real Redis connection + READ_ONLY safety

### Configuration

All values are read from environment variables only. Never commit credentials.

| Variable | Default | Description |
|---|---|---|
| `REDIS_MODE` | `MOCK_REDIS` | `MOCK_REDIS`, `READ_ONLY`, `DEDICATED_TEST_REDIS`, `TEST_NAMESPACE` |
| `REDIS_URL` | — | Credential-bearing URL; never logged |
| `REDIS_USERNAME` | — | Optional username |
| `REDIS_PASSWORD` | — | Optional password; never logged |
| `REDIS_DB` | `0` | Integer 0–15; invalid values rejected |
| `REDIS_TLS` | `true` | Enable TLS |
| `REDIS_CA` | — | Path to CA bundle |
| `REDIS_CONNECT_TIMEOUT` | `5000` | Connection timeout in ms |
| `REDIS_COMMAND_TIMEOUT` | `3000` | Command timeout in ms |

The configuration object exposes only safe metadata: `mode`, `hasUrl`, `hasUsername`,
`hasPassword`, `db`, `tlsEnabled`, `hasCA`, `connectTimeout`, `commandTimeout`,
`sanitizedUrl`. It never exposes the password, the credential-bearing URL, or
authentication headers.

### RedisConnection

`RedisConnection(config)` — `connect()`, `ping()`, `disconnect()`, `isConnected()`,
`getClient()`. TLS is supported via `rediss://` or `REDIS_TLS=true`. No automatic
reconnect loop during tests. No connection during module import.

### READ_ONLY allowed commands

`PING`, `SCAN`, `EXISTS`, `TYPE`, `GET`, `HGETALL`, `LLEN`, `SCARD`, `ZCARD`, `TTL`, `PTTL`.

### READ_ONLY blocked commands

`SET`, `SETEX`, `DEL`, `UNLINK`, `EXPIRE`, `PEXPIRE`, `PERSIST`, `RENAME`, `RENAMENX`,
`FLUSHDB`, `FLUSHALL`, `EVAL`, `EVALSHA`, `SCRIPT`, `HSET`, `HDEL`, `RPUSH`, `LPUSH`,
`LPOP`, `RPOP`, `SADD`, `SREM`, `ZADD`, `ZREM`, and other mutation commands.

A blocked command throws `REDIS_MUTATION_BLOCKED` and never reaches the underlying client.

### Smoke test

`npm run redis:smoke` runs only against `REDIS_MODE=READ_ONLY` + `REDIS_URL`. It is
NOT part of `npm run test:all`. It performs PING, a small SCAN, TYPE/TTL/PTTL on
sampled keys, verifies mutation blocking, and disconnects. It never prints the
password, the credential-bearing URL, raw Redis values, JWTs, or secrets. Use
`SCAN` (small COUNT) instead of `KEYS`.