# Database Library Spec

## Purpose and responsibility

Own the single SQLite connection, driver pragmas, integrity check, ordered migrations, prepared-query boundary, and short synchronous transactions. It contains no reader repositories, job semantics, domain schemas, or external calls.

## Public interface / API surface

```ts
export type SqlValue = null | string | number | bigint | Uint8Array;
export type SqlParameters = readonly SqlValue[];

export interface DatabaseConfig {
  path: string;
  busyTimeoutMs: number; // integer, 0..60000
  wal: boolean;
}

export interface Migration {
  id: string; // globally unique, lexically ordered migration ID
  sql: string; // one or more SQLite statements
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

export class DatabaseError extends Error {
  readonly name: "DatabaseError";
  readonly code: DatabaseErrorCode;
  readonly retryable: boolean;
  readonly migrationId?: string;
  readonly migrationReason?: MigrationFailureReason;
  readonly cause?: unknown;
}

export function openDatabase(config: DatabaseConfig): Database;
export function migrate(database: Database, migrations: readonly Migration[]): void;
```

`query` and `queryOne` return driver-shaped rows. Callers own parsing into trusted domain types; the generic is a mapping convenience, not runtime validation. `queryOne` throws a driver-mapped error if SQL produces more than one row, preventing accidental ambiguous lookups. Only positional `?` parameters are supported. Values are always bound, never interpolated.

## Connection and lifecycle contract

- `path` is a non-empty filesystem path. The parent directory must already exist; `:memory:` is supported for tests.
- Opening enables `foreign_keys=ON`, applies the configured busy timeout, and selects `journal_mode=WAL` when `wal=true`; otherwise it uses the driver's default rollback journal. WAL selection is verified rather than assumed.
- One `Database` represents one connection. The service shares it and owns all writes. No connection pool is exposed.
- `integrityCheck()` runs SQLite `PRAGMA integrity_check`; `ok=true` only for the single `ok` result. Details contain SQLite's diagnostic text, never bound application values.
- Operations after close throw `DatabaseError(code="closed")`. `close()` is idempotent and releases the native connection.

## Migration contract

1. `migrate` validates every migration definition, ID, and duplicate ID before changing the schema.
2. IDs match `[a-z0-9][a-z0-9._-]*`; lexicographic ID order is execution order. Every pending ID must sort after the greatest applied ID.
3. The ledger table is `schema_migrations(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`.
4. Each migration's SHA-256 checksum is computed from its exact SQL bytes. An already-applied ID with a different checksum fails with `code="migration"`, `migrationReason="checksum-mismatch"`, and changes nothing.
5. Each pending migration and its ledger insert commit in one transaction. A failure has `migrationReason="sql-failed"`, leaves earlier migrations applied and the failing migration unapplied, and identifies `migrationId`.
6. Applied migrations are never edited or rerun. Migration SQL runs through the driver's multi-statement execution path; application queries remain parameterized.

Every `DatabaseError` with `code="migration"` is nonretryable and has a `migrationReason`. The property is absent for every other error code. Migration failures map to reasons only as follows:

| Failure | `migrationReason` |
| --- | --- |
| Malformed migration definition or ID, or a duplicate ID in the supplied definitions | `invalid-migration` |
| A pending ID does not sort after the greatest applied ID | `invalid-order` |
| An applied ID's ledger checksum differs from its definition's checksum | `checksum-mismatch` |
| Migration SQL execution, a ledger operation, or a migration transaction fails | `sql-failed` |

`invalid-order` describes ordering only; malformed and duplicate definitions use `invalid-migration`. `migrationId` is preserved whenever it is known and applicable. Stable migration metadata contains no SQL text, SQL parameter values, or raw driver messages.

Service readiness maps the recorded result of its startup `migrate` call directly from this metadata. It does not match error messages or reimplement ledger queries and checksum checks. `migrate` remains the only migration ledger implementation, and no migration inspector API is exposed.

The migration ledger uses the database clock for `applied_at`; it is operational metadata, not domain event time. Libraries export migration arrays but do not call `migrate` themselves.

## Transaction and error contract

- `transaction` supports synchronous work only. Nested calls use savepoints; the outermost call uses a SQLite transaction.
- Return commits; throw rolls back that transaction/savepoint and rethrows the original error unless mapping is required by the driver boundary.
- A thenable/Promise return is rejected with `async-transaction`; the transaction rolls back. Network, LLM, timer, filesystem-secret, and other asynchronous work must happen before or after the transaction.
- Driver errors are normalized without including SQL parameter values. Constraint and busy errors are distinct; busy/locked errors are retryable, while constraint/migration/integrity errors are not.
- No method retries a transaction automatically. Retry policy belongs to the caller because commit outcomes and idempotency are operation-specific.

## Internal subcomponents

- Connection/pragmas and lifecycle.
- Statement execution and driver-row mapping.
- Migration discovery validation, ledger, and checksum checks.
- Nested transaction/savepoint manager and error normalization.

## Dependencies on other libs

None.

## New build or OSS wrapper

New build wrapping `better-sqlite3` `13.0.3`; handwritten SQL, no ORM.

## Hosted by

`services/personal-reader`; one shared connection and one writer.

## Configuration

- `database.path` — **required**; SQLite file path.
- `database.busy_timeout_ms` — **optional**, default `5000`, range `0`–`60000`.
- `database.wal` — **optional**, default `true`.

## Acceptance-focused test expectations

- Open/close is idempotent; foreign keys and busy timeout are effective; WAL mode is verified on disk.
- Query helpers bind all value types and reject ambiguous `queryOne` results.
- Malformed migration definitions or IDs and duplicate IDs fail before schema changes with `code="migration"`, `migrationReason="invalid-migration"`, and `retryable=false`.
- A pending ID that does not sort after the greatest applied ID fails before migration execution with `migrationReason="invalid-order"`; no other failure uses this ordering-only reason.
- An applied migration with a changed checksum fails with `migrationReason="checksum-mismatch"`, preserves its `migrationId`, and applies no pending migration.
- Migration SQL, ledger, and migration transaction failures use `migrationReason="sql-failed"`. Each migration commits atomically with its ledger insert: earlier migrations remain applied, the failing migration rolls back, and a later run resumes after the failure.
- Every migration error has its mapped reason and is nonretryable; every non-migration `DatabaseError` omits `migrationReason`. `migrationId` survives normalization where known and applicable, while stable metadata excludes SQL text, parameter values, and raw driver messages.
- Readiness classifies the recorded `migrate` result without message matching, a second ledger implementation, or a migration inspector API.
- Nested work rolls back independently through savepoints; async callbacks cannot commit early.
- Constraint, busy, closed, integrity, and driver failures retain safe codes and causes without parameter values.
