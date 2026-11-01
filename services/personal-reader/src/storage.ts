import type { Clock, Database, ReaderStore, JobQueue } from "./storage-types.js";
import { migrate, openDatabase } from "@tmtp/database";
import { createJobQueue, jobQueueMigrations } from "@tmtp/job-queue";
import { readerAppJobCodecs } from "@tmtp/reader-app";
import { createReaderStore, readerStoreMigrations } from "@tmtp/reader-store";
import type { ResolvedConfig } from "./config.js";
import { LocalHealthState } from "./health.js";
import { ServiceError } from "./errors.js";

export interface StorageGraph {
  database: Database;
  store: ReaderStore;
  jobs: JobQueue;
}

export function openStorage(config: ResolvedConfig, clock: Clock, health: LocalHealthState): StorageGraph {
  const database = openDatabase({
    path: config.database.path,
    busyTimeoutMs: config.database.busy_timeout_ms,
    wal: config.database.wal,
  });
  try {
    if (!database.integrityCheck().ok) {
      health.sqliteFailed("integrity-check-failed");
      throw new ServiceError("integrity-check-failed", 500);
    }
    health.sqliteReady();
    try {
      migrate(database, [...readerStoreMigrations, ...jobQueueMigrations]);
      health.migrationsReady();
    } catch (error) {
      health.migrationsFailed(error);
      throw error;
    }
    if (database.queryOne<{ ok: number }>("SELECT 1 AS ok")?.ok !== 1) {
      throw new ServiceError("database-unavailable", 503);
    }
    const store = createReaderStore(database);
    const jobs = createJobQueue({
      database,
      clock,
      codecs: readerAppJobCodecs,
      leaseMs: config.jobs.lease_ms,
      maxAttempts: config.jobs.max_attempts,
      backoffBaseMs: config.jobs.backoff_base_ms,
      backoffMaxMs: config.jobs.backoff_max_ms,
      // Diagnostics reads limit + 1 for pages up to 50. The approved service
      // composition keeps one queue and gives it enough read headroom.
      batchSize: Math.max(config.jobs.batch_size, 51),
    });
    return { database, store, jobs };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function recoverExpiredLeases(jobs: JobQueue, batchSize: number): void {
  while (jobs.recoverExpired() >= batchSize) {
    // Recovery is deliberately bounded per call and executes no handlers.
  }
}
