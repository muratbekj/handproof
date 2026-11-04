import { describe, expect, test } from "bun:test";
import { createRepo, type HandoffRepo, type NewEvent } from "../src/store/repo";
import { openDb, type Db } from "../src/store/db";
import { fixtureHandoff, openHandoffRow } from "./helpers/handoffFixtures";
import { removeDir, tmpDir } from "./helpers/tmp";

const T0 = "2026-11-03T12:00:00.000Z";
const T1 = "2026-11-03T12:01:00.000Z";
const T2 = "2026-11-03T12:02:00.000Z";

function withRepo(fn: (repo: HandoffRepo, db: Db) => void): void {
  const dir = tmpDir("handoffs-repo-layer-");
  const dbPath = `${dir}/handoffs.db`;
  const db = openDb(dbPath);
  const repo = createRepo(db);
  try {
    fn(repo, db);
  } finally {
    db.close();
    removeDir(dir);
  }
}

function createdEvent(at: string): NewEvent {
  return { at, actor: "planner", type: "created", data: { title: "t", kind: "implement", to: "any" } };
}

describe("HandoffRepo", () => {
  test("insert and get round-trip a fixture handoff", () => {
    withRepo((repo) => {
      const handoff = fixtureHandoff();
      repo.insert(handoff, createdEvent(handoff.createdAt));
      const loaded = repo.get(handoff.id);
      expect(loaded).toEqual(handoff);
      expect(loaded?.claim).toBeNull();
      expect(loaded?.result).toBeNull();
    });
  });

  test("tryClaim succeeds once then fails without a second claimed event", () => {
    withRepo((repo) => {
      const handoff = fixtureHandoff();
      repo.insert(handoff, createdEvent(T0));
      const claimant = { name: "cursor-impl", harness: "cursor" as const };
      const leaseUntil = "2026-11-03T12:30:00.000Z";

      expect(repo.tryClaim(handoff.id, claimant, leaseUntil, T0)).toBe(true);
      const claimed = repo.get(handoff.id);
      expect(claimed?.status).toBe("claimed");
      expect(claimed?.claim?.by.name).toBe("cursor-impl");

      const eventsAfterFirst = repo.events(handoff.id);
      expect(eventsAfterFirst.filter((e) => e.type === "claimed")).toHaveLength(1);

      expect(repo.tryClaim(handoff.id, claimant, leaseUntil, T0)).toBe(false);
      expect(repo.events(handoff.id).filter((e) => e.type === "claimed")).toHaveLength(1);
    });
  });

  test("transitionState rejects wrong expected status and appends an event on success", () => {
    withRepo((repo) => {
      const handoff = fixtureHandoff();
      repo.insert(handoff, createdEvent(T0));

      const wrong = repo.transitionState(
        handoff.id,
        { status: "claimed" },
        { status: "open", claim: null, updatedAt: T1 },
        { at: T1, actor: "planner", type: "released", data: { reason: "x" } },
      );
      expect(wrong).toBe(false);
      expect(repo.events(handoff.id)).toHaveLength(1);

      const ok = repo.transitionState(
        handoff.id,
        { status: "open" },
        { status: "cancelled", claim: null, updatedAt: T1 },
        { at: T1, actor: "planner", type: "cancelled", data: {} },
      );
      expect(ok).toBe(true);
      expect(repo.get(handoff.id)?.status).toBe("cancelled");
      expect(repo.events(handoff.id).map((e) => e.type)).toEqual(["created", "cancelled"]);
    });
  });

  test("claimCandidates orders by priority then created_at and filters recipients", () => {
    withRepo((repo) => {
      const rows = [
        openHandoffRow({ to: "any", priority: "normal", createdAt: T1, title: "normal any" }),
        openHandoffRow({ to: "cursor-impl", priority: "high", createdAt: T2, title: "high cursor" }),
        openHandoffRow({ to: "planner", priority: "high", createdAt: T0, title: "high planner" }),
        openHandoffRow({ to: "any", priority: "low", createdAt: T0, title: "low any" }),
      ];
      for (const h of rows) {
        repo.insert(h, createdEvent(h.createdAt));
      }

      expect(rows).toHaveLength(4);
      const normalAny = rows[0];
      const highCursor = rows[1];
      const highPlanner = rows[2];
      const lowAny = rows[3];
      if (!normalAny || !highCursor || !highPlanner || !lowAny) {
        throw new Error("claim candidate fixture incomplete");
      }
      const ids = repo.claimCandidates("cursor-impl").map((h) => h.id);
      expect(ids).toEqual([highCursor.id, normalAny.id, lowAny.id]);
      expect(ids).not.toContain(highPlanner.id);
    });
  });

  test("expireLeases reopens expired rows and records lease_expired events", () => {
    withRepo((repo) => {
      const handoff = fixtureHandoff();
      repo.insert(handoff, createdEvent(T0));
      const leaseUntil = "2026-11-03T12:29:00.000Z";
      const claimant = { name: "cursor-impl", harness: "cursor" as const };
      expect(repo.tryClaim(handoff.id, claimant, leaseUntil, T0)).toBe(true);

      const expiredAt = "2026-11-03T12:31:00.000Z";
      const ids = repo.expireLeases(expiredAt);
      expect(ids).toEqual([handoff.id]);
      expect(repo.get(handoff.id)?.status).toBe("open");
      expect(repo.get(handoff.id)?.claim).toBeNull();

      const ev = repo.events(handoff.id).find((e) => e.type === "lease_expired");
      expect(ev?.actor).toBe("system");
      expect(ev?.data.previous).toBe("cursor-impl");
    });
  });

  test("list filters by status and clamps limit to 200", () => {
    withRepo((repo, db) => {
      const open = fixtureHandoff({ status: "open" });
      const cancelled = fixtureHandoff({ status: "cancelled" });
      repo.insert(open, createdEvent(T0));
      repo.insert(cancelled, createdEvent(T0));

      expect(repo.list({ status: ["open"] }).map((h) => h.id)).toEqual([open.id]);

      for (let i = 0; i < 210; i += 1) {
        const h = fixtureHandoff({ title: `Bulk handoff number ${String(i).padStart(3, "0")}` });
        repo.insert(h, createdEvent(T0));
      }
      expect(repo.list({ limit: 500 }).length).toBe(200);

      const count = db.query("SELECT COUNT(*) AS c FROM handoffs").get() as { c: number };
      expect(count.c).toBeGreaterThanOrEqual(212);
    });
  });
});
