import { createHash } from "node:crypto";
import Driver from "better-sqlite3";

export type SqlValue = null | string | number | bigint | Uint8Array;
export type SqlParameters = readonly SqlValue[];

export interface DatabaseConfig {
  path: string;
  busyTimeoutMs: number;
  wal: boolean;
}

export interface Migration {
  id: string;
  sql: string;
}

export interface ExecuteResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface IntegrityResult {
  ok: boolean;
  details: string[];
}

export interface Database {
  query<T = unknown>(sql: string, parameters?: SqlParameters): T[];
  queryOne<T = unknown>(sql: string, parameters?: SqlParameters): T | undefined;
  execute(sql: string, parameters?: SqlParameters): ExecuteResult;
  transaction<T>(work: () => T): T;
  integrityCheck(): IntegrityResult;
  isOpen(): boolean;
  close(): void;
}

export type DatabaseErrorCode =
  | "connection"
  | "constraint"
  | "busy"
  | "migration"
  | "integrity"
  | "closed"
  | "async-transaction"
  | "driver";

export type MigrationFailureReason =
  | "checksum-mismatch"
  | "invalid-order"
  | "sql-failed"
  | "invalid-migration";

interface DatabaseErrorOptions {
  retryable: boolean;
  migrationId?: string;
  migrationReason?: MigrationFailureReason;
  cause?: unknown;
}

export class DatabaseError extends Error {
  override readonly name = "DatabaseError" as const;
  readonly code: DatabaseErrorCode;
  readonly retryable: boolean;
  readonly migrationId?: string;
  readonly migrationReason?: MigrationFailureReason;
  override readonly cause?: unknown;

  constructor(code: DatabaseErrorCode, message: string, options: DatabaseErrorOptions) {
    super(message);
    this.code = code;
    this.retryable = options.retryable;
    if (options.migrationId !== undefined) this.migrationId = options.migrationId;
    if (options.migrationReason !== undefined) this.migrationReason = options.migrationReason;
    if (options.cause !== undefined) this.cause = options.cause;
    if ((code === "migration") !== (options.migrationReason !== undefined)) {
      throw new TypeError("Migration errors require exactly one migration reason.");
    }
  }
}

const connections = new WeakMap<Database, Driver.Database>();

function normalizeDriverError(error: unknown, message: string): unknown {
  if (error instanceof DatabaseError) return error;
  if (!(error instanceof Driver.SqliteError)) return error;
  const driverCode = error.code;
  if (driverCode.startsWith("SQLITE_CONSTRAINT")) {
    return new DatabaseError("constraint", message, { retryable: false, cause: error });
  }
  if (driverCode.startsWith("SQLITE_BUSY") || driverCode.startsWith("SQLITE_LOCKED")) {
    return new DatabaseError("busy", message, { retryable: true, cause: error });
  }
  return new DatabaseError("driver", message, { retryable: false, cause: error });
}

function migrationError(
  reason: MigrationFailureReason,
  message: string,
  migrationId?: string,
  cause?: unknown,
): DatabaseError {
  const options: DatabaseErrorOptions = { retryable: false, migrationReason: reason };
  if (migrationId !== undefined) options.migrationId = migrationId;
  if (cause !== undefined) options.cause = cause;
  return new DatabaseError("migration", message, options);
}

class SqliteDatabase implements Database {
  private open = true;

  constructor(private readonly native: Driver.Database) {
    connections.set(this, native);
  }

  private ensureOpen(): void {
    if (!this.open || !this.native.open) {
      throw new DatabaseError("closed", "Database connection is closed.", { retryable: false });
    }
  }

  query<T = unknown>(sql: string, parameters: SqlParameters = []): T[] {
    this.ensureOpen();
    try {
      return this.native.prepare(sql).all(...parameters) as T[];
    } catch (error) {
      throw normalizeDriverError(error, "Database query failed.");
    }
  }

  queryOne<T = unknown>(sql: string, parameters: SqlParameters = []): T | undefined {
    const rows = this.query<T>(sql, parameters);
    if (rows.length > 1) {
      throw new DatabaseError("driver", "Query returned more than one row.", { retryable: false });
    }
    return rows[0];
  }

  execute(sql: string, parameters: SqlParameters = []): ExecuteResult {
    this.ensureOpen();
    try {
      const result = this.native.prepare(sql).run(...parameters);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    } catch (error) {
      throw normalizeDriverError(error, "Database statement failed.");
    }
  }

