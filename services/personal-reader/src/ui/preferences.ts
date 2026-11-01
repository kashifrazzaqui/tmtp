import type { PreferenceKind, PreferenceRuleDto } from "./types.js";
import { createId } from "./utils.js";

export function normalizePreferenceValue(kind: PreferenceKind, value: string): string {
  let normalized: string;
  if (kind === "topic" || kind === "keyword") {
    normalized = (value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
  } else if (kind === "author") {
    normalized = value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  } else {
    const candidate = value.normalize("NFKC").toLowerCase().replace(/\.$/, "");
    if (candidate === "") throw new Error("Enter a domain.");
    let url: URL;
    try {
      url = new URL(`http://${candidate}`);
    } catch {
      throw new Error("Enter a valid domain without a path, port, or credentials.");
    }
    if (url.username !== "" || url.password !== "" || url.port !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.hostname === "") {
      throw new Error("Enter a valid domain without a path, port, or credentials.");
    }
    normalized = url.hostname;
  }
  if (normalized === "" || normalized.length > 128) throw new Error("Preference values must normalize to 1–128 characters.");
  return normalized;
}

export function newPreferenceRule(): PreferenceRuleDto {
  const now = new Date().toISOString();
  return {
    id: createId("rule"),
    kind: "topic",
    effect: "include",
    value: "",
    normalizedValue: "",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function validatePreferenceRules(rules: PreferenceRuleDto[]): string | undefined {
  const ids = new Set<string>();
  const triplets = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (rule.id === "" || rule.value.trim() === "") return `Rule ${index + 1} needs a value.`;
    let normalized: string;
    try {
      normalized = normalizePreferenceValue(rule.kind, rule.value);
    } catch (error) {
      return `Rule ${index + 1}: ${error instanceof Error ? error.message : "invalid value"}`;
    }
    if (rule.normalizedValue !== normalized) return `Rule ${index + 1} has an outdated normalized value. Edit it again before saving.`;
    if (ids.has(rule.id)) return `Rule ${index + 1} repeats a rule ID.`;
    const triplet = `${rule.kind}\0${rule.effect}\0${rule.normalizedValue}`;
    if (triplets.has(triplet)) return `Rule ${index + 1} duplicates another ${rule.kind} ${rule.effect} rule.`;
    ids.add(rule.id);
    triplets.add(triplet);
  }
  return undefined;
}
