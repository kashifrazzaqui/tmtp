import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixedClock } from "@tmtp/clock";
import type { FixedClock } from "@tmtp/clock";
import { migrate, openDatabase } from "@tmtp/database";
import type { Database } from "@tmtp/database";
import { JobSchema } from "@tmtp/domain";
import { describe, expect, it } from "vitest";
import { createJobQueue, jobQueueMigrations, JobQueueError } from "../src/index.js";
import type { JobPayloadCodec } from "../src/index.js";

const NOW = "2026-01-01T00:00:00.000Z";
const codec: JobPayloadCodec = {
  kind: "test",
  currentVersion: 2,
  decode(payload, sourceVersion) {
    if (sourceVersion === 1 && payload !== null && typeof payload === "object" && typeof (payload as { value?: unknown }).value === "string") {
      return { value: (payload as { value: string }).value, current: true };
    }
    if (sourceVersion === 2 && payload !== null && typeof payload === "object" && typeof (payload as { value?: unknown }).value === "string" && (payload as { current?: unknown }).current === true) {
      return { value: (payload as { value: string }).value, current: true };
    }
    throw new Error("unsafe codec detail");
  },
};
const otherCodec: JobPayloadCodec = {
  kind: "other", currentVersion: 1,
  decode: (payload) => payload,
};

function setup(options: { maxAttempts?: number; batchSize?: number; backoffBaseMs?: number } = {}) {
  const database = openDatabase({ path: ":memory:", busyTimeoutMs: 0, wal: false });
  migrate(database, jobQueueMigrations);
  const clock = createFixedClock(new Date(NOW));
  const queue = createJobQueue({
    database, clock, codecs: [codec, otherCodec], leaseMs: 10_000,
    maxAttempts: options.maxAttempts ?? 3,
    backoffBaseMs: options.backoffBaseMs ?? 1_000,
    backoffMaxMs: 10_000, batchSize: options.batchSize ?? 20,
  });
  return { database, clock, queue };
}
const enqueue = (queue: ReturnType<typeof setup>["queue"], value = "work", dedupeKey?: string) => queue.enqueue({
  kind: "test", payload: { value, current: true }, payloadSchemaVersion: 2,
  ...(dedupeKey === undefined ? {} : { dedupeKey }), runAfter: NOW,
});

describe("payloads enqueue and dedupe", () => {
  it("should validate current payloads and reject unknown kinds and versions without leaking values", () => {
    const { queue, database } = setup();
    try {
      const sentinel = "payload-secret-sentinel";
      expect(() => queue.enqueue({ kind: "unknown", payload: sentinel, payloadSchemaVersion: 1, runAfter: NOW }))
        .toThrowError(expect.objectContaining({ code: "unknown-kind" }));
      expect(() => queue.enqueue({ kind: "test", payload: sentinel, payloadSchemaVersion: 99, runAfter: NOW }))
        .toThrowError(expect.objectContaining({ code: "unsupported-payload-version" }));
      try {
        enqueue(queue, sentinel);
        queue.enqueue({ kind: "test", payload: { value: 4, current: true }, payloadSchemaVersion: 2, runAfter: NOW });
      } catch (error) {
        expect(error).toBeInstanceOf(JobQueueError);
        expect((error as JobQueueError).code).toBe("invalid-payload");
        expect(JSON.stringify(error)).not.toContain("unsafe codec detail");
      }
    } finally {
      database.close();
    }
  });

  it("should dedupe only active keys and join an outer transaction", () => {
    const { queue, database } = setup();
    try {
      expect(() => database.transaction(() => {
        enqueue(queue, "rolled-back", "rollback");
        throw new Error("rollback");
      })).toThrow("rollback");
      expect(queue.list({ limit: 20 })).toEqual([]);

      const first = enqueue(queue, "first", "same");
      const duplicate = enqueue(queue, "changed", "same");
      expect(duplicate).toEqual({ job: first.job, inserted: false });
      expect(duplicate.job.payload).toEqual({ value: "first", current: true });
      const claimed = queue.claim(["test"]);
      if (claimed.status !== "leased") throw new Error("Expected lease.");
      queue.complete(claimed.job.id, claimed.job.leaseToken!);
      const later = enqueue(queue, "later", "same");
      expect(later.inserted).toBe(true);
      expect(later.job.id).not.toBe(first.job.id);
    } finally {
      database.close();
    }
  });

  it("should reject duplicate codec registrations", () => {
    const { database, clock } = setup();
    try {
      expect(() => createJobQueue({ database, clock, codecs: [codec, codec], leaseMs: 1_000, maxAttempts: 1, backoffBaseMs: 0, backoffMaxMs: 0, batchSize: 1 })).toThrow(TypeError);
    } finally {
      database.close();
    }
  });
});

