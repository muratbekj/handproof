import { describe, expect, test } from "bun:test";
import validFixture from "./fixtures/handoffs/valid.json";
import { AGENTS, openTestService } from "./helpers/serviceSetup";
import { tmpRepo } from "./helpers/tmpRepo";

const T0 = new Date("2026-11-03T12:00:00.000Z");

function withLeaseClock<T>(
  fn: (ctx: {
    now: () => Date;
    advance: (minutes: number) => void;
  }) => T,
): T {
  let ms = T0.getTime();
  const now = (): Date => new Date(ms);
  const advance = (minutes: number): void => {
    ms += minutes * 60_000;
  };
  return fn({ now, advance });
}

describe("lease expiry and renewal", () => {
  test("expires a claimed handoff after leaseMinutes without claimant calls", () => {
    withLeaseClock(({ now, advance }) => {
      const repo = tmpRepo();
      try {
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(validFixture);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const cursor = openTestService(repo, AGENTS.cursorImpl, now);
        expect(cursor.service.claim(id).ok).toBe(true);
        cursor.close();

        advance(29);
        const plannerList = openTestService(repo, AGENTS.planner, now);
        const mid = plannerList.service.list({ status: ["claimed"] });
        expect(mid.ok).toBe(true);
        if (!mid.ok) return;
        expect(mid.value.some((h) => h.id === id)).toBe(true);
        plannerList.close();

        advance(2);
        const after = openTestService(repo, AGENTS.planner, now);
        const openList = after.service.list({ status: ["open"] });
        expect(openList.ok).toBe(true);
        if (!openList.ok) return;
        expect(openList.value.some((h) => h.id === id)).toBe(true);

        const events = after.repo.events(id);
        const last = events[events.length - 1];
        expect(last?.type).toBe("lease_expired");
        expect(last?.actor).toBe("system");
        expect(last?.data.previous).toBe("cursor-impl");
        after.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("update after lease expiry returns lease_expired for the former claimant", () => {
    withLeaseClock(({ now, advance }) => {
      const repo = tmpRepo();
      try {
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(validFixture);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const cursor = openTestService(repo, AGENTS.cursorImpl, now);
        expect(cursor.service.claim(id).ok).toBe(true);
        cursor.close();

        advance(31);
        const cursorAgain = openTestService(repo, AGENTS.cursorImpl, now);
        const result = cursorAgain.service.update(id, "too late");
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.error).toBe("lease_expired");
        expect(result.error.id).toBe(id);
        cursorAgain.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("expires changes_requested the same way as claimed", () => {
    withLeaseClock(({ now, advance }) => {
      const repo = tmpRepo();
      try {
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(validFixture);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        const leaseUntil = new Date(T0.getTime() + 29 * 60_000).toISOString();
        planner.repo.tryClaim(
          id,
          AGENTS.cursorImpl,
          leaseUntil,
          T0.toISOString(),
        );
        const at = T0.toISOString();
        planner.repo.transitionState(
          id,
          { status: "claimed", claimBy: "cursor-impl" },
          {
            status: "changes_requested",
            claim: { by: AGENTS.cursorImpl, leaseUntil },
            updatedAt: at,
          },
          { at, actor: "system", type: "updated", data: {} },
        );
        planner.close();

        advance(31);
        const observer = openTestService(repo, AGENTS.planner, now);
        const openList = observer.service.list({ status: ["open"] });
        expect(openList.ok).toBe(true);
        if (!openList.ok) return;
        expect(openList.value.some((h) => h.id === id)).toBe(true);
        expect(observer.repo.get(id)?.status).toBe("open");
        const ev = observer.repo.events(id).find((e) => e.type === "lease_expired");
        expect(ev?.data.previous).toBe("cursor-impl");
        observer.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("claimant get renews the lease so expiry is pushed out", () => {
    withLeaseClock(({ now, advance }) => {
      const repo = tmpRepo();
      try {
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(validFixture);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const cursor = openTestService(repo, AGENTS.cursorImpl, now);
        expect(cursor.service.claim(id).ok).toBe(true);
        cursor.close();

        advance(20);
        const renew = openTestService(repo, AGENTS.cursorImpl, now);
        const got = renew.service.get(id);
        expect(got.ok).toBe(true);
        if (!got.ok) return;
        expect(got.value.handoff.claim?.leaseUntil).toBe(
          new Date(T0.getTime() + 50 * 60_000).toISOString(),
        );
        renew.close();

        advance(25);
        const plannerList = openTestService(repo, AGENTS.planner, now);
        const stillClaimed = plannerList.service.list({ status: ["claimed"] });
        expect(stillClaimed.ok).toBe(true);
        if (!stillClaimed.ok) return;
        expect(stillClaimed.value.some((h) => h.id === id)).toBe(true);
        plannerList.close();
      } finally {
        repo.cleanup();
      }
    });
  });
});
