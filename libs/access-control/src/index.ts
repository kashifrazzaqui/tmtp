import type { Clock } from "@tmtp/clock";

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

export type AccessControlErrorCode = "invalid-configuration" | "invalid-token" | "login-rate-limited";

const ERROR_MESSAGES: Record<AccessControlErrorCode, string> = {
  "invalid-configuration": "Access-control configuration is invalid.",
  "invalid-token": "Access token is invalid.",
  "login-rate-limited": "Too many login attempts.",
};

export class AccessControlError extends Error {
  override readonly name = "AccessControlError" as const;
  readonly retryAfterSeconds?: number;

  constructor(readonly code: AccessControlErrorCode, retryAfterSeconds?: number) {
    super(ERROR_MESSAGES[code]);
    if (code === "login-rate-limited") {
      if (!Number.isSafeInteger(retryAfterSeconds) || (retryAfterSeconds ?? 0) < 1) {
        throw new TypeError("Rate-limit retry-after seconds must be a positive safe integer.");
      }
      this.retryAfterSeconds = retryAfterSeconds as number;
    } else if (retryAfterSeconds !== undefined) {
      throw new TypeError("Retry-after seconds are only valid for rate-limit errors.");
    }
  }
}

export interface AccessControl {
  login(presentedToken: string): Promise<IssuedSession>;
  authenticate(opaqueSession: string): Promise<AccessSession | undefined>;
  logout(opaqueSession: string): Promise<void>;
  verifyCsrf(session: AccessSession, presentedSecret: string): Promise<boolean>;
}

export interface AccessControlOptions {
  accessToken: string;
  store: AccessSessionStore;
  clock: Clock;
  sessionTtlSeconds: number;
  loginMaxAttempts: number;
  loginWindowSeconds: number;
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

type CryptoBytes = Uint8Array<ArrayBuffer>;

function canonicalSecret(value: unknown): CryptoBytes | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) return undefined;
  return new Uint8Array(bytes);
}

async function sha256(bytes: CryptoBytes): Promise<CryptoBytes> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

function equalDigests(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function invalidConfiguration(): AccessControlError {
  return new AccessControlError("invalid-configuration");
}

export function createAccessControl(options: AccessControlOptions): AccessControl {
  if (
    options === null || typeof options !== "object" ||
    typeof options.accessToken !== "string" ||
    options.store === null || typeof options.store !== "object" ||
    !["insert", "find", "touch", "revoke"].every((key) =>
      typeof (options.store as unknown as Record<string, unknown>)[key] === "function"
    ) ||
    options.clock === null || typeof options.clock !== "object" ||
    typeof options.clock.now !== "function" || typeof options.clock.monotonicNowMs !== "function" ||
    !validInteger(options.sessionTtlSeconds, 1, 31_536_000) ||
    !validInteger(options.loginMaxAttempts, 1, 1_000_000) ||
    !validInteger(options.loginWindowSeconds, 1, 86_400)
  ) {
    throw invalidConfiguration();
  }
  const tokenBytes = Buffer.from(options.accessToken, "utf8");
  if (tokenBytes.length < 32 || tokenBytes.length > 1024) throw invalidConfiguration();

  const token = new Uint8Array(tokenBytes);
  const { store, clock, sessionTtlSeconds, loginMaxAttempts, loginWindowSeconds } = options;
  let windowStartedMs: number | undefined;
  let attempts = 0;

  function reserveAttempt(): void {
    const now = clock.monotonicNowMs();
    if (windowStartedMs === undefined || now - windowStartedMs >= loginWindowSeconds * 1000) {
      windowStartedMs = now;
      attempts = 0;
    }
    if (attempts >= loginMaxAttempts) {
      const remaining = windowStartedMs + loginWindowSeconds * 1000 - now;
      throw new AccessControlError("login-rate-limited", Math.max(1, Math.ceil(remaining / 1000)));
    }
    attempts += 1;
  }

  async function verifyToken(presented: unknown): Promise<boolean> {
    if (typeof presented !== "string") return false;
    const presentedBytes = Buffer.from(presented, "utf8");
    if (presentedBytes.length > 1024) return false;
    const [expectedDigest, presentedDigest] = await Promise.all([
      sha256(token),
      sha256(new Uint8Array(presentedBytes)),
    ]);
    return equalDigests(expectedDigest, presentedDigest);
  }

  return {
    async login(presentedToken: string): Promise<IssuedSession> {
      reserveAttempt();
      if (!(await verifyToken(presentedToken))) throw new AccessControlError("invalid-token");

      const now = clock.now();
      const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
      const expires = new Date(nowMs + sessionTtlSeconds * 1000);
      if (!Number.isFinite(nowMs) || !Number.isFinite(expires.getTime())) throw invalidConfiguration();
      const createdAt = now.toISOString();
      const expiresAt = expires.toISOString();
      const sessionBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const csrfBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const [sessionDigest, csrfDigest] = await Promise.all([sha256(sessionBytes), sha256(csrfBytes)]);
      store.insert({
        sessionHash: Buffer.from(sessionDigest).toString("hex"),
        csrfSecretHash: Buffer.from(csrfDigest).toString("hex"),
        createdAt,
        expiresAt,
        lastUsedAt: createdAt,
      });
      return {
        opaqueSession: Buffer.from(sessionBytes).toString("base64url"),
        csrfSecret: Buffer.from(csrfBytes).toString("base64url"),
        expiresAt,
      };
    },

    async authenticate(opaqueSession: string): Promise<AccessSession | undefined> {
      const bytes = canonicalSecret(opaqueSession);
      if (bytes === undefined) return undefined;
      const sessionHash = Buffer.from(await sha256(bytes)).toString("hex");
      const record = store.find(sessionHash);
      if (record === undefined || record.revokedAt !== undefined) return undefined;
      const now = clock.now();
      const nowMs = now.getTime();
      const expiresMs = Date.parse(record.expiresAt);
      const lastUsedMs = Date.parse(record.lastUsedAt);
      if (!Number.isFinite(expiresMs) || !Number.isFinite(lastUsedMs) || nowMs >= expiresMs) return undefined;
      const usedAt = new Date(Math.max(nowMs, lastUsedMs)).toISOString();
      store.touch(sessionHash, usedAt);
      return { ...record, lastUsedAt: usedAt };
    },

    async logout(opaqueSession: string): Promise<void> {
      const bytes = canonicalSecret(opaqueSession);
      if (bytes === undefined) return;
      const sessionHash = Buffer.from(await sha256(bytes)).toString("hex");
      const record = store.find(sessionHash);
      if (record !== undefined && record.revokedAt === undefined) {
        store.revoke(sessionHash, clock.now().toISOString());
      }
    },

    async verifyCsrf(session: AccessSession, presentedSecret: string): Promise<boolean> {
      const bytes = canonicalSecret(presentedSecret);
      if (
        bytes === undefined || session === null || typeof session !== "object" ||
        session.revokedAt !== undefined || typeof session.csrfSecretHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(session.csrfSecretHash) ||
        !Number.isFinite(Date.parse(session.expiresAt)) || clock.now().getTime() >= Date.parse(session.expiresAt)
      ) {
        return false;
      }
      const digest = await sha256(bytes);
      return equalDigests(digest, new Uint8Array(Buffer.from(session.csrfSecretHash, "hex")));
    },
  };
}