describe("claim and lease transitions", () => {
  it("should migrate a stored payload lease it and increment attempts exactly once", () => {
    const { queue, database } = setup();
    try {
      const inserted = enqueue(queue);
      database.execute("UPDATE jobs SET payload = ?, payload_schema_version = 1 WHERE id = ?", [JSON.stringify({ value: "work" }), inserted.job.id]);
      const claimed = queue.claim(["test"]);
      expect(claimed.status).toBe("leased");
      if (claimed.status !== "leased") return;
      expect(claimed.job).toMatchObject({ status: "leased", attempts: 1, payloadSchemaVersion: 2, payload: { value: "work", current: true } });
      expect(claimed.job.leaseToken).toBeDefined();
      expect(claimed.job.leaseExpiresAt).toBe("2026-01-01T00:00:10.000Z");
      expect(JobSchema.safeParse(claimed.job).success).toBe(true);
    } finally {
      database.close();
    }
  });

  it("should return idle for delayed or unrequested jobs without changing them", () => {
    const { queue, database, clock } = setup();
    try {
      const inserted = queue.enqueue({ kind: "test", payload: { value: "later", current: true }, payloadSchemaVersion: 2, runAfter: "2026-01-01T00:00:01.000Z" });
      expect(queue.claim(["test"])).toEqual({ status: "idle" });
      expect(queue.get(inserted.job.id)).toEqual(inserted.job);
      clock.advance(1_000);
      expect(queue.claim(["test"]).status).toBe("leased");
    } finally {
      database.close();
    }
  });

  it("should reject one poison row before leasing the next and preserve terminal state", () => {
    const { queue, database, clock } = setup();
    try {
      const poison = enqueue(queue, "poison");
      clock.advance(1_000);
      const valid = enqueue(queue, "valid");
      database.execute("UPDATE jobs SET payload = '{' WHERE id = ?", [poison.job.id]);
      const rejected = queue.claim(["test"]);
      expect(rejected.status).toBe("rejected");
      if (rejected.status !== "rejected") return;
      expect(rejected.job).toMatchObject({
        id: poison.job.id, status: "failed", attempts: 0,
        lastErrorCode: "invalid-payload", lastError: "Job payload is invalid.",
        updatedAt: "2026-01-01T00:00:01.000Z", completedAt: "2026-01-01T00:00:01.000Z",
      });
      expect(rejected.job.leaseToken).toBeUndefined();
      expect(rejected.job.leaseExpiresAt).toBeUndefined();
      expect(queue.get(poison.job.id)).toEqual(rejected.job);
      const leased = queue.claim(["test"]);
      expect(leased.status).toBe("leased");
      if (leased.status === "leased") expect(leased.job.id).toBe(valid.job.id);
      expect(queue.claim(["other"])).toEqual({ status: "idle" });
    } finally {
      database.close();
    }
  });

  it("should renew without another attempt and reject stale finalization", () => {
    const { queue, database, clock } = setup();
    try {
      enqueue(queue);
      const claimed = queue.claim(["test"]);
      if (claimed.status !== "leased") throw new Error("Expected lease.");
      clock.advance(1_000);
      const renewed = queue.renew(claimed.job.id, claimed.job.leaseToken!);
      expect(renewed.attempts).toBe(1);
      expect(renewed.leaseExpiresAt).toBe("2026-01-01T00:00:11.000Z");
      expect(() => queue.complete(claimed.job.id, "stale")).toThrowError(expect.objectContaining({ code: "lease-lost" }));
      queue.complete(claimed.job.id, claimed.job.leaseToken!);
      expect(queue.get(claimed.job.id)).toMatchObject({ status: "done", attempts: 1, completedAt: "2026-01-01T00:00:01.000Z" });
      expect(queue.get(claimed.job.id)?.leaseToken).toBeUndefined();
      expect(() => queue.renew(claimed.job.id, claimed.job.leaseToken!)).toThrowError(expect.objectContaining({ code: "lease-lost" }));
    } finally {
      database.close();
    }
  });

  it("should apply deterministic retry backoff and terminal exhaustion", () => {
    const { queue, database, clock } = setup({ maxAttempts: 2 });
    try {
      enqueue(queue);
      const first = queue.claim(["test"]);
      if (first.status !== "leased") throw new Error("Expected lease.");
      queue.fail(first.job.id, first.job.leaseToken!, { code: "upstream", message: "safe failure", retryable: true });
      expect(queue.get(first.job.id)).toMatchObject({ status: "queued", attempts: 1, runAfter: "2026-01-01T00:00:01.000Z", lastErrorCode: "upstream", lastError: "safe failure" });
      expect(queue.claim(["test"])).toEqual({ status: "idle" });
      clock.advance(1_000);
      const second = queue.claim(["test"]);
      if (second.status !== "leased") throw new Error("Expected second lease.");
      expect(second.job.attempts).toBe(2);
      queue.fail(second.job.id, second.job.leaseToken!, { code: "upstream", message: "safe failure", retryable: true });
      expect(queue.get(second.job.id)).toMatchObject({ status: "failed", attempts: 2, completedAt: "2026-01-01T00:00:01.000Z" });
    } finally {
      database.close();
    }
  });
});

