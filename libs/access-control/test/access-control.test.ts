import { createHash } from "node:crypto";
import { createFixedClock } from "@tmtp/clock";
import { describe, expect, it } from "vitest";
import {
  AccessControlError,
  createAccessControl,
} from "../src/index.js";
import type { AccessSession, AccessSessionStore } from "../src/index.js";

const TOKEN = "a".repeat(32);
const hash = (value: string) => createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex");

class MemoryStore implements AccessSessionStore {
  readonly records = new Map<string, AccessSession>();
  readonly calls: string[] = [];

  insert(session: AccessSession): void {
    this.calls.push("insert");
    this.records.set(session.sessionHash, { ...session });
  }
  find(sessionHash: string): AccessSession | undefined {
    this.calls.push("find");
    const record = this.records.get(sessionHash);
    return record === undefined ? undefined : { ...record };
  }
  touch(sessionHash: string, at: string): void {
    this.calls.push("touch");
    const record = this.records.get(sessionHash);
    if (record !== undefined) record.lastUsedAt = at;
  }
  revoke(sessionHash: string, at: string): void {
    this.calls.push("revoke");
    const record = this.records.get(sessionHash);
    if (record !== undefined) record.revokedAt = at;
  }
}

function setup(overrides: Record<string, unknown> = {}) {
  const store = new MemoryStore();
  const clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
  const access = createAccessControl({
    accessToken: TOKEN,
    store,
    clock,
    sessionTtlSeconds: 60,
    loginMaxAttempts: 10,
    loginWindowSeconds: 300,
    ...overrides,
  });
  return { access, store, clock };
}

describe("configuration and errors", () => {
  it("should reject invalid options without echoing configured values", () => {
    for (const options of [
      { accessToken: "short-token-sentinel" },
      { accessToken: "x".repeat(1025) },
      { sessionTtlSeconds: 0 },
      { sessionTtlSeconds: 31_536_001 },
      { loginMaxAttempts: 0 },
      { loginMaxAttempts: 1_000_001 },
      { loginWindowSeconds: 0 },
      { loginWindowSeconds: 86_401 },
      { store: {} },
      { clock: {} },
    ]) {
      try {
        setup(options);
        throw new Error("unreachable");
      } catch (error) {
        expect(error).toBeInstanceOf(AccessControlError);
        expect((error as AccessControlError).code).toBe("invalid-configuration");
        expect((error as Error).message).toBe("Access-control configuration is invalid.");
        expect(JSON.stringify(error)).not.toContain("short-token-sentinel");
      }
    }
  });

  it("should accept token and policy boundaries", () => {
    expect(() => setup({ accessToken: "x".repeat(32), sessionTtlSeconds: 1, loginMaxAttempts: 1, loginWindowSeconds: 1 })).not.toThrow();
    expect(() => setup({ accessToken: "x".repeat(1024), sessionTtlSeconds: 31_536_000, loginMaxAttempts: 1_000_000, loginWindowSeconds: 86_400 })).not.toThrow();
    expect(() => setup({ accessToken: "é".repeat(16) })).not.toThrow();
    expect(() => setup({ accessToken: "é".repeat(513) })).toThrow(AccessControlError);
  });

  it("should validate fixed error messages and retry-after presence", () => {
    expect(new AccessControlError("invalid-token").message).toBe("Access token is invalid.");
    expect(new AccessControlError("login-rate-limited", 1).retryAfterSeconds).toBe(1);
    expect(() => new AccessControlError("login-rate-limited")).toThrow(TypeError);
    expect(() => new AccessControlError("login-rate-limited", 0)).toThrow(TypeError);
    expect(() => new AccessControlError("invalid-token", 1)).toThrow(TypeError);
  });
});

