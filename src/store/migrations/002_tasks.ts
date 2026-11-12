import type { Migration } from "./index.ts";

/** Tasks (one per goal), their append-only events, and the handoff → task link. */
export const m002Tasks: Migration = {
  version: 2,
  name: "tasks",
  sql: `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, status TEXT NOT NULL, risk TEXT NOT NULL,
  from_agent TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, doc TEXT NOT NULL
);
CREATE INDEX tasks_status ON tasks(status);
CREATE TABLE task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  at TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX task_events_task ON task_events(task_id, seq);
CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT, 'task events are append-only'); END;
CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT, 'task events are append-only'); END;
ALTER TABLE handoffs ADD COLUMN task_id TEXT REFERENCES tasks(id);
CREATE INDEX handoffs_task ON handoffs(task_id, created_at);
`,
};
