import type { AgentRef, Handoff, Kind, Status } from "../schema/handoff.ts";
import type { Db } from "./db.ts";

export type EventType =
  | "created"
  | "claimed"
  | "updated"
  | "released"
  | "cancelled"
  | "lease_expired"
  | "submitted"
  | "verification"
  | "verified"
  | "changes_requested"
  | "accepted"
  | "rejected"
  | "verification_interrupted";

export interface HandoffEvent {
  seq: number;
  handoffId: string;
  at: string;
  actor: string;
  type: EventType;
  data: Record<string, unknown>;
}

export interface NewEvent {
  at: string;
  actor: string;
  type: EventType;
  data?: Record<string, unknown>;
}

export interface ListFilter {
  status?: Status[];
  kind?: Kind;
  to?: string;
  /** from_agent = name OR claim_by = name */
  involving?: string;
  limit?: number;
}

export interface StatePatch {
  status: Status;
  claim: Handoff["claim"];
  updatedAt: string;
  /** Only when doc fields change. */
  doc?: Handoff;
}

export interface HandoffRepo {
  insert(h: Handoff, ev: NewEvent): void;
  get(id: string): Handoff | null;
  /** Order: created_at ASC, id ASC. Limit default 50, max 200. */
  list(f: ListFilter): Handoff[];
  /** Open handoffs addressed to agentName or "any"; priority high > normal > low, then created_at, id. */
  claimCandidates(agentName: string): Handoff[];
  /** Single conditional UPDATE (status open) + 'claimed' event. */
  tryClaim(id: string, by: AgentRef, leaseUntil: string, at: string): boolean;
  /** Compare-and-set on status (and claim_by when given); false when the row didn't match. */
  transitionState(id: string, expect: { status: Status; claimBy?: string }, patch: StatePatch, ev: NewEvent): boolean;
  /** Extends live leases held by agentName; no event. Returns rows changed. */
  renewLeases(agentName: string, leaseUntil: string, nowIso: string): number;
  /** Reopens claimed/changes_requested rows whose lease_until <= now; returns their ids. */
  expireLeases(nowIso: string): string[];
  /** Event only, no row change. */
  appendEvent(id: string, ev: NewEvent): void;
  /**
   * Submitted rows whose verification deadline (lease_until) <= now → changes_requested with
   * lease_until = leaseUntil, event 'verification_interrupted' by system. Returns their ids.
   */
  expireVerifications(nowIso: string, leaseUntil: string): string[];
  /** seq ASC */
  events(id: string): HandoffEvent[];
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

interface HandoffRow {
  id: string;
  status: string;
  claim_json: string | null;
  updated_at: string;
  doc: string;
}

interface EventRow {
  seq: number;
  handoff_id: string;
  at: string;
  actor: string;
  type: string;
  data: string;
}

function toDoc(h: Handoff): string {
  const { status: _status, claim: _claim, updatedAt: _updatedAt, ...doc } = h;
  return JSON.stringify(doc);
}

function fromRow(row: HandoffRow): Handoff {
  const doc = JSON.parse(row.doc) as Omit<Handoff, "status" | "claim" | "updatedAt">;
  return {
    ...doc,
    status: row.status as Status,
    claim: row.claim_json === null ? null : (JSON.parse(row.claim_json) as Handoff["claim"]),
    updatedAt: row.updated_at,
  };
}

function fromEventRow(row: EventRow): HandoffEvent {
  return {
    seq: row.seq,
    handoffId: row.handoff_id,
    at: row.at,
    actor: row.actor,
    type: row.type as EventType,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit)));
}

const COLS = "id, status, claim_json, updated_at, doc";

