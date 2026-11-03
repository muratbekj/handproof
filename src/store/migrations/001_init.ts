import type { Migration } from "./index.ts";

/**
 * Columns are authoritative for mutable state (status, claim, updated_at).
 * `doc` holds the rest of the Handoff JSON: everything except status, claim and updatedAt.
 */
export const m001Init: Migration = {
  version: 1,
  name: "init",
  sql: `
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, status TEXT NOT NULL,
  kind TEXT NOT NULL, to_agent TEXT NOT NULL, priority TEXT NOT NULL, from_agent TEXT NOT NULL,
  claim_json TEXT, claim_by TEXT, lease_until TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, doc TEXT NOT NULL
);
CREATE INDEX handoffs_status_lease ON handoffs(status, lease_until);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  handoff_id TEXT NOT NULL REFERENCES handoffs(id),
  at TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX events_handoff ON events(handoff_id, seq);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`,
};
