import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

const POLLUTION_KEY = "__personalReaderCliReviewPolluted__";

afterEach(() => {
  vi.restoreAllMocks();
  delete (Object.prototype as Record<string, unknown>)[POLLUTION_KEY];
  delete (Object.prototype as Record<string, unknown>).polluted;
});

async function runAssignment(assignment: string): Promise<{ code: number; record: Record<string, unknown> }> {
  let output = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const code = await runCli(["doctor", "--set", assignment]);
  return { code, record: JSON.parse(output) as Record<string, unknown> };
}

describe("CLI assignment security review regressions", () => {
  it.each([
    `__proto__.${POLLUTION_KEY}=true`,
    `constructor.prototype.${POLLUTION_KEY}=true`,
    `prototype.${POLLUTION_KEY}=true`,
    "nested.__proto__.polluted=true",
    "__proto__=true",
    "constructor=true",
    "prototype=true",
  ])("should reject dangerous --set path segments in %s", async (assignment) => {
    const result = await runAssignment(assignment);

    expect(result.code).toBe(1);
    expect(result.record).toMatchObject({
      message: "personal-reader.startup.failed",
      check: "startup",
    });
    expect(result.record).not.toHaveProperty("issues");
    expect(Object.hasOwn(Object.prototype, POLLUTION_KEY)).toBe(false);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});
