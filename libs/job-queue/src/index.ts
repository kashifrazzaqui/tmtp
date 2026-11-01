import { randomUUID } from "node:crypto";
import type { Clock } from "@tmtp/clock";
import type { Database, Migration } from "@tmtp/database";
import { IsoDateTimeSchema } from "@tmtp/domain";
import type { DiagnosticError, Job, JobStatus } from "@tmtp/domain";

export interface JobPayloadCodec {
  kind: string;
  currentVersion: number;
  decode(payload: unknown, sourceVersion: number): unknown;
}
export interface JobEnqueue {
  kind: string;
  payload: unknown;
  payloadSchemaVersion: number;
  dedupeKey?: string;
  runAfter: string;
}
export interface JobEnqueueResult { job: Job; inserted: boolean; }
export type JobClaimResult = { status: "leased"; job: Job } | { status: "rejected"; job: Job } | { status: "idle" };
export interface JobFailure { code: string; message: string; retryable: boolean; }
export type JobQueueErrorCode =
  | "unknown-kind"
  | "invalid-payload"
  | "unsupported-payload-version"
  | "job-not-found"
  | "lease-lost"
  | "invalid-transition";

const ERROR_MESSAGES: Record<JobQueueErrorCode, string> = {
  "unknown-kind": "Job kind is unknown.",
  "invalid-payload": "Job payload is invalid.",
  "unsupported-payload-version": "Job payload version is unsupported.",
  "job-not-found": "Job was not found.",
  "lease-lost": "Job lease was lost.",
  "invalid-transition": "Job transition is invalid.",
};

