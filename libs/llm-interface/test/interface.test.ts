import { describe, expect, it } from "vitest";
import * as interfaceModule from "../src/index.js";
import type {
  LlmError,
  LlmPort,
  LlmRequest,
  LlmResult,
} from "../src/index.js";

class ExampleLlmError extends Error implements LlmError {
  readonly category = "provider" as const;
  readonly code = "provider-unavailable";
  readonly attempts = [];
  readonly retryable = true;
}

const request: LlmRequest<{ score: number }> = {
  purpose: "recommendation",
  model: "example-model",
  instructions: "Return a score.",
  input: { title: "Story" },
  outputSchema: {
    type: "object",
    properties: { score: { type: "number" } },
    required: ["score"],
    additionalProperties: false,
  },
  parseOutput: (value) => ({ score: (value as { score: number }).score }),
  capturePayload: false,
};

const port: LlmPort = {
  async generate<T>(current: LlmRequest<T>): Promise<LlmResult<T>> {
    return { value: current.parseOutput({ score: 0.8 }), attempts: [] };
  },
};

describe("llm-interface", () => {
  it("should preserve generic parser results through a structural port", async () => {
    await expect(port.generate(request)).resolves.toEqual({
      value: { score: 0.8 },
      attempts: [],
    });
  });

  it("should support Error-compatible structured failures", () => {
    const error: LlmError = new ExampleLlmError("Provider unavailable.");
    expect(error).toBeInstanceOf(Error);
    expect(error.category).toBe("provider");
  });

  it("should emit no runtime values", () => {
    expect(Object.keys(interfaceModule)).toEqual([]);
  });
});