describe("recovery and restart", () => {
  it("should recover bounded expired batches with stable codes and no extra attempts", () => {
    const { queue, database, clock } = setup({ maxAttempts: 2, batchSize: 1 });
    try {
      enqueue(queue, "one"); enqueue(queue, "two");
      const first = queue.claim(["test"]);
      if (first.status !== "leased") throw new Error("Expected lease.");
      clock.advance(10_000);
      expect(queue.recoverExpired()).toBe(1);
      expect(queue.get(first.job.id)).toMatchObject({ status: "queued", attempts: 1, lastErrorCode: "lease-expired" });
      expect(queue.recoverExpired()).toBe(0);
      clock.advance(1_000);
      const second = queue.claim(["test"]);
      if (second.status !== "leased") throw new Error("Expected lease.");
      clock.advance(10_000);
      expect(queue.recoverExpired()).toBe(1);
      expect(queue.get(second.job.id)).toMatchObject({ status: "failed", attempts: 2, lastErrorCode: "attempts-exhausted" });
    } finally {
      database.close();
    }
  });

  it("should recover a real reopened database and retain rejected terminal rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "tmtp-queue-"));
    const path = join(directory, "queue.db");
    const clock = createFixedClock(new Date(NOW));
    try {
      let database = openDatabase({ path, busyTimeoutMs: 0, wal: true });
      migrate(database, jobQueueMigrations);
      let queue = createJobQueue({ database, clock, codecs: [codec], leaseMs: 1_000, maxAttempts: 2, backoffBaseMs: 0, backoffMaxMs: 0, batchSize: 20 });
      const poison = enqueue(queue, "poison");
      database.execute("UPDATE jobs SET payload = '{' WHERE id = ?", [poison.job.id]);
      expect(queue.claim(["test"]).status).toBe("rejected");
      const valid = enqueue(queue, "valid");
      const claimed = queue.claim(["test"]);
      if (claimed.status !== "leased") throw new Error("Expected lease.");
      expect(claimed.job.id).toBe(valid.job.id);
      database.close();

      clock.advance(1_000);
      database = openDatabase({ path, busyTimeoutMs: 0, wal: true });
      migrate(database, jobQueueMigrations);
      queue = createJobQueue({ database, clock, codecs: [codec], leaseMs: 1_000, maxAttempts: 2, backoffBaseMs: 0, backoffMaxMs: 0, batchSize: 20 });
      expect(queue.get(poison.job.id)).toMatchObject({ status: "failed", attempts: 0, lastErrorCode: "invalid-payload" });
      expect(queue.recoverExpired()).toBe(1);
      expect(queue.get(valid.job.id)).toMatchObject({ status: "queued", attempts: 1, lastErrorCode: "lease-expired" });
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("job and diagnostic pages", () => {
  it("should use descending keyset pages with stable filters and no cursor secrets", () => {
    const { queue, database, clock } = setup();
    try {
      enqueue(queue, "one"); clock.advance(1_000); enqueue(queue, "two"); clock.advance(1_000); enqueue(queue, "three");
      const first = queue.list({ kind: "test", limit: 2 });
      expect(first).toHaveLength(2);
      expect(first.map((job) => job.payload)).toEqual([{ value: "three", current: true }, { value: "two", current: true }]);
      const cursor = { createdAt: first.at(-1)!.createdAt, id: first.at(-1)!.id };
      expect(JSON.stringify(cursor)).not.toContain("three");
      const second = queue.list({ kind: "test", after: cursor, limit: 2 });
      expect(second.map((job) => job.payload)).toEqual([{ value: "one", current: true }]);
      expect(queue.list({ status: "done", limit: 20 })).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("should project failed jobs into bounded diagnostic cursors without messages or payloads", () => {
    const { queue, database } = setup();
    try {
      const poison = enqueue(queue, "secret-payload");
      database.execute("UPDATE jobs SET payload = '{' WHERE id = ?", [poison.job.id]);
      queue.claim(["test"]);
      const first = queue.listDiagnosticErrors(undefined, 1);
      expect(first).toEqual([{
        id: `job:${poison.job.id}`, code: "invalid-payload", component: "job-queue",
        occurredAt: NOW, jobId: poison.job.id,
      }]);
      expect(JSON.stringify(first)).not.toContain("secret-payload");
      expect(JSON.stringify(first)).not.toContain("Job payload is invalid");
      expect(queue.listDiagnosticErrors({ occurredAt: first[0]!.occurredAt, id: first[0]!.id }, 1)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
