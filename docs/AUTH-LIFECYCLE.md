# Authentication lifecycle

```
Tenant → Actor → Login → Session → Access Token → Refresh Token → Redis State
   ↓        ↓        ↓          ↓             ↓               ↓
tenant-core  auth-core  auth-core  auth-core    token-security   redis-observer
```

## AuthManager public interface

```javascript
await auth.login(tenant, actor, credentials)        // -> { session, accessToken, ... }
await auth.refresh(session)                          // -> { accessToken, ... }
await auth.logout(session)                           // -> { invalidated, count }
await auth.getSessionState(session)                  // -> { authenticated, ... }
await auth.getAccessToken(session)                   // -> token string
await auth.getRefreshTokenState(session)             // -> { present, fingerprint, rotated }
await auth.isAuthenticated(session)                  // -> boolean
await auth.clearSession(session)
```

## Session states

```
pending → authenticated → expired → logged-out
```

## Refresh token rotation

Rotation is **configurable through the adapter**, not hard-coded.

```
Refresh Token A
      ↓ REFRESH
Refresh Token B
```

When rotation is enabled, the old refresh token is recorded in
`previousRefreshTokens` and is no longer the current token. The framework tests
reuse of the old token only if the adapter's contract says it should be rejected.

## Logout

Two modes, configured on the adapter:

- `delete-on-logout` — session state removed.
- `revocation-on-logout` — session state retained but marked invalid.

Both are supported. The framework does not assume which one the target uses.