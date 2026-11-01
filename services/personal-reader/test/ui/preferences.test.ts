import { describe, expect, it } from "vitest";
import { normalizePreferenceValue, validatePreferenceRules } from "../../src/ui/preferences.js";
import type { PreferenceRuleDto } from "../../src/ui/types.js";

function rule(overrides: Partial<PreferenceRuleDto> = {}): PreferenceRuleDto {
  return {
    id: "rule-1",
    kind: "topic",
    effect: "include",
    value: "Machine,   LEARNING",
    normalizedValue: "machine learning",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("preference normalization", () => {
  it("should match domain normalization examples", () => {
    expect(normalizePreferenceValue("topic", "  Machine,   LEARNING ")).toBe("machine learning");
    expect(normalizePreferenceValue("keyword", "Ｃ++")).toBe("c");
    expect(normalizePreferenceValue("author", "  ALICE\t  Example ")).toBe("alice example");
    expect(normalizePreferenceValue("author", "Alice-Example!")).toBe("alice-example!");
    expect(normalizePreferenceValue("domain", "BÜCHER.DE.")).toBe("xn--bcher-kva.de");
    expect(normalizePreferenceValue("domain", "127.0.0.1")).toBe("127.0.0.1");
    expect(normalizePreferenceValue("domain", "[::1]")).toBe("[::1]");
  });

  it("should reject invalid normalized and duplicate rules before transport", () => {
    expect(validatePreferenceRules([rule({ normalizedValue: "wrong" })])).toContain("outdated normalized value");
    expect(validatePreferenceRules([rule(), rule({ id: "rule-2" })])).toContain("duplicates");
    expect(validatePreferenceRules([rule({ kind: "domain", value: "example.com/path", normalizedValue: "" })])).toContain("valid domain");
    expect(validatePreferenceRules([rule()])).toBeUndefined();
  });
});