export function createRepo(db: Db): HandoffRepo {
  const insertEvent = (id: string, ev: NewEvent): void => {
    db.run("INSERT INTO events (handoff_id, at, actor, type, data) VALUES (?, ?, ?, ?, ?)", [
      id,
      ev.at,
      ev.actor,
      ev.type,
      JSON.stringify(ev.data ?? {}),
    ]);
  };

  const insertTx = db.transaction((h: Handoff, ev: NewEvent): void => {
    db.run(
      `INSERT INTO handoffs (id, schema_version, status, kind, to_agent, priority, from_agent,
         claim_json, claim_by, lease_until, created_at, updated_at, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        h.id,
        h.schemaVersion,
        h.status,
        h.kind,
        h.to,
        h.priority,
        h.from.name,
        h.claim === null ? null : JSON.stringify(h.claim),
        h.claim?.by.name ?? null,
        h.claim?.leaseUntil ?? null,
        h.createdAt,
        h.updatedAt,
        toDoc(h),
      ],
    );
    insertEvent(h.id, ev);
  });

  const tryClaimTx = db.transaction((id: string, by: AgentRef, leaseUntil: string, at: string): boolean => {
    const info = db.run(
      `UPDATE handoffs SET status = 'claimed', claim_json = ?, claim_by = ?, lease_until = ?, updated_at = ?
       WHERE id = ? AND status = 'open'`,
      [JSON.stringify({ by, leaseUntil }), by.name, leaseUntil, at, id],
    );
    if (info.changes !== 1) return false;
    insertEvent(id, { at, actor: by.name, type: "claimed", data: { leaseUntil } });
    return true;
  });

  const transitionTx = db.transaction(
    (id: string, expect: { status: Status; claimBy?: string }, patch: StatePatch, ev: NewEvent): boolean => {
      const sets = ["status = ?", "claim_json = ?", "claim_by = ?", "lease_until = ?", "updated_at = ?"];
      const params: (string | number | null)[] = [
        patch.status,
        patch.claim === null ? null : JSON.stringify(patch.claim),
        patch.claim?.by.name ?? null,
        patch.claim?.leaseUntil ?? null,
        patch.updatedAt,
      ];
      if (patch.doc !== undefined) {
        const d = patch.doc;
        sets.push("kind = ?", "to_agent = ?", "priority = ?", "from_agent = ?", "doc = ?");
        params.push(d.kind, d.to, d.priority, d.from.name, toDoc(d));
      }
      let where = "id = ? AND status = ?";
      params.push(id, expect.status);
      if (expect.claimBy !== undefined) {
        where += " AND claim_by = ?";
        params.push(expect.claimBy);
      }
      const info = db.run(`UPDATE handoffs SET ${sets.join(", ")} WHERE ${where}`, params);
      if (info.changes !== 1) return false;
      insertEvent(id, ev);
      return true;
    },
  );

  const renewTx = db.transaction((agentName: string, leaseUntil: string, nowIso: string): number => {
    const rows = db
      .query<{ id: string; claim_json: string }, [string, string, string]>(
        `SELECT id, claim_json FROM handoffs
         WHERE status IN ('claimed', 'changes_requested') AND claim_by = ? AND lease_until > ? AND lease_until < ?`,
      )
      .all(agentName, nowIso, leaseUntil);
    const update = db.query(`UPDATE handoffs SET claim_json = ?, lease_until = ? WHERE id = ?`);
    for (const row of rows) {
      const claim = JSON.parse(row.claim_json) as NonNullable<Handoff["claim"]>;
      update.run(JSON.stringify({ ...claim, leaseUntil }), leaseUntil, row.id);
    }
    return rows.length;
  });

  const expireTx = db.transaction((nowIso: string): string[] => {
    const rows = db
      .query<{ id: string; claim_by: string | null; lease_until: string }, [string]>(
        `SELECT id, claim_by, lease_until FROM handoffs
         WHERE status IN ('claimed', 'changes_requested') AND lease_until <= ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(nowIso);
    const update = db.query(
      `UPDATE handoffs SET status = 'open', claim_json = NULL, claim_by = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ?`,
    );
    for (const row of rows) {
      update.run(nowIso, row.id);
      insertEvent(row.id, {
        at: nowIso,
        actor: "system",
        type: "lease_expired",
        data: { previous: row.claim_by, leaseUntil: row.lease_until },
      });
    }
    return rows.map((r) => r.id);
  });

  const appendTx = db.transaction((id: string, ev: NewEvent): void => {
    insertEvent(id, ev);
  });

  const expireVerificationsTx = db.transaction((nowIso: string, leaseUntil: string): string[] => {
    const rows = db
      .query<{ id: string; claim_json: string | null; claim_by: string | null; lease_until: string }, [string]>(
        `SELECT id, claim_json, claim_by, lease_until FROM handoffs
         WHERE status = 'submitted' AND lease_until <= ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(nowIso);
    const update = db.query(
      `UPDATE handoffs SET status = 'changes_requested', claim_json = ?, lease_until = ?, updated_at = ? WHERE id = ?`,
    );
    for (const row of rows) {
      const claim = row.claim_json === null ? null : (JSON.parse(row.claim_json) as NonNullable<Handoff["claim"]>);
      update.run(claim === null ? null : JSON.stringify({ ...claim, leaseUntil }), leaseUntil, nowIso, row.id);
      insertEvent(row.id, {
        at: nowIso,
        actor: "system",
        type: "verification_interrupted",
        data: { claimBy: row.claim_by, deadline: row.lease_until, leaseUntil },
      });
    }
    return rows.map((r) => r.id);
  });

  return {
    insert(h, ev) {
      insertTx.immediate(h, ev);
    },

    get(id) {
      const row = db.query<HandoffRow, [string]>(`SELECT ${COLS} FROM handoffs WHERE id = ?`).get(id);
      return row === null ? null : fromRow(row);
    },

    list(f) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (f.status !== undefined) {
        if (f.status.length === 0) return [];
        where.push(`status IN (${f.status.map(() => "?").join(", ")})`);
        params.push(...f.status);
      }
      if (f.kind !== undefined) {
        where.push("kind = ?");
        params.push(f.kind);
      }
      if (f.to !== undefined) {
        where.push("to_agent = ?");
        params.push(f.to);
      }
      if (f.involving !== undefined) {
        where.push("(from_agent = ? OR claim_by = ?)");
        params.push(f.involving, f.involving);
      }
      params.push(clampLimit(f.limit));
      const sql = `SELECT ${COLS} FROM handoffs ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY created_at ASC, id ASC LIMIT ?`;
      return db.query<HandoffRow, (string | number)[]>(sql).all(...params).map(fromRow);
    },

    claimCandidates(agentName) {
      return db
        .query<HandoffRow, [string]>(
          `SELECT ${COLS} FROM handoffs
           WHERE status = 'open' AND to_agent IN (?, 'any')
           ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at ASC, id ASC`,
        )
        .all(agentName)
        .map(fromRow);
    },

    tryClaim(id, by, leaseUntil, at) {
      return tryClaimTx.immediate(id, by, leaseUntil, at);
    },

    transitionState(id, expect, patch, ev) {
      return transitionTx.immediate(id, expect, patch, ev);
    },

    renewLeases(agentName, leaseUntil, nowIso) {
      return renewTx.immediate(agentName, leaseUntil, nowIso);
    },

    expireLeases(nowIso) {
      return expireTx.immediate(nowIso);
    },

    appendEvent(id, ev) {
      appendTx.immediate(id, ev);
    },

    expireVerifications(nowIso, leaseUntil) {
      return expireVerificationsTx.immediate(nowIso, leaseUntil);
    },

    events(id) {
      return db
        .query<EventRow, [string]>(
          "SELECT seq, handoff_id, at, actor, type, data FROM events WHERE handoff_id = ? ORDER BY seq ASC",
        )
        .all(id)
        .map(fromEventRow);
    },
  };
}
