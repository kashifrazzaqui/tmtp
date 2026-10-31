import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DatabaseError,
  migrate,
  openDatabase,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const openMemory = () => openDatabase({ path: ":memory:", busyTimeoutMs: 5_000, wal: false });
const expectDatabaseError = (operation: () => unknown, code: string): DatabaseError => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).code).toBe(code);
    return error as DatabaseError;
  }
  throw new Error(`Expected ${code} failure.`);
};

describe("database connection and statements", () => {
  let database: Database | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("should apply foreign keys and busy timeout and support idempotent close", () => {
    database = openMemory();
    expect(database.queryOne<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    expect(database.queryOne<{ timeout: number }>("PRAGMA busy_timeout")?.timeout).toBe(5_000);
    expect(database.integrityCheck()).toEqual({ ok: true, details: ["ok"] });
    expect(database.isOpen()).toBe(true);
    database.close();
    database.close();
    expect(database.isOpen()).toBe(false);
    expectDatabaseError(() => database?.query("SELECT 1"), "closed");
    expectDatabaseError(() => database?.execute("SELECT 1"), "closed");
    expectDatabaseError(() => database?.integrityCheck(), "closed");
    expectDatabaseError(() => database?.transaction(() => 1), "closed");
    expectDatabaseError(() => database && migrate(database, []), "closed");
  });

  it("should verify WAL mode on disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "tmtp-database-"));
    try {
      database = openDatabase({ path: join(directory, "reader.db"), busyTimeoutMs: 0, wal: true });
      expect(database.queryOne<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    } finally {
      database?.close();
      database = undefined;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("should bind every supported value type and reject ambiguous queryOne results", () => {
    database = openMemory();
    database.execute("CREATE TABLE values_table (id INTEGER, text TEXT, number REAL, big INTEGER, bytes BLOB, nil TEXT)");
    const inserted = database.execute(
      "INSERT INTO values_table VALUES (?, ?, ?, ?, ?, ?)",
      [1, "hello", 1.5, 9_007_199_254_740_991n, new Uint8Array([1, 2, 255]), null],
    );
    expect(inserted.changes).toBe(1);
    const row = database.queryOne<{
      id: number;
      text: string;
      number: number;
      big: number;
      bytes: Uint8Array;
      nil: null;
    }>("SELECT * FROM values_table WHERE id = ?", [1]);
    expect(row?.text).toBe("hello");
    expect(row?.number).toBe(1.5);
    expect(row?.big).toBe(9_007_199_254_740_991);
    expect(Array.from(row?.bytes ?? [])).toEqual([1, 2, 255]);
    expect(row?.nil).toBeNull();
    expectDatabaseError(() => database?.queryOne("SELECT 1 AS value UNION ALL SELECT 2"), "driver");
  });

  it("should normalize constraint and driver failures without SQL in stable messages", () => {
    database = openMemory();
    database.execute("CREATE TABLE unique_values (value TEXT UNIQUE)");
    database.execute("INSERT INTO unique_values VALUES (?)", ["secret-parameter"]);
    const constraint = expectDatabaseError(
      () => database?.execute("INSERT INTO unique_values VALUES (?)", ["secret-parameter"]),
      "constraint",
    );
    expect(constraint.retryable).toBe(false);
    expect(constraint.message).not.toContain("secret-parameter");
    expect(constraint.cause).toBeDefined();
    expect(constraint.migrationReason).toBeUndefined();
    const driver = expectDatabaseError(() => database?.query("SELECT FROM invalid_sql_marker"), "driver");
    expect(driver.message).not.toContain("invalid_sql_marker");
  });

  it("should map real lock failures to retryable busy errors", () => {
    const directory = mkdtempSync(join(tmpdir(), "tmtp-busy-"));
    let second: Database | undefined;
    try {
      const path = join(directory, "busy.db");
      database = openDatabase({ path, busyTimeoutMs: 0, wal: false });
      second = openDatabase({ path, busyTimeoutMs: 0, wal: false });
      database.execute("CREATE TABLE entries (value TEXT)");
      database.transaction(() => {
        database?.execute("INSERT INTO entries VALUES ('first')");
        const error = expectDatabaseError(() => second?.execute("INSERT INTO entries VALUES ('second')"), "busy");
        expect(error.retryable).toBe(true);
      });
    } finally {
      second?.close();
      database?.close();
      database = undefined;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("transactions", () => {
  it("should roll back nested work independently through savepoints", () => {
    const database = openMemory();
    try {
      database.execute("CREATE TABLE entries (value TEXT)");
      database.transaction(() => {
        database.execute("INSERT INTO entries VALUES ('outer-before')");
        expect(() => database.transaction(() => {
          database.execute("INSERT INTO entries VALUES ('inner')");
          throw new Error("rollback inner");
        })).toThrow("rollback inner");
        database.execute("INSERT INTO entries VALUES ('outer-after')");
      });
      expect(database.query<{ value: string }>("SELECT value FROM entries ORDER BY rowid").map((row) => row.value)).toEqual([
        "outer-before",
        "outer-after",
      ]);
    } finally {
      database.close();
    }
  });

  it("should rethrow the original outer failure and roll back", () => {
    const database = openMemory();
    const failure = { marker: "original" };
    try {
      database.execute("CREATE TABLE entries (value TEXT)");
      expect(() => database.transaction(() => {
        database.execute("INSERT INTO entries VALUES ('rolled-back')");
        throw failure;
      })).toThrow(failure);
      expect(database.query("SELECT * FROM entries")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("should reject thenable work and prevent an early commit", () => {
    const database = openMemory();
    try {
      database.execute("CREATE TABLE entries (value TEXT)");
      const error = expectDatabaseError(() => database.transaction(() => {
        database.execute("INSERT INTO entries VALUES ('rolled-back')");
        return Promise.resolve("done");
      }), "async-transaction");
      expect(error.retryable).toBe(false);
      expect(database.query("SELECT * FROM entries")).toEqual([]);
    } finally {
      database.close();
    }
  });
});

describe("migrations", () => {
  it("should validate malformed and duplicate definitions before changing schema", () => {
    const database = openMemory();
    try {
      for (const definitions of [
        [{ id: "Invalid ID", sql: "CREATE TABLE invalid (id INTEGER)" }],
        [{ id: "001", sql: " " }],
        [{ id: "001", sql: "SELECT 1" }, { id: "001", sql: "SELECT 2" }],
      ]) {
        const error = expectDatabaseError(() => migrate(database, definitions), "migration");
        expect(error.migrationReason).toBe("invalid-migration");
        expect(error.retryable).toBe(false);
      }
      expect(database.query("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("should execute pending migrations in lexical order and record checksums", () => {
    const database = openMemory();
    try {
      migrate(database, [
        { id: "002-second", sql: "CREATE TABLE second (id INTEGER)" },
        { id: "001-first", sql: "CREATE TABLE first (id INTEGER)" },
      ]);
      expect(database.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY rowid").map((row) => row.id)).toEqual([
        "001-first",
        "002-second",
      ]);
      migrate(database, [{ id: "001-first", sql: "CREATE TABLE first (id INTEGER)" }]);
      expect(database.query("SELECT * FROM schema_migrations")).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("should reject a pending ID that does not sort after the greatest applied ID", () => {
    const database = openMemory();
    try {
      migrate(database, [{ id: "002", sql: "CREATE TABLE second (id INTEGER)" }]);
      const error = expectDatabaseError(() => migrate(database, [
        { id: "002", sql: "CREATE TABLE second (id INTEGER)" },
        { id: "001", sql: "CREATE TABLE first (id INTEGER)" },
      ]), "migration");
      expect(error.migrationReason).toBe("invalid-order");
      expect(error.migrationId).toBe("001");
      expect(database.query("SELECT name FROM sqlite_master WHERE name = 'first'")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("should reject changed applied SQL before executing any pending migration", () => {
    const database = openMemory();
    try {
      migrate(database, [{ id: "001", sql: "CREATE TABLE first (id INTEGER)" }]);
      const error = expectDatabaseError(() => migrate(database, [
        { id: "001", sql: "CREATE TABLE first (id INTEGER, changed TEXT)" },
        { id: "002", sql: "CREATE TABLE second (id INTEGER)" },
      ]), "migration");
      expect(error.migrationReason).toBe("checksum-mismatch");
      expect(error.migrationId).toBe("001");
      expect(database.query("SELECT name FROM sqlite_master WHERE name = 'second'")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("should commit each migration with its ledger row and resume after SQL failure", () => {
    const database = openMemory();
    try {
      const first = { id: "001", sql: "CREATE TABLE first (id INTEGER)" };
      const failing = {
        id: "002",
        sql: "CREATE TABLE partial_failure_marker (id INTEGER); INVALID SQL;",
      };
      const error = expectDatabaseError(() => migrate(database, [first, failing]), "migration");
      expect(error.migrationReason).toBe("sql-failed");
      expect(error.migrationId).toBe("002");
      expect(error.message).not.toContain("partial_failure_marker");
      expect(database.query<{ id: string }>("SELECT id FROM schema_migrations").map((row) => row.id)).toEqual(["001"]);
      expect(database.query("SELECT name FROM sqlite_master WHERE name = 'partial_failure_marker'")).toEqual([]);

      migrate(database, [first, { id: "002", sql: "CREATE TABLE second (id INTEGER)" }]);
      expect(database.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id").map((row) => row.id)).toEqual([
        "001",
        "002",
      ]);
    } finally {
      database.close();
    }
  });
});
