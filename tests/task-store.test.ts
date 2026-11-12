import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { Task } from "../src/schema/task";
import { openDb, type Db } from "../src/store/db";
import { m001Init } from "../src/store/migrations/001_init";
import { createRepo } from "../src/store/repo";
import { createTaskRepo } from "../src/store/task-repo";
import { fixtureHandoff } from "./helpers/handoffFixtures";
import { fixtureTask } from "./helpers/taskFixtures";
import { removeDir, tmpDir } from "./helpers/tmp";

const AT = "2026-11-11T10:00:00.000Z";

function withDb(fn: (db: Db, dbPath: string) => void): void {
  const dir = tmpDir("handproof-task-store-");
  const dbPath = path.join(dir, "handoffs.db");
  const db = openDb(dbPath);
  try {
    fn(db, dbPath);
  } finally {
    db.close();
    removeDir(dir);
  }
}

const created = (t: Task) => ({ at: t.createdAt, actor: t.from.name, type: "created" as const, data: { goal: t.goal } });

describe("migration 002", () => {
  test("fresh DB has tasks, task_events and handoffs.task_id", () => {
    withDb((db) => {
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
      expect(tables).toContain("tasks");
      expect(tables).toContain("task_events");
      const cols = (db.query("PRAGMA table_info(handoffs)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain("task_id");
    });
  });

  test("a v1 database with a handoff migrates and keeps it", () => {
    const dir = tmpDir("handproof-task-store-");
    const dbPath = path.join(dir, "handoffs.db");
    try {
      const old = openDb(dbPath, { migrations: [m001Init] });
      const h = fixtureHandoff();
      // Raw v1 insert: the current repo writes task_id, which a v1 table doesn't have.
      const { status: _s, claim: _c, updatedAt: _u, ...doc } = h;
      old.run(
        `INSERT INTO handoffs (id, schema_version, status, kind, to_agent, priority, from_agent, created_at, updated_at, doc)
         VALUES (?, 1, 'open', ?, ?, ?, ?, ?, ?, ?)`,
        [h.id, h.kind, h.to, h.priority, h.from.name, h.createdAt, h.updatedAt, JSON.stringify(doc)],
      );
      old.close();

      const db = openDb(dbPath);
      try {
        const repo = createRepo(db);
        expect(repo.get(h.id)?.title).toBe(h.title);
        expect(repo.list({})).toHaveLength(1);
        expect(createTaskRepo(db).list({})).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      removeDir(dir);
    }
  });
});

describe("TaskRepo", () => {
  test("insert, get, list, events", () => {
    withDb((db) => {
      const repo = createTaskRepo(db);
      const a = fixtureTask();
      const b = fixtureTask({ status: "done", createdAt: "2026-11-11T11:00:00.000Z" });
      repo.insert(a, created(a));
      repo.insert(b, created(b));
      expect(repo.get(a.id)).toEqual(a);
      expect(repo.get("t_nope")).toBeNull();
      expect(repo.list({}).map((t) => t.id)).toEqual([a.id, b.id]);
      expect(repo.list({ status: ["done"] }).map((t) => t.id)).toEqual([b.id]);
      expect(repo.list({ status: [] })).toEqual([]);
      const evs = repo.events(a.id);
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({ taskId: a.id, type: "created", actor: "lead", data: { goal: a.goal } });
    });
  });

  test("transition is compare-and-set on status", () => {
    withDb((db) => {
      const repo = createTaskRepo(db);
      const t = fixtureTask();
      repo.insert(t, created(t));
      const next = { ...t, status: "researching" as const, updatedAt: "2026-11-11T10:05:00.000Z" };
      const ev = { at: next.updatedAt, actor: "lead", type: "moved" as const, data: { from: "new", to: "researching" } };
      expect(repo.transition(t.id, "new", next, ev)).toBe(true);
      // A second lead that read "new" loses.
      expect(repo.transition(t.id, "new", { ...next, status: "planning" }, ev)).toBe(false);
      expect(repo.get(t.id)?.status).toBe("researching");
      expect(repo.events(t.id).map((e) => e.type)).toEqual(["created", "moved"]);
    });
  });

  test("task_events are append-only", () => {
    withDb((db) => {
      const repo = createTaskRepo(db);
      const t = fixtureTask();
      repo.insert(t, created(t));
      expect(() => db.run("UPDATE task_events SET actor = 'x'")).toThrow(/append-only/);
      expect(() => db.run("DELETE FROM task_events")).toThrow(/append-only/);
    });
  });
});

describe("handoff task link", () => {
  test("insert with task writes task_id and a handoff_linked event; list filters by task", () => {
    withDb((db) => {
      const tasks = createTaskRepo(db);
      const handoffs = createRepo(db);
      const t = fixtureTask({ status: "building" });
      tasks.insert(t, created(t));
      const linked = fixtureHandoff({ task: t.id });
      const other = fixtureHandoff();
      handoffs.insert(linked, { at: AT, actor: "lead", type: "created" });
      handoffs.insert(other, { at: AT, actor: "lead", type: "created" });

      expect(handoffs.get(linked.id)?.task).toBe(t.id);
      expect(handoffs.list({ task: t.id }).map((h) => h.id)).toEqual([linked.id]);
      expect(tasks.handoffIds(t.id)).toEqual([linked.id]);
      const link = tasks.events(t.id).find((e) => e.type === "handoff_linked");
      expect(link?.data).toEqual({ handoff: linked.id, title: linked.title, kind: linked.kind });
      expect(handoffs.taskStatus(t.id)).toBe("building");
      expect(handoffs.taskStatus("t_nope")).toBeNull();
    });
  });
});
