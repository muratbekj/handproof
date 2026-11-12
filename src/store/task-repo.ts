import type { Task, TaskStatus } from "../schema/task.ts";
import type { Db } from "./db.ts";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "./repo.ts";

export type TaskEventType = "created" | "moved" | "approved" | "rejected" | "cancelled" | "handoff_linked";

export interface TaskEvent {
  seq: number;
  taskId: string;
  at: string;
  actor: string;
  type: TaskEventType;
  data: Record<string, unknown>;
}

export interface NewTaskEvent {
  at: string;
  actor: string;
  type: TaskEventType;
  data?: Record<string, unknown>;
}

export interface TaskListFilter {
  status?: TaskStatus[];
  limit?: number;
}

export interface TaskRepo {
  insert(t: Task, ev: NewTaskEvent): void;
  get(id: string): Task | null;
  /** Order: created_at ASC, id ASC. Limit default 50, max 200. */
  list(f: TaskListFilter): Task[];
  /** Compare-and-set on status: writes `next` (status, updated_at, doc) and the event, or nothing. */
  transition(id: string, expectStatus: TaskStatus, next: Task, ev: NewTaskEvent): boolean;
  /** seq ASC */
  events(id: string): TaskEvent[];
  /** Linked handoff ids in creation order. */
  handoffIds(taskId: string): string[];
}

interface TaskRow {
  status: string;
  updated_at: string;
  doc: string;
}

interface TaskEventRow {
  seq: number;
  task_id: string;
  at: string;
  actor: string;
  type: string;
  data: string;
}

/** Columns are authoritative for status and updated_at; `doc` holds the rest of the Task JSON. */
function toDoc(t: Task): string {
  const { status: _status, updatedAt: _updatedAt, ...doc } = t;
  return JSON.stringify(doc);
}

function fromRow(row: TaskRow): Task {
  const doc = JSON.parse(row.doc) as Omit<Task, "status" | "updatedAt">;
  return { ...doc, status: row.status as TaskStatus, updatedAt: row.updated_at };
}

/** Appends one task event; callers run it inside their own transaction. */
export function insertTaskEvent(db: Db, taskId: string, ev: NewTaskEvent): void {
  db.run("INSERT INTO task_events (task_id, at, actor, type, data) VALUES (?, ?, ?, ?, ?)", [
    taskId,
    ev.at,
    ev.actor,
    ev.type,
    JSON.stringify(ev.data ?? {}),
  ]);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit)));
}

export function createTaskRepo(db: Db): TaskRepo {
  const insertTx = db.transaction((t: Task, ev: NewTaskEvent): void => {
    db.run(
      `INSERT INTO tasks (id, schema_version, status, risk, from_agent, created_at, updated_at, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.id, t.schemaVersion, t.status, t.risk, t.from.name, t.createdAt, t.updatedAt, toDoc(t)],
    );
    insertTaskEvent(db, t.id, ev);
  });

  const transitionTx = db.transaction((id: string, expectStatus: TaskStatus, next: Task, ev: NewTaskEvent): boolean => {
    const info = db.run(`UPDATE tasks SET status = ?, updated_at = ?, doc = ? WHERE id = ? AND status = ?`, [
      next.status,
      next.updatedAt,
      toDoc(next),
      id,
      expectStatus,
    ]);
    if (info.changes !== 1) return false;
    insertTaskEvent(db, id, ev);
    return true;
  });

  return {
    insert(t, ev) {
      insertTx.immediate(t, ev);
    },

    get(id) {
      const row = db.query<TaskRow, [string]>("SELECT status, updated_at, doc FROM tasks WHERE id = ?").get(id);
      return row === null ? null : fromRow(row);
    },

    list(f) {
      const params: (string | number)[] = [];
      let where = "";
      if (f.status !== undefined) {
        if (f.status.length === 0) return [];
        where = `WHERE status IN (${f.status.map(() => "?").join(", ")})`;
        params.push(...f.status);
      }
      params.push(clampLimit(f.limit));
      return db
        .query<TaskRow, (string | number)[]>(
          `SELECT status, updated_at, doc FROM tasks ${where} ORDER BY created_at ASC, id ASC LIMIT ?`,
        )
        .all(...params)
        .map(fromRow);
    },

    transition(id, expectStatus, next, ev) {
      return transitionTx.immediate(id, expectStatus, next, ev);
    },

    events(id) {
      return db
        .query<TaskEventRow, [string]>(
          "SELECT seq, task_id, at, actor, type, data FROM task_events WHERE task_id = ? ORDER BY seq ASC",
        )
        .all(id)
        .map((r) => ({
          seq: r.seq,
          taskId: r.task_id,
          at: r.at,
          actor: r.actor,
          type: r.type as TaskEventType,
          data: JSON.parse(r.data) as Record<string, unknown>,
        }));
    },

    handoffIds(taskId) {
      return db
        .query<{ id: string }, [string]>("SELECT id FROM handoffs WHERE task_id = ? ORDER BY created_at ASC, id ASC")
        .all(taskId)
        .map((r) => r.id);
    },
  };
}
