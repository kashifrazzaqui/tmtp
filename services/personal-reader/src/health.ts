import type { Database } from "@tmtp/database";
import { DatabaseError } from "@tmtp/database";
import type { Clock } from "@tmtp/clock";
import type { LlmPort, LlmRequest, LlmResult } from "@tmtp/llm-interface";
import type {
  HealthInput,
  IntegrationInput,
  ReadinessInput,
  ReadinessReason,
} from "@tmtp/diagnostics";

type LocalName = "configuration" | "sqlite" | "migrations" | "workers";
export type IntegrationName = "llm" | "hnPublic" | "hnAccount" | "article";

function check(ready: boolean, reason: ReadinessReason): { ready: boolean; reason: ReadinessReason } {
  return { ready, reason };
}

export class LocalHealthState {
  private configuration = check(false, "configuration-not-loaded");
  private sqlite = check(false, "database-unavailable");
  private migrations = check(false, "migrations-pending");
  private workers = check(false, "workers-starting");

  configurationLoaded(): void { this.configuration = check(true, "ok"); }
  configurationInvalid(): void { this.configuration = check(false, "configuration-invalid"); }
  sqliteReady(): void { this.sqlite = check(true, "ok"); }
  sqliteFailed(reason: "database-unavailable" | "integrity-check-failed" = "database-unavailable"): void {
    this.sqlite = check(false, reason);
  }
  migrationsReady(): void { this.migrations = check(true, "ok"); }
  migrationsFailed(error: unknown): void {
    const reason = error instanceof DatabaseError && error.migrationReason === "checksum-mismatch"
      ? "migration-checksum-mismatch" : "migration-failed";
    this.migrations = check(false, reason);
  }
  workersReady(): void { this.workers = check(true, "ok"); }
  workersStopped(): void { this.workers = check(false, "workers-stopped"); }
  workersFailed(): void { this.workers = check(false, "worker-failed"); }

  readiness(database?: Database): ReadinessInput {
    if (database !== undefined) {
      try {
        if (!database.isOpen() || database.queryOne<{ ok: number }>("SELECT 1 AS ok")?.ok !== 1) {
          this.sqliteFailed();
        }
      } catch {
        this.sqliteFailed();
      }
    }
    return {
      configuration: { ...this.configuration },
      sqlite: { ...this.sqlite },
      migrations: { ...this.migrations },
      workers: { ...this.workers },
    };
  }

  isLocallyReady(database?: Database): boolean {
    const value = this.readiness(database);
    return (["configuration", "sqlite", "migrations", "workers"] as const).every((name: LocalName) => value[name].ready);
  }
}

export class IntegrationHealthState {
  private readonly values: Record<IntegrationName, IntegrationInput>;

  constructor(accountConfigured: boolean) {
    this.values = {
      llm: { configured: true, availability: "unknown", reason: "not-checked" },
      hnPublic: { configured: true, availability: "unknown", reason: "not-checked" },
      hnAccount: accountConfigured
        ? { configured: true, availability: "unknown", reason: "not-checked" }
        : { configured: false, availability: "unknown", reason: "not-configured" },
      article: { configured: true, availability: "unknown", reason: "not-checked" },
    };
  }

  available(name: IntegrationName, observedAt: string): void {
    this.values[name] = { configured: true, availability: "available", reason: "ok", observedAt };
  }

  failed(name: IntegrationName, error: unknown, observedAt: string): void {
    if (!this.values[name].configured) return;
    const code = error !== null && typeof error === "object"
      ? "dependencyCode" in error && typeof error.dependencyCode === "string" ? error.dependencyCode
        : "code" in error && typeof error.code === "string" ? error.code : ""
      : "";
    const category = error !== null && typeof error === "object" && "category" in error && typeof error.category === "string"
      ? error.category : "";
    const reason = code === "timeout" || code === "dns-timeout" || code === "attempt-timeout" || code === "provider-request-timeout"
      ? "timeout"
      : code === "rate-limited" || category === "rate-limit" ? "rate-limited"
        : code === "session-expired" || code === "username-mismatch" || code === "provider-authentication" ? "authentication-failed"
          : code === "invalid-response" || code === "parse-failed" || category === "invalid-output" ? "invalid-response"
            : name === "article" && (code === "extraction-failed" || code === "empty-content" || code === "source-too-large")
              ? "extraction-failed"
              : name === "article" ? "fetch-failed" : "connection-failed";
    this.values[name] = { configured: true, availability: "degraded", reason, observedAt };
  }

  input(local: ReadinessInput): HealthInput {
    return {
      ...local,
      llm: { ...this.values.llm },
      hnPublic: { ...this.values.hnPublic },
      hnAccount: { ...this.values.hnAccount },
      article: { ...this.values.article },
    };
  }
}

export function observeLlm(llm: LlmPort, integrations: IntegrationHealthState, clock: Clock): LlmPort {
  return {
    async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      try {
        const result = await llm.generate(request);
        if (!request.signal?.aborted) integrations.available("llm", clock.now().toISOString());
        return result;
      } catch (error) {
        if (!request.signal?.aborted) integrations.failed("llm", error, clock.now().toISOString());
        throw error;
      }
    },
  };
}
