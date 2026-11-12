import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { migrate, openDb, type Db } from "../src/store/db";
import {
  MIGRATIONS,
  type Migration,
} from "../src/store/migrations/index";
import { removeDir, tmpDir } from "./helpers/tmp";

const NOW = "2026-11-03T00:00:00.000Z";

function tableNames(db: Db): string[] {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function migrationVersions(db: Db): number[] {
  const rows = db
    .query("SELECT version FROM schema_migrations ORDER BY version")
    .all() as { version: number }[];
  return rows.map((row) => row.version);
}

function insertHandoff(db: Db, id: string): void {
  db.run(
    `INSERT INTO handoffs
       (id, schema_version, status, kind, to_agent, priority, from_agent,
        created_at, updated_at, doc)
     VALUES (?, 1, 'open', 'implement', 'any', 'normal', 'planner', ?, ?, '{}')`,
    [id, NOW, NOW],
  );
}

function insertEvent(db: Db, handoffId: string): void {
  db.run(
    `INSERT INTO events (handoff_id, at, actor, type, data)
     VALUES (?, ?, 'planner', 'created', '{}')`,
    [handoffId, NOW],
  );
}

describe("openDb", () => {
  test("creates parent directories and applies the required pragmas", () => {
    const dir = tmpDir("handoffs-store-");
    const dbPath = path.join(dir, "a", "b", "handoffs.db");

    const db = openDb(dbPath);
    try {
      expect(fs.existsSync(path.dirname(dbPath))).toBe(true);

      const mode = db.query("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(mode.journal_mode).toBe("wal");

      const busy = db.query("PRAGMA busy_timeout").get() as {
        timeout: number;
      };
      expect(busy.timeout).toBe(5000);

      const foreignKeys = db.query("PRAGMA foreign_keys").get() as {
        foreign_keys: number;
      };
      expect(foreignKeys.foreign_keys).toBe(1);
    } finally {
      db.close();
      removeDir(dir);
    }
  });
});

describe("migrate", () => {
  test("applies 001 once, creates the tables, and is a no-op on reopen", () => {
    const dir = tmpDir("handoffs-store-");
    const dbPath = path.join(dir, "handoffs.db");

    let db: Db | null = openDb(dbPath, { migrations: [] });
    try {
      expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));

      const tables = tableNames(db);
      expect(tables).toContain("handoffs");
      expect(tables).toContain("events");
      expect(tables).toContain("schema_migrations");
      expect(migrationVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));

      expect(migrate(db)).toEqual([]);
      db.close();
      db = null;

      const reopened = openDb(dbPath);
      try {
        expect(migrate(reopened)).toEqual([]);
        expect(migrationVersions(reopened)).toEqual(MIGRATIONS.map((m) => m.version));
      } finally {
        reopened.close();
      }
    } finally {
      db?.close();
      removeDir(dir);
    }
  });

  test("applies only the missing custom migration", () => {
    const dir = tmpDir("handoffs-store-");
    const dbPath = path.join(dir, "custom.db");
    const first: Migration = {
      version: 1,
      name: "create_t",
      sql: "CREATE TABLE t (id INTEGER PRIMARY KEY);",
    };
    const second: Migration = {
      version: 2,
      name: "add_name",
      sql: "ALTER TABLE t ADD COLUMN name TEXT;",
    };

    const db = openDb(dbPath, { migrations: [] });
    try {
      expect(migrate(db, [first])).toEqual([1]);
      expect(migrate(db, [first, second])).toEqual([2]);

      const columns = db.query("PRAGMA table_info(t)").all() as {
        name: string;
      }[];
      expect(columns.map((column) => column.name)).toContain("name");
      expect(migrationVersions(db)).toEqual([1, 2]);
    } finally {
      db.close();
      removeDir(dir);
    }
  });

  test("rolls back a migration with broken SQL", () => {
    const dir = tmpDir("handoffs-store-");
    const dbPath = path.join(dir, "broken.db");
    const first: Migration = {
      version: 1,
      name: "create_t",
      sql: "CREATE TABLE t (id INTEGER PRIMARY KEY);",
    };
    const broken: Migration = {
      version: 2,
      name: "broken",
      sql: "CREATE TABLE should_not_exist (id INTEGER); THIS IS NOT SQL;",
    };

    const db = openDb(dbPath, { migrations: [] });
    try {
      expect(migrate(db, [first])).toEqual([1]);

      expect(() => migrate(db, [first, broken])).toThrow();

      expect(migrationVersions(db)).toEqual([1]);
      expect(tableNames(db)).not.toContain("should_not_exist");
    } finally {
      db.close();
      removeDir(dir);
    }
  });

  test("MIGRATIONS are sorted and contiguous", () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    MIGRATIONS.forEach((migration, index) => {
      expect(migration.version).toBe(index + 1);
    });
  });
});

describe("events table", () => {
  test("rejects UPDATE and DELETE", () => {
    const dir = tmpDir("handoffs-store-");
    const dbPath = path.join(dir, "events.db");

    const db = openDb(dbPath);
    try {
      insertHandoff(db, "h_1");
      insertEvent(db, "h_1");

      expect(() =>
        db.run("UPDATE events SET type = 'changed' WHERE seq = 1"),
      ).toThrow(/append-only/);
      expect(() => db.run("DELETE FROM events WHERE seq = 1")).toThrow(
        /append-only/,
      );
    } finally {
      db.close();
      removeDir(dir);
    }
  });

  test("rejects an event for an unknown handoff", () => {
    const dir = tmpDir("handoffs-store-");
    const dbPath = path.join(dir, "events.db");

    const db = openDb(dbPath);
    try {
      expect(() => {
        insertEvent(db, "h_missing");
      }).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
      removeDir(dir);
    }
  });
});

describe("concurrent migration", () => {
  test(
    "two processes can migrate the same fresh database",
    async () => {
      const dir = tmpDir("handoffs-race-");
      const dbPath = path.join(dir, "handoffs.db");
      const ready1 = path.join(dir, "ready-1");
      const ready2 = path.join(dir, "ready-2");
      const go = path.join(dir, "go");
      const worker = path.join(import.meta.dir, "helpers", "dbWorker.ts");
      const projectRoot = path.resolve(import.meta.dir, "..");

      const first = Bun.spawn(["bun", worker, dbPath, ready1, go], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const second = Bun.spawn(["bun", worker, dbPath, ready2, go], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        const deadline = Date.now() + 10_000;
        while (
          (!fs.existsSync(ready1) || !fs.existsSync(ready2)) &&
          Date.now() < deadline
        ) {
          await Bun.sleep(10);
        }
        const bothReady = fs.existsSync(ready1) && fs.existsSync(ready2);
        await Bun.write(go, "go\n");

        const [code1, code2] = await Promise.all([first.exited, second.exited]);
        const [stderr1, stderr2] = await Promise.all([
          first.stderr.text(),
          second.stderr.text(),
        ]);

        if (!bothReady) {
          throw new Error(
            `workers did not become ready: ${stderr1}${stderr2}`,
          );
        }
        if (code1 !== 0) {
          throw new Error(`worker 1 exited ${String(code1)}: ${stderr1}`);
        }
        if (code2 !== 0) {
          throw new Error(`worker 2 exited ${String(code2)}: ${stderr2}`);
        }

        const db = openDb(dbPath);
        try {
          expect(migrationVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));
        } finally {
          db.close();
        }
      } finally {
        for (const child of [first, second]) {
          if (child.exitCode === null) {
            try {
              child.kill();
            } catch {
              // The child exited between the check and the kill.
            }
          }
        }
        removeDir(dir);
      }
    },
    30_000,
  );
});
