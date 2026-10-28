# Database Library Architecture

## Internal modules

- `connection`: validates `DatabaseConfig`, constructs the native connection, applies and verifies pragmas, and owns close state.
- `statements`: prepares single-statement queries/updates, binds positional values, reads all rows, and enforces `queryOne` cardinality.
- `migrations`: validates IDs, sorts work, computes SHA-256 checksums, bootstraps the ledger, and executes each migration with its ledger row.
- `transactions`: tracks nested depth and delegates to native transaction/savepoint behavior.
- `errors`: maps known driver error codes to stable safe categories while retaining `cause` for local debugging.

The public barrel exposes only the contracts in `spec.md`; native driver types do not escape.

## Connection design

Construction is synchronous because `better-sqlite3` is synchronous and service readiness cannot be advertised before SQLite is usable. Foreign keys are set per connection. WAL is requested and read back because journal selection may fail or be unsupported for a given database. The parent directory is not created implicitly: a wrong configured path must fail visibly rather than create a new reading memory in an unexpected location.

`integrityCheck` is explicit rather than automatically run on every query. Startup calls it before migrations; normal operations avoid an expensive full scan.

## Migration design

Migration IDs form one global lexical sequence across owning packages. The service concatenates arrays, and `migrate` performs duplicate/order validation before applying anything. A migration is a string rather than a callback so its exact bytes can be hashed and reviewed. Each migration runs in its own transaction, including its ledger insert.

Checksum mismatches are fatal and never auto-repaired. Down migrations and automatic schema diffing are intentionally absent; backups and forward migrations are the recovery model.

## Transaction design

The transaction helper tracks nested calls. The outermost call begins/commits/rolls back a transaction; nested calls use uniquely named savepoints. After user work returns, the helper rejects thenables before commit. This guard is essential because an `async` callback would otherwise commit at the first await.

Transactions contain only CPU-bound SQL and pure mapping. No retry loop, logging sink, network request, secret read, or LLM call belongs inside one. `reader-store` composes repositories and `job-queue` through this same connection to obtain atomic handoffs.

## Error design

The adapter inspects driver codes rather than matching human-readable messages where possible. SQL text may appear in a local cause for development, but normalized messages exclude bound parameters. Migration errors add `migrationId`. Retryable means only that a caller may reconsider the operation; the database never decides that a write is safe to repeat.

## Trade-offs

- Synchronous APIs simplify atomic multi-repository work but can block the Node event loop. Statements and batches must remain short; large scans are paged.
- No query builder or ORM keeps SQL explicit, but repository tests must cover mapping and schema drift.
- One connection matches the single-writer topology and does not support independent multi-process writers.

## Testing seams

Tests use temporary files for WAL/recovery and `:memory:` for query/transaction units. A faulty migration and native constraint errors exercise real driver behavior; no mock driver substitutes for migration/transaction integration tests.
