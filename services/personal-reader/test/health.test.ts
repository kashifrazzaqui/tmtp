import { afterEach, describe, expect, it } from "vitest";
import { DatabaseError } from "@tmtp/database";
import { LocalHealthState } from "../src/health.js";
import { testGraph } from "./harness.js";
import type { TestGraph } from "./harness.js";

const active: TestGraph[] = [];
afterEach(async () => { while (active.length > 0) await active.pop()!.close(); });

describe("local readiness inputs", () => {
  it("should map migration reasons by the typed database field only", () => {
    const health = new LocalHealthState();
    health.migrationsFailed(new DatabaseError("migration", "arbitrary message", { retryable: false, migrationReason: "checksum-mismatch" }));
    expect(health.readiness().migrations).toEqual({ ready: false, reason: "migration-checksum-mismatch" });
    for (const migrationReason of ["invalid-order", "sql-failed", "invalid-migration"] as const) {
      health.migrationsFailed(new DatabaseError("migration", "checksum-mismatch in text only", { retryable: false, migrationReason }));
      expect(health.readiness().migrations).toEqual({ ready: false, reason: "migration-failed" });
    }
  });

  it("should keep liveness independent when SQLite and workers fail", async () => {
    const local = await testGraph();
    active.push(local);
    local.graph.health.workersFailed();
    local.graph.database.close();
    const ready = local.graph.diagnostics.readiness(local.graph.health.readiness(local.graph.database));
    expect(ready.status).toBe("not-ready");
    expect(ready.checks).toEqual([
      { name: "configuration", status: "pass", reason: "ok" },
      { name: "sqlite", status: "fail", reason: "database-unavailable" },
      { name: "migrations", status: "pass", reason: "ok" },
      { name: "workers", status: "fail", reason: "worker-failed" },
    ]);
    expect(local.graph.diagnostics.liveness()).toEqual({ generatedAt: "2026-01-02T03:04:05.000Z", status: "live" });
    const capabilities = local.graph.diagnostics.capabilities(local.graph.integrations.input(local.graph.health.readiness()));
    expect(capabilities).toMatchObject({ storedReading: { state: "unavailable" }, backgroundWork: { state: "unavailable" } });
  });
});
