import { IsoDateTimeSchema } from "@tmtp/domain";
import type { Clock } from "@tmtp/clock";
import { DiagnosticsError } from "./errors.js";
import type { CapabilitiesSnapshot, CapabilityReason, CapabilityStatus, HealthInput, IntegrationInput, LivenessSnapshot, ReadinessInput, ReadinessReason, ReadinessSnapshot } from "./types.js";

const READINESS_REASONS = new Set<ReadinessReason>(["ok", "configuration-not-loaded", "configuration-invalid", "database-unavailable", "integrity-check-failed", "migrations-pending", "migration-checksum-mismatch", "migration-failed", "workers-starting", "workers-stopped", "worker-failed"]);
const CAPABILITY_REASONS = new Set<CapabilityReason>(["ok", "not-configured", "not-checked", "configuration-invalid", "database-unavailable", "integrity-check-failed", "migrations-not-current", "workers-not-ready", "connection-failed", "authentication-failed", "rate-limited", "timeout", "invalid-response", "fetch-failed", "extraction-failed"]);
function validateReadiness(input: ReadinessInput): void {
  if (input === null || typeof input !== "object") throw new DiagnosticsError("invalid-input");
  for (const name of ["configuration", "sqlite", "migrations", "workers"] as const) {
    const check = input[name];
    if (check === null || typeof check !== "object" || typeof check.ready !== "boolean" ||
      !READINESS_REASONS.has(check.reason) || (check.ready ? check.reason !== "ok" : check.reason === "ok")) {
      throw new DiagnosticsError("invalid-input");
    }
  }
}
function validateIntegration(input: IntegrationInput): void {
  if (input === null || typeof input !== "object" || typeof input.configured !== "boolean" ||
    !["available", "degraded", "unavailable", "unknown"].includes(input.availability) || !CAPABILITY_REASONS.has(input.reason) ||
    (input.observedAt !== undefined && !IsoDateTimeSchema.safeParse(input.observedAt).success)) throw new DiagnosticsError("invalid-input");
  if (!input.configured) {
    if (input.availability !== "unknown" || input.reason !== "not-configured") throw new DiagnosticsError("invalid-input");
  } else if ((input.availability === "available") !== (input.reason === "ok")) throw new DiagnosticsError("invalid-input");
}
function localFailure(input: ReadinessInput, includeWorkers: boolean): CapabilityReason | undefined {
  const names = includeWorkers ? ["configuration", "sqlite", "migrations", "workers"] as const : ["configuration", "sqlite", "migrations"] as const;
  for (const name of names) {
    const check = input[name];
    if (check.ready) continue;
    if (name === "configuration") return "configuration-invalid";
    if (name === "sqlite") return check.reason === "integrity-check-failed" ? "integrity-check-failed" : "database-unavailable";
    if (name === "migrations") return "migrations-not-current";
    return "workers-not-ready";
  }
  return undefined;
}
function integration(input: IntegrationInput | undefined): CapabilityStatus {
  if (input === undefined) return { state: "disabled", reason: "not-configured" };
  if (!input.configured) return { state: "disabled", reason: "not-configured" };
  return { state: input.availability, reason: input.reason, ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }) };
}
export function liveness(clock: Clock): LivenessSnapshot { return { generatedAt: clock.now().toISOString(), status: "live" }; }
export function readiness(clock: Clock, input: ReadinessInput): ReadinessSnapshot {
  validateReadiness(input);
  const checks = (["configuration", "sqlite", "migrations", "workers"] as const).map((name) => ({
    name, status: input[name].ready ? "pass" as const : "fail" as const, reason: input[name].reason,
  }));
  return { generatedAt: clock.now().toISOString(), status: checks.every((check) => check.status === "pass") ? "ready" : "not-ready", checks };
}
export function capabilities(clock: Clock, input: HealthInput): CapabilitiesSnapshot {
  validateReadiness(input);
  validateIntegration(input.llm);
  validateIntegration(input.hnPublic);
  if (input.hnAccount !== undefined) validateIntegration(input.hnAccount);
  validateIntegration(input.article);
  const storedFailure = localFailure(input, false);
  const backgroundFailure = localFailure(input, true);
  return {
    generatedAt: clock.now().toISOString(),
    storedReading: storedFailure === undefined ? { state: "available", reason: "ok" } : { state: "unavailable", reason: storedFailure },
    backgroundWork: backgroundFailure === undefined ? { state: "available", reason: "ok" } : { state: "unavailable", reason: backgroundFailure },
    llmPersonalization: integration(input.llm),
    hnPublicCollection: integration(input.hnPublic),
    hnAccount: integration(input.hnAccount),
    freshArticleContent: integration(input.article),
  };
}
