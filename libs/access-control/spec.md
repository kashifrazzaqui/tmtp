# Access Control Library Spec

## Purpose and responsibility
Protect one personal instance with a pre-provisioned high-entropy access token, revocable opaque sessions, login throttling, and CSRF verification. It deliberately does not implement passwords, signup, OAuth, or multiple users.

## Public interface / API surface
```ts
export interface AccessSession {
  sessionHash: string;
  csrfSecretHash: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt?: string;
}

export interface AccessSessionStore {
  insert(session: AccessSession): void;
  find(sessionHash: string): AccessSession | undefined;
  touch(sessionHash: string, at: string): void;
  revoke(sessionHash: string, at: string): void;
}

export interface IssuedSession {
  opaqueSession: string;
  csrfSecret: string;
  expiresAt: string;
}

export interface AccessControl {
  login(presentedToken: string): Promise<IssuedSession>;
  authenticate(opaqueSession: string): AccessSession | undefined;
  logout(opaqueSession: string): void;
  verifyCsrf(session: AccessSession, presentedSecret: string): boolean;
}

export function createAccessControl(options: {
  accessToken: string;
  store: AccessSessionStore;
  clock: import("@tmtp/clock").Clock;
  sessionTtlSeconds: number;
  loginMaxAttempts: number;
  loginWindowSeconds: number;
}): AccessControl;
```

Only hashes of random token/session verifiers are persisted. Raw secrets never enter logs. The service owns cookie attributes and HTTPS policy; this library owns token/session semantics.

## Internal subcomponents
- Constant-time token verification and CSPRNG session issuance.
- Session repository port, expiry, renewal, and revocation.
- Login throttle and CSRF verifier.

## Dependencies on other libs
- `clock`

The session store is a structural port implemented by `reader-store`; no dependency inversion cycle exists.

## New build or OSS wrapper
New narrow build over Node Web Crypto. No general authentication framework.

## Hosted by
`services/personal-reader` as an HTTP authentication/authorization hook.

## Configuration
- `auth.access_token_path` — **required** for every deployment mode; path to the pre-provisioned high-entropy token.
- `auth.session_ttl_seconds` — **optional**, default `604800`.
- `auth.login_max_attempts` — **optional**, default `10`.
- `auth.login_window_seconds` — **optional**, default `300`.
