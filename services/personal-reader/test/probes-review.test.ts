import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalizationError } from "@tmtp/personalization";
import type { LlmCallAudit } from "@tmtp/llm-interface";
import { runCapabilityProbes } from "../src/probes.js";
import { testGraph } from "./harness.js";
import type { TestGraph } from "./harness.js";

const active: TestGraph[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (active.length > 0) await active.pop()!.close();
});

async function graph(): Promise<TestGraph> {
  const local = await testGraph({ debug: { enabled: true } });
  active.push(local);
  return local;
}

function malformedAudit(): LlmCallAudit {
  return {
    callId: "malformed-probe-audit",
    purpose: "connection-check",
    model: "test-model",
    requestHash: "not-a-sha256-digest",
    status: "provider-error",
    errorCode: "provider-error",
    usage: { latencyMs: 1 },
  };
}

describe("capability probe audit review regressions", () => {
  it.each(["resolved", "rejected"] as const)(
    "should report invalid-response without SQLite degradation for malformed %s audit evidence",
    async (outcome) => {
      const local = await graph();
      const generate = vi.spyOn(local.graph.llm, "generate");
      if (outcome === "resolved") {
        generate.mockResolvedValue({ value: { ok: true }, attempts: [malformedAudit()] });
      } else {
        generate.mockRejectedValue(Object.assign(new Error("provider failed"), {
          category: "provider",
          code: "provider-error",
          retryable: false,
          attempts: [malformedAudit()],
        }));
      }

      await expect(runCapabilityProbes(local.graph, local.graph.operations.signal)).resolves.toMatchObject({ llm: false });

      expect(local.graph.health.readiness().sqlite).toEqual({ ready: true, reason: "ok" });
      expect(local.graph.integrations.input(local.graph.health.readiness()).llm).toMatchObject({
        availability: "degraded",
        reason: "invalid-response",
      });
      expect(local.graph.diagnostics.debugSnapshot().llmCalls.value.items).toEqual([]);
    },
  );

  it("should retain SQLite degradation when audit persistence fails", async () => {
    const local = await graph();
    vi.spyOn(local.graph.llm, "generate").mockResolvedValue({ value: { ok: true }, attempts: [] });
    vi.spyOn(local.graph.personalization, "persistLlmAudits").mockRejectedValue(
      new PersonalizationError("audit-conflict"),
    );

    await expect(runCapabilityProbes(local.graph, local.graph.operations.signal)).resolves.toMatchObject({ llm: false });

    expect(local.graph.health.readiness().sqlite).toEqual({ ready: false, reason: "database-unavailable" });
    expect(local.graph.integrations.input(local.graph.health.readiness()).llm).toMatchObject({
      availability: "unknown",
      reason: "not-checked",
    });
  });
});
