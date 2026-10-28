# Database Library Spec

## Purpose and responsibility
Own the SQLite connection, pragmas, migrations, prepared-query boundary, and short transactions. It contains no reader-domain repositories or background-job semantics.

## Public interface / API surface
```ts
export interface DatabaseConfig {
  path: string;
  busyTimeoutMs: number;
  wal: boolean;
}

export interface Migration {
  id: string;
  sql: string;
}

export interface Database {
  query<T>(sql: string, parameters?: unknown[]): T[];
  execute(sql: string, parameters?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  transaction<T>(work: () => T): T;
  close(): void;
}

export function openDatabase(config: DatabaseConfig): Database;
export function migrate(database: Database, migrations: Migration[]): void;
```

Migration IDs are unique, ordered, and recorded atomically with each migration. Foreign keys are always enabled. No external network or LLM call may run inside `transaction`.

## Internal subcomponents
- Connection/pragmas and lifecycle.
- Migration ledger and checksum validation.
- Query/error mapping and transaction helper.

## Dependencies on other libs
None.

## New build or OSS wrapper
New build wrapping `better-sqlite3` `13.0.3`; handwritten SQL, no ORM.

## Hosted by
`services/personal-reader`; one shared connection and one writer.

## Configuration
- `database.path` — **required**; SQLite file path.
- `database.busy_timeout_ms` — **optional**, default `5000`.
- `database.wal` — **optional**, default `true`.