  transaction<T>(work: () => T): T {
    this.ensureOpen();
    try {
      return this.native.transaction(() => {
        const result = work();
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          "then" in result &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          throw new DatabaseError(
            "async-transaction",
            "Database transactions must be synchronous.",
            { retryable: false },
          );
        }
        return result;
      })();
    } catch (error) {
      throw normalizeDriverError(error, "Database transaction failed.");
    }
  }

  integrityCheck(): IntegrityResult {
    this.ensureOpen();
    try {
      const rows = this.native.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
      const details = rows.map((row) => row.integrity_check);
      return { ok: details.length === 1 && details[0] === "ok", details };
    } catch (error) {
      if (error instanceof Driver.SqliteError) {
        throw new DatabaseError("integrity", "Database integrity check failed.", {
          retryable: false,
          cause: error,
        });
      }
      throw error;
    }
  }

  isOpen(): boolean {
    return this.open && this.native.open;
  }

  close(): void {
    if (!this.open) return;
    try {
      this.native.close();
      this.open = false;
    } catch (error) {
      throw normalizeDriverError(error, "Database close failed.");
    }
  }
}

export function openDatabase(config: DatabaseConfig): Database {
  if (
    config === null ||
    typeof config !== "object" ||
    typeof config.path !== "string" ||
    config.path.length === 0 ||
    !Number.isInteger(config.busyTimeoutMs) ||
    config.busyTimeoutMs < 0 ||
    config.busyTimeoutMs > 60_000 ||
    typeof config.wal !== "boolean"
  ) {
    throw new DatabaseError("connection", "Invalid database configuration.", { retryable: false });
  }

  let native: Driver.Database | undefined;
  try {
    native = new Driver(config.path);
    native.pragma("foreign_keys = ON");
    native.pragma(`busy_timeout = ${config.busyTimeoutMs}`);
    if (config.wal) {
      const rows = native.pragma("journal_mode = WAL") as Array<{ journal_mode: string }>;
      if (rows[0]?.journal_mode.toLowerCase() !== "wal") {
        throw new DatabaseError("connection", "SQLite WAL mode could not be enabled.", {
          retryable: false,
        });
      }
    }
    return new SqliteDatabase(native);
  } catch (error) {
    try {
      native?.close();
    } catch {
      // Preserve the opening failure rather than replacing it with cleanup failure.
    }
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError("connection", "Database connection failed.", {
      retryable: false,
      cause: error,
    });
  }
}

export function migrate(database: Database, migrations: readonly Migration[]): void {
  if (!database.isOpen()) {
    throw new DatabaseError("closed", "Database connection is closed.", { retryable: false });
  }
  if (!Array.isArray(migrations)) {
    throw migrationError("invalid-migration", "Migration definitions must be an array.");
  }

  const seen = new Set<string>();
  for (const migration of migrations) {
    const id = migration !== null && typeof migration === "object" && typeof migration.id === "string"
      ? migration.id
      : undefined;
    if (
      migration === null ||
      typeof migration !== "object" ||
      typeof migration.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(migration.id) ||
      typeof migration.sql !== "string" ||
      migration.sql.trim().length === 0
    ) {
      throw migrationError("invalid-migration", "Invalid migration definition.", id);
    }
    if (seen.has(migration.id)) {
      throw migrationError("invalid-migration", "Duplicate migration definition.", migration.id);
    }
    seen.add(migration.id);
  }

  const native = connections.get(database);
  if (native === undefined) {
    throw new DatabaseError("driver", "Database migration connection is unavailable.", {
      retryable: false,
    });
  }

  const checksums = new Map(migrations.map((migration) => [
    migration.id,
    createHash("sha256").update(migration.sql, "utf8").digest("hex"),
  ]));

  let appliedRows: Array<{ id: string; checksum: string }>;
  try {
    native.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    appliedRows = native.prepare("SELECT id, checksum FROM schema_migrations").all() as Array<{
      id: string;
      checksum: string;
    }>;
  } catch (error) {
    throw migrationError("sql-failed", "Migration ledger initialization failed.", undefined, error);
  }

  const applied = new Map(appliedRows.map((row) => [row.id, row.checksum]));
  for (const migration of migrations) {
    const checksum = applied.get(migration.id);
    if (checksum !== undefined && checksum !== checksums.get(migration.id)) {
      throw migrationError(
        "checksum-mismatch",
        "Applied migration checksum does not match its definition.",
        migration.id,
      );
    }
  }

  const greatestApplied = appliedRows.map((row) => row.id).sort().at(-1);
  const pending = migrations.filter((migration) => !applied.has(migration.id)).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  if (greatestApplied !== undefined) {
    const invalid = pending.find((migration) => migration.id <= greatestApplied);
    if (invalid !== undefined) {
      throw migrationError(
        "invalid-order",
        "Pending migrations must sort after every applied migration.",
        invalid.id,
      );
    }
  }

  for (const migration of pending) {
    try {
      native.transaction(() => {
        native.exec(migration.sql);
        native.prepare(
          "INSERT INTO schema_migrations(id, checksum, applied_at) VALUES (?, ?, ?)",
        ).run(migration.id, checksums.get(migration.id), new Date().toISOString());
      })();
    } catch (error) {
      throw migrationError("sql-failed", "Migration execution failed.", migration.id, error);
    }
  }
}