describe("session lifecycle", () => {
  it("should issue independent canonical secrets and persist only lowercase hashes", async () => {
    const { access, store } = await setup();
    const first = await access.login(TOKEN);
    const second = await access.login(TOKEN);
    for (const issued of [first, second]) {
      expect(issued.opaqueSession).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(issued.csrfSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(issued.opaqueSession).not.toBe(issued.csrfSecret);
      expect(issued.expiresAt).toBe("2026-01-01T00:01:00.000Z");
      const stored = store.records.get(hash(issued.opaqueSession));
      expect(stored).toEqual({
        sessionHash: hash(issued.opaqueSession),
        csrfSecretHash: hash(issued.csrfSecret),
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:01:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(JSON.stringify(stored)).not.toContain(issued.opaqueSession);
      expect(JSON.stringify(stored)).not.toContain(issued.csrfSecret);
    }
    expect(first.opaqueSession).not.toBe(second.opaqueSession);
    expect(first.csrfSecret).not.toBe(second.csrfSecret);
  });

  it("should reject an incorrect token without store work or raw values in errors", async () => {
    const { access, store } = setup();
    const presented = "incorrect-token-sentinel".padEnd(32, "x");
    await expect(access.login(presented)).rejects.toMatchObject({ code: "invalid-token", message: "Access token is invalid." });
    expect(store.records.size).toBe(0);
    expect(store.calls).toEqual([]);
    await access.login(presented).catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain(presented);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    });
  });

  it("should propagate insertion failure and return no issued session", async () => {
    const failure = new Error("insert failed");
    const store = new MemoryStore();
    store.insert = () => { throw failure; };
    const clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const access = createAccessControl({ accessToken: TOKEN, store, clock, sessionTtlSeconds: 60, loginMaxAttempts: 2, loginWindowSeconds: 10 });
    await expect(access.login(TOKEN)).rejects.toBe(failure);
  });

  it("should authenticate with advanced last use and return an independent clone", async () => {
    const { access, store, clock } = setup();
    const issued = await access.login(TOKEN);
    clock.advance(1_000);
    const authenticated = await access.authenticate(issued.opaqueSession);
    expect(authenticated?.lastUsedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(authenticated?.expiresAt).toBe(issued.expiresAt);
    authenticated!.lastUsedAt = "mutated";
    expect(store.records.get(hash(issued.opaqueSession))?.lastUsedAt).toBe("2026-01-01T00:00:01.000Z");
  });

  it("should preserve last use when wall time moves backward", async () => {
    let wallMs = Date.parse("2026-01-01T00:00:00.000Z");
    let monotonicMs = 0;
    const clock = { now: () => new Date(wallMs), monotonicNowMs: () => monotonicMs };
    const store = new MemoryStore();
    const access = createAccessControl({ accessToken: TOKEN, store, clock, sessionTtlSeconds: 60, loginMaxAttempts: 10, loginWindowSeconds: 300 });
    const issued = await access.login(TOKEN);
    wallMs += 2_000; monotonicMs += 2_000;
    await access.authenticate(issued.opaqueSession);
    wallMs -= 1_000; monotonicMs += 1_000;
    expect((await access.authenticate(issued.opaqueSession))?.lastUsedAt).toBe("2026-01-01T00:00:02.000Z");
  });

  it("should reject malformed missing and exactly expired sessions without touching them", async () => {
    const { access, store, clock } = setup();
    const issued = await access.login(TOKEN);
    expect(await access.authenticate("not-a-session")).toBeUndefined();
    expect(await access.authenticate("A".repeat(43))).toBeUndefined();
    clock.advance(60_000);
    expect(await access.authenticate(issued.opaqueSession)).toBeUndefined();
    expect(store.records.get(hash(issued.opaqueSession))?.lastUsedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("should revoke only the presented session and make repeated logout a no-op", async () => {
    const { access, store, clock } = setup();
    const first = await access.login(TOKEN);
    const second = await access.login(TOKEN);
    clock.advance(1_000);
    await access.logout(first.opaqueSession);
    await access.logout(first.opaqueSession);
    expect(store.records.get(hash(first.opaqueSession))?.revokedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(await access.authenticate(first.opaqueSession)).toBeUndefined();
    expect(await access.authenticate(second.opaqueSession)).toBeDefined();
    await access.logout("malformed");
    await access.logout("A".repeat(43));
  });

  it("should revoke an existing expired session on logout", async () => {
    const { access, store, clock } = setup();
    const issued = await access.login(TOKEN);
    clock.advance(60_000);
    await access.logout(issued.opaqueSession);
    expect(store.records.get(hash(issued.opaqueSession))?.revokedAt).toBe("2026-01-01T00:01:00.000Z");
  });
});

describe("CSRF", () => {
  it("should verify only the matching secret on an unexpired unrevoked snapshot", async () => {
    const { access, clock } = setup();
    const issued = await access.login(TOKEN);
    const session = (await access.authenticate(issued.opaqueSession))!;
    expect(await access.verifyCsrf(session, issued.csrfSecret)).toBe(true);
    expect(await access.verifyCsrf(session, "A".repeat(43))).toBe(false);
    expect(await access.verifyCsrf(session, session.csrfSecretHash)).toBe(false);
    expect(await access.verifyCsrf(session, "bad")).toBe(false);
    clock.advance(60_000);
    expect(await access.verifyCsrf(session, issued.csrfSecret)).toBe(false);
  });

  it("should fail closed for revoked or malformed snapshots", async () => {
    const { access } = setup();
    const issued = await access.login(TOKEN);
    const session = (await access.authenticate(issued.opaqueSession))!;
    expect(await access.verifyCsrf({ ...session, revokedAt: session.lastUsedAt }, issued.csrfSecret)).toBe(false);
    expect(await access.verifyCsrf({ ...session, csrfSecretHash: "X".repeat(64) }, issued.csrfSecret)).toBe(false);
    expect(await access.verifyCsrf({ ...session, expiresAt: "invalid" }, issued.csrfSecret)).toBe(false);
  });
});

describe("throttling", () => {
  it("should reserve attempts before concurrent digest completion", async () => {
    const { access, store } = setup({ loginMaxAttempts: 2 });
    const attempts = [access.login(TOKEN), access.login(TOKEN), access.login(TOKEN)];
    await expect(attempts[2]).rejects.toMatchObject({ code: "login-rate-limited", retryAfterSeconds: 300 });
    await Promise.all(attempts.slice(0, 2));
    expect(store.records.size).toBe(2);
  });

  it("should count valid and invalid attempts and reset at the exact monotonic boundary", async () => {
    const { access, clock } = setup({ loginMaxAttempts: 2, loginWindowSeconds: 2 });
    await expect(access.login("bad")).rejects.toMatchObject({ code: "invalid-token" });
    await access.login(TOKEN);
    clock.advance(1_001);
    await expect(access.login(TOKEN)).rejects.toMatchObject({ code: "login-rate-limited", retryAfterSeconds: 1 });
    clock.advance(999);
    await access.login(TOKEN);
  });

  it("should keep independent instance throttles", async () => {
    const first = setup({ loginMaxAttempts: 1 });
    const second = setup({ loginMaxAttempts: 1 });
    await first.access.login(TOKEN);
    await expect(first.access.login(TOKEN)).rejects.toMatchObject({ code: "login-rate-limited" });
    await second.access.login(TOKEN);
  });
});
