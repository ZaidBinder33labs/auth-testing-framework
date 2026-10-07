# Integration

How a target application is added to this framework, and where the boundary of a
descriptor lies.

## What actually exists

| Concern | Where it lives | Status |
|---|---|---|
| Adapter contract checks | `packages/adapters/src/index.js` | Implemented |
| HTTP transport | `packages/http-transport` | Implemented |
| Target descriptors | `packages/target-config` + `config/targets/*.json` | Implemented, read by the adapter |
| Environment descriptors | â€” | Phase 3 |
| Safety policies | â€” | Phase 3 |
| Redis adapter for a real target | â€” | Not implemented. `@atf/adapters` ships `MockRedisAdapter` and the `@atf/redis-observer` safety layer only. |

An earlier version of this document claimed the adapter read
`config/target.json`. Nothing read it; the descriptor reader did not exist. That
file has been replaced by `config/targets/<name>.json` and the loader that reads
it.

## The three dimensions

They are deliberately separate, because they change for different reasons and at
different times.

**TARGET â€” what the application IS.** `config/targets/<name>.json`. Endpoint
paths, credential field names, access/refresh/expiry field names, expiry format,
rotation, cookie-vs-body refresh, the logout success status, JWT claim names, and
the Redis key prefixes the application itself writes. Identical in every
environment of that application.

**ENVIRONMENT â€” where it RUNS.** `config/environments/<name>.json` (Phase 3).
Base URL, Redis connection details, TLS, mode and namespace, and which credential
environment variables to read. Credentials are named as variables
(`BINDER_DEV_EMAIL`) and never stored.

**POLICY â€” what the suite may do there.** `config/policies/<name>.json` (Phase 3).
Capabilities, not suite names.

Run-time selection is `TARGET=binder ENV=dev`.

## Adding an application

One JSON file. No adapter code, if the application matches the flow in the README
boundary statement:

```jsonc
{
  "name": "acme",
  "auth": {
    "loginPath": "/v2/session/start",
    "refreshPath": "/v2/session/renew",
    "logoutPath": "/v2/session/end",
    "mePath": "/v2/whoami",
    "accessPath": "/v2/whoami/grants",
    "loginFields": { "email": "user_name", "password": "secret" },
    "cookieAuth": false,
    "rotationEnabled": false,
    "globalLogout": false,
    "logoutSuccessStatus": 200,
    "fields": {
      "accessToken": "session_token",
      "refreshToken": "renew_token",
      "expires": "ttl_seconds",
      "expiresFormat": "seconds",
      "tokenType": "token_kind"
    },
    "claims": { "tenant": "tenant", "user": "actor" },
    "userFields": { "userId": "id", "email": "login" },
    "accessFields": {
      "screenCode": "screen_key", "moduleCode": "module_key", "scope": "reach",
      "level": "tier", "canApprove": "may_approve", "canDelete": "may_remove"
    }
  },
  "redis": { "sessionPrefix": "session/", "tokenPrefix": "bearer/", "tenantPrefix": "org/" }
}
```

Then:

```javascript
const { CredentialAuthAdapter } = require('@atf/adapters/targets').binder;
const adapter = new CredentialAuthAdapter({
  onboardingUrl: 'https://acme.example.test',
  requestContext,
  targetName: 'acme',
});
```

`require('@atf/adapters')` does **not** load any target; reaching one is a
deliberate act via `@atf/adapters/targets`.

### Constraints the loader enforces

- No `baseUrl` or `apiUrl` in a descriptor. A descriptor that pinned a host would
  silently retarget every test that loaded it; the environment supplies the host.
- Paths must be fragments beginning with a single `/`. A leading `//` is refused
  because that is how a protocol-relative URL is spelled.
- Field names must be bare identifiers.
- `expiresFormat` is `datetime` or `seconds`, and is authoritative. A timestamp
  sent to a `seconds` target yields `expiresIn: null` rather than a guess.
- Booleans must be booleans. `rotationEnabled: "true"` is refused, not coerced.
- Errors carry a code and never echo the value that caused them.

## Redis key prefixes

The target's prefixes (`sessionPrefix`, `tokenPrefix`, `tenantPrefix`) are what
the application writes, so they belong to the target and are identical everywhere.

A deployment that prefixes its own keys puts that in the environment, applied
**before** the target's prefix:

```javascript
composeKeyPrefix(target, { namespace: 'qa:fx1', deploymentPrefix: 'stage:' })
// => 'stage:qa:fx1session/'
```

`@atf/redis-observer` does not yet call this; the composition is provided and
tested in `@atf/target-config`, and wiring the observer to it is future work.

## What a descriptor cannot express

The descriptor is vocabulary, not flow. It cannot describe:

- a login with more than one step (challenge, MFA, device registration);
- an OAuth/OIDC authorization-code redirect;
- a refresh token carried in a request header;
- an authorization scheme other than `Authorization: Bearer` (that lives in
  `@atf/http-transport`);
- an access token that is not a single opaque string;
- a logout that needs a request body.

Anything on that list needs a new adapter class. See the boundary statement in
`README.md`.

## Redis adapter contract

Still unimplemented for a real target, recorded here so the gap is visible:

```javascript
class TargetRedisAdapter {
  async inspect(key) { /* -> entry */ }
  async snapshot() { /* -> { key: entry } */ }
  async discoverKeys() { /* -> [key] */ }
  async getTtl(key) { /* -> seconds|null */ }
  async pttl(key) { /* -> ms|null */ }
  async validateTtl(key, expectedSeconds, toleranceMs) { /* -> { ok, reason } */ }
}
```

`FLUSHALL` / `FLUSHDB` / wildcard deletes are unreachable through
`@atf/redis-observer` and must stay so.

## Steps to integrate

1. Add `config/targets/<name>.json`.
2. Point an environment descriptor at it (Phase 3).
3. `npm run test:all` â€” nothing existing may break.
4. Add tests under `tests/` as needed.
5. `npm run docs:sync` â€” the descriptor list is generated.

## Running

```bash
npm install
npm run test:all          # everything
npm run test:unit         # package unit tests
npm run test:contract     # adapter contracts
npm run test:multitenant  # tenant isolation + shared-interface
npm run test:redis:integration   # real Redis
npm run test:reporting    # report generation
npm run test:security     # security suite
npm run test:tenancy      # isolation suite
npm run test:concurrency  # concurrency suite
npm run test:self         # framework self-tests
```