export class JobQueueError extends Error {
  override readonly name = "JobQueueError" as const;
  readonly kind?: string;
  readonly jobId?: string;
  override readonly cause?: unknown;
  constructor(readonly code: JobQueueErrorCode, details: { kind?: string; jobId?: string; cause?: unknown } = {}) {
    super(ERROR_MESSAGES[code]);
    if (details.kind !== undefined) this.kind = details.kind;
    if (details.jobId !== undefined) this.jobId = details.jobId;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

export interface JobQueueOptions {
  database: Database;
  clock: Clock;
  codecs: readonly JobPayloadCodec[];
  leaseMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  batchSize: number;
}
export interface JobListQuery {
  status?: JobStatus;
  kind?: string;
  after?: JobCursorPosition;
  limit: number;
}
export interface JobCursorPosition { createdAt: string; id: string; }
export interface DiagnosticJobCursor { occurredAt: string; id: string; }
export interface JobQueue {
  enqueue(job: JobEnqueue): JobEnqueueResult;
  get(jobId: string): Job | undefined;
  claim(kinds: readonly string[]): JobClaimResult;
  renew(jobId: string, leaseToken: string): Job;
  complete(jobId: string, leaseToken: string): void;
  fail(jobId: string, leaseToken: string, failure: JobFailure): void;
  recoverExpired(): number;
  list(query: JobListQuery): Job[];
  listDiagnosticErrors(after: DiagnosticJobCursor | undefined, limit: number): DiagnosticError[];
}

export const jobQueueMigrations: Migration[] = [{
  id: "0020_job_queue",
  sql: `
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      payload_schema_version INTEGER NOT NULL,
      dedupe_key TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','leased','done','failed')),
      run_after TEXT NOT NULL,
      lease_token TEXT,
      lease_expires_at TEXT,
      attempts INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      last_error_code TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE UNIQUE INDEX jobs_active_dedupe
      ON jobs(kind, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status IN ('queued','leased');
    CREATE INDEX jobs_claim ON jobs(status, run_after, created_at, id);
    CREATE INDEX jobs_lease_expiry ON jobs(status, lease_expires_at, id);
    CREATE INDEX jobs_list_keyset ON jobs(created_at DESC, id DESC);
    CREATE INDEX jobs_diagnostic_errors ON jobs(status, updated_at DESC, id DESC);
  `,
}];

interface JobRow {
  id: string;
  kind: string;
  payload: string;
  payload_schema_version: number;
  dedupe_key: string | null;
  status: JobStatus;
  run_after: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  attempts: number;
  max_attempts: number;
  last_error_code: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapRow(row: JobRow): Job {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = row.payload;
  }
  return {
    id: row.id,
    kind: row.kind,
    payload,
    payloadSchemaVersion: row.payload_schema_version,
    ...(row.dedupe_key === null ? {} : { dedupeKey: row.dedupe_key }),
    status: row.status,
    runAfter: row.run_after,
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function safeInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

export function createJobQueue(options: JobQueueOptions): JobQueue {
  if (
    options === null || typeof options !== "object" ||
    !safeInteger(options.leaseMs, 1_000) || !safeInteger(options.maxAttempts, 1) ||
    !safeInteger(options.backoffBaseMs, 0) || !safeInteger(options.backoffMaxMs, options.backoffBaseMs) ||
    !safeInteger(options.batchSize, 1) || !Array.isArray(options.codecs)
  ) throw new TypeError("Invalid job-queue options.");
  const codecs = new Map<string, JobPayloadCodec>();
  for (const codec of options.codecs) {
    if (
      codec === null || typeof codec !== "object" || typeof codec.kind !== "string" || codec.kind === "" ||
      !safeInteger(codec.currentVersion, 1) || typeof codec.decode !== "function" || codecs.has(codec.kind)
    ) throw new TypeError("Invalid job payload codec.");
    codecs.set(codec.kind, { ...codec });
  }
  const { database, clock, leaseMs, maxAttempts, backoffBaseMs, backoffMaxMs, batchSize } = options;
  const now = () => clock.now().toISOString();
  const byId = (jobId: string): JobRow | undefined => database.queryOne<JobRow>("SELECT * FROM jobs WHERE id = ?", [jobId]);
  const leaseLost = (jobId: string): never => { throw new JobQueueError("lease-lost", { jobId }); };
  const backoff = (attempts: number): number => Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, attempts - 1));

  function decode(codec: JobPayloadCodec, payload: unknown, version: number): unknown {
    try {
      return codec.decode(payload, version);
    } catch (error) {
      throw new JobQueueError("invalid-payload", { kind: codec.kind, cause: error });
    }
  }

  function serialize(payload: unknown, kind: string): string {
    try {
      const serialized = JSON.stringify(payload);
      if (serialized === undefined) throw new TypeError("Payload is not JSON serializable.");
      return serialized;
    } catch (error) {
      throw new JobQueueError("invalid-payload", { kind, cause: error });
    }
  }

  function enqueue(input: JobEnqueue): JobEnqueueResult {
    if (input === null || typeof input !== "object" || typeof input.kind !== "string") {
      throw new JobQueueError("unknown-kind");
    }
    const codec = codecs.get(input.kind);
    if (codec === undefined) throw new JobQueueError("unknown-kind", { kind: input.kind });
    if (input.payloadSchemaVersion !== codec.currentVersion) {
      throw new JobQueueError("unsupported-payload-version", { kind: input.kind });
    }
    if (!IsoDateTimeSchema.safeParse(input.runAfter).success || (input.dedupeKey !== undefined && input.dedupeKey === "")) {
      throw new JobQueueError("invalid-transition", { kind: input.kind });
    }
    const decoded = decode(codec, input.payload, input.payloadSchemaVersion);
    const payload = serialize(decoded, input.kind);
    return database.transaction(() => {
      if (input.dedupeKey !== undefined) {
        const existing = database.queryOne<JobRow>(
          "SELECT * FROM jobs WHERE kind = ? AND dedupe_key = ? AND status IN ('queued','leased')",
          [input.kind, input.dedupeKey],
        );
        if (existing !== undefined) return { job: mapRow(existing), inserted: false };
      }
      const timestamp = now();
      const id = `job_${randomUUID()}`;
      database.execute(`INSERT INTO jobs (
        id, kind, payload, payload_schema_version, dedupe_key, status, run_after,
        attempts, max_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?)`, [
        id, input.kind, payload, codec.currentVersion, input.dedupeKey ?? null, input.runAfter,
        maxAttempts, timestamp, timestamp,
      ]);
      return { job: mapRow(byId(id)!), inserted: true };
    });
  }

  function get(jobId: string): Job | undefined {
    const row = byId(jobId);
    return row === undefined ? undefined : mapRow(row);
  }

  function claim(kinds: readonly string[]): JobClaimResult {
    if (!Array.isArray(kinds) || kinds.length === 0) return { status: "idle" };
    return database.transaction(() => {
      const timestamp = now();
      const placeholders = kinds.map(() => "?").join(",");
      const row = database.queryOne<JobRow>(`SELECT * FROM jobs
        WHERE status = 'queued' AND kind IN (${placeholders}) AND run_after <= ? AND attempts < max_attempts
        ORDER BY created_at ASC, id ASC LIMIT 1`, [...kinds, timestamp]);
      if (row === undefined) return { status: "idle" };

      let decoded: unknown;
      let codec: JobPayloadCodec | undefined;
      try {
        codec = codecs.get(row.kind);
        if (codec === undefined) throw new JobQueueError("unknown-kind", { kind: row.kind });
        const payload = JSON.parse(row.payload) as unknown;
        decoded = decode(codec, payload, row.payload_schema_version);
      } catch {
        const changed = database.execute(`UPDATE jobs SET
          status = 'failed', lease_token = NULL, lease_expires_at = NULL,
          last_error_code = 'invalid-payload', last_error = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'`, [ERROR_MESSAGES["invalid-payload"], timestamp, timestamp, row.id]);
        if (changed.changes !== 1) return leaseLost(row.id);
        return { status: "rejected", job: mapRow(byId(row.id)!) };
      }

      const payload = serialize(decoded, codec.kind);
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(clock.now().getTime() + leaseMs).toISOString();
      const changed = database.execute(`UPDATE jobs SET
        status = 'leased', payload = ?, payload_schema_version = ?, lease_token = ?, lease_expires_at = ?,
        attempts = attempts + 1, updated_at = ?, completed_at = NULL
        WHERE id = ? AND status = 'queued' AND attempts = ?`, [
        payload, codec.currentVersion, leaseToken, leaseExpiresAt, timestamp, row.id, row.attempts,
      ]);
      if (changed.changes !== 1) return leaseLost(row.id);
      return { status: "leased", job: mapRow(byId(row.id)!) };
    });
  }

  function renew(jobId: string, leaseToken: string): Job {
    return database.transaction(() => {
      const timestamp = now();
      const leaseExpiresAt = new Date(clock.now().getTime() + leaseMs).toISOString();
      const changed = database.execute(
        "UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND status = 'leased'",
        [leaseExpiresAt, timestamp, jobId, leaseToken],
      );
      if (changed.changes !== 1) return leaseLost(jobId);
      return mapRow(byId(jobId)!);
    });
  }

  function complete(jobId: string, leaseToken: string): void {
    database.transaction(() => {
      const timestamp = now();
      const changed = database.execute(`UPDATE jobs SET
        status = 'done', lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
        WHERE id = ? AND lease_token = ? AND status = 'leased'`, [timestamp, timestamp, jobId, leaseToken]);
      if (changed.changes !== 1) leaseLost(jobId);
    });
  }

  function fail(jobId: string, leaseToken: string, failure: JobFailure): void {
    if (
      failure === null || typeof failure !== "object" || typeof failure.code !== "string" || failure.code === "" ||
      typeof failure.message !== "string" || typeof failure.retryable !== "boolean"
    ) throw new JobQueueError("invalid-transition", { jobId });
    database.transaction(() => {
      const row = byId(jobId);
      if (row === undefined || row.status !== "leased" || row.lease_token !== leaseToken) return leaseLost(jobId);
      const timestamp = now();
      const message = failure.message.slice(0, 2_000);
      if (failure.retryable && row.attempts < row.max_attempts) {
        const runAfter = new Date(clock.now().getTime() + backoff(row.attempts)).toISOString();
        database.execute(`UPDATE jobs SET status = 'queued', run_after = ?, lease_token = NULL, lease_expires_at = NULL,
          last_error_code = ?, last_error = ?, completed_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ? AND status = 'leased'`, [
          runAfter, failure.code, message, timestamp, jobId, leaseToken,
        ]);
      } else {
        database.execute(`UPDATE jobs SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
          last_error_code = ?, last_error = ?, completed_at = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND status = 'leased'`, [
          failure.code, message, timestamp, timestamp, jobId, leaseToken,
        ]);
      }
    });
  }

  function recoverExpired(): number {
    return database.transaction(() => {
      const timestamp = now();
      const rows = database.query<JobRow>(`SELECT * FROM jobs
        WHERE status = 'leased' AND lease_expires_at <= ? ORDER BY lease_expires_at ASC, id ASC LIMIT ?`,
      [timestamp, batchSize]);
      for (const row of rows) {
        if (row.attempts >= row.max_attempts) {
          database.execute(`UPDATE jobs SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
            last_error_code = 'attempts-exhausted', last_error = 'Job attempts are exhausted.', completed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'leased'`, [timestamp, timestamp, row.id]);
        } else {
          const runAfter = new Date(clock.now().getTime() + backoff(row.attempts)).toISOString();
          database.execute(`UPDATE jobs SET status = 'queued', run_after = ?, lease_token = NULL, lease_expires_at = NULL,
            last_error_code = 'lease-expired', last_error = 'Job lease expired.', completed_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'leased'`, [runAfter, timestamp, row.id]);
        }
      }
      return rows.length;
    });
  }

  function list(query: JobListQuery): Job[] {
    if (
      query === null || typeof query !== "object" || !safeInteger(query.limit, 1) || query.limit > batchSize ||
      (query.status !== undefined && !["queued", "leased", "done", "failed"].includes(query.status)) ||
      (query.kind !== undefined && query.kind === "") ||
      (query.after !== undefined && (!IsoDateTimeSchema.safeParse(query.after.createdAt).success || query.after.id === ""))
    ) throw new JobQueueError("invalid-transition");
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.status !== undefined) { conditions.push("status = ?"); parameters.push(query.status); }
    if (query.kind !== undefined) { conditions.push("kind = ?"); parameters.push(query.kind); }
    if (query.after !== undefined) {
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(query.after.createdAt, query.after.createdAt, query.after.id);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    return database.query<JobRow>(`SELECT * FROM jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, [...parameters, query.limit]).map(mapRow);
  }

  function listDiagnosticErrors(after: DiagnosticJobCursor | undefined, limit: number): DiagnosticError[] {
    if (
      !safeInteger(limit, 1) || limit > batchSize ||
      (after !== undefined && (!IsoDateTimeSchema.safeParse(after.occurredAt).success || !/^job:.+/.test(after.id)))
    ) throw new JobQueueError("invalid-transition");
    const parameters: Array<string | number> = [];
    let cursor = "";
    if (after !== undefined) {
      cursor = "AND (updated_at < ? OR (updated_at = ? AND ('job:' || id) < ?))";
      parameters.push(after.occurredAt, after.occurredAt, after.id);
    }
    return database.query<JobRow>(`SELECT * FROM jobs
      WHERE status = 'failed' AND last_error_code IS NOT NULL ${cursor}
      ORDER BY updated_at DESC, ('job:' || id) DESC LIMIT ?`, [...parameters, limit]).map((row) => ({
      id: `job:${row.id}`,
      code: row.last_error_code!,
      component: "job-queue",
      occurredAt: row.updated_at,
      jobId: row.id,
    }));
  }

  return { enqueue, get, claim, renew, complete, fail, recoverExpired, list, listDiagnosticErrors };
}
