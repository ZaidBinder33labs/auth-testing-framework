# Security model

## Never logged

The framework never logs or records:

- passwords
- access tokens
- refresh tokens
- cookies
- `Authorization` headers
- raw Redis secrets

## Redaction

`@atf/token-security` redacts every serialized evidence object:

- Credential-container keys (`password`, `secret`, `cookie`, `authorization`,
  `api_key`, `private_key`) → `[REDACTED]`
- Token values elsewhere → `[TOKEN:<sha256-fingerprint>]`
- JWT-shaped or long opaque strings in raw text → rejected by `assertRedacted`

## Fingerprints

SHA-256 fingerprints (first 16 hex chars) let the framework compare tokens and
detect rotation without exposing them.

## Security tests

- invalid refresh token
- expired refresh token
- malformed refresh token
- token rotation (old token invalid after rotation)
- token reuse
- cross-tenant authorization
- redaction of raw tokens from evidence

JWT-specific assertions (wrong signature, wrong audience, wrong issuer) are only
implemented when the target uses JWT. Opaque tokens are supported too.

## Invariants

Every invariant returns one of:

```
PASS, FAIL, UNVERIFIED
```

"Could not verify Redis" is **never** converted to `PASS`.