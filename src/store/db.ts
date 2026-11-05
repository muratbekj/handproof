import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HandoffsError } from "../errors.ts";
import { MIGRATIONS, type Migration } from "./migrations/index.ts";

export type Db = Database;

const MEMORY = ":memory:";

/** Opens (creating parent dirs and the file if needed), sets pragmas, and applies pending migrations. */
export function openDb(dbPath: string, opts?: { migrations?: readonly Migration[] }): Db {
  if (dbPath !== MEMORY) mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    // busy_timeout first: switching to WAL and BEGIN IMMEDIATE must wait for a concurrent opener.
    db.run("PRAGMA busy_timeout = 5000");
    const mode = enableWal(db);
    if (dbPath !== MEMORY && mode !== "wal") {
      throw new HandoffsError("db_open_failed", `could not enable WAL on ${dbPath} (journal_mode=${String(mode)})`);
    }
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, opts?.migrations ?? MIGRATIONS);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

const BUSY_WAIT_MS = 5000;

/** SQLITE_BUSY* (including SQLITE_BUSY_SNAPSHOT, errno 517) or SQLITE_LOCKED: the caller may retry. */
export function isBusy(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code === "SQLITE_LOCKED");
}

/**
 * Switches to WAL and returns the resulting journal mode. SQLite can return SQLITE_BUSY for this
 * pragma without consulting the busy handler when another connection is mid-switch, so retry here.
 */
function enableWal(db: Db): string | undefined {
  const deadline = Date.now() + BUSY_WAIT_MS;
  for (;;) {
    try {
      return db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()?.journal_mode;
    } catch (err) {
      if (!isBusy(err) || Date.now() >= deadline) throw err;
      Bun.sleepSync(5 + Math.floor(Math.random() * 20));
    }
  }
}

function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`migrations must be sorted with contiguous versions from 1; got ${m.version} at index ${i}`);
    }
  });
}

/**
 * Applies pending migrations in one BEGIN IMMEDIATE transaction; returns the versions newly applied.
 * Applied versions are read after the write lock is held, so concurrent openers apply each migration once.
 * Any failure rolls back everything this call did.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number[] {
  assertContiguous(migrations);
  const run = db.transaction((): number[] => {
    db.run(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const applied = new Set(
      db
        .query<{ version: number }, []>("SELECT version FROM schema_migrations")
        .all()
        .map((r) => r.version),
    );
    const newest = Math.max(0, ...applied);
    if (newest > migrations.length) {
      throw new HandoffsError(
        "db_schema_newer",
        `database schema version ${newest} is newer than this handproof knows (${migrations.length}); upgrade handproof`,
      );
    }
    const record = db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES ($version, $name, $at)");
    const done: number[] = [];
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      db.run(m.sql);
      record.run({ version: m.version, name: m.name, at: new Date().toISOString() });
      done.push(m.version);
    }
    return done;
  });
  return run.immediate();
}
