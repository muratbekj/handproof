import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import validFixture from "./fixtures/handoffs/valid.json";
import { AGENTS, openTestService } from "./helpers/serviceSetup";
import { removeDir, tmpDir } from "./helpers/tmp";
import { tmpRepo, type TmpRepo } from "./helpers/tmpRepo";
import { toSummary, type HandoffSummary } from "../src/service/handoffs";

const T0 = new Date("2026-11-03T12:00:00.000Z");
const SUMMARY_KEYS: (keyof HandoffSummary)[] = [
  "id",
  "title",
  "kind",
  "status",
  "priority",
  "to",
  "from",
  "claimBy",
  "leaseUntil",
  "task",
  "createdAt",
];

function isoPlusMinutes(base: Date, minutes: number): string {
  return new Date(base.getTime() + minutes * 60_000).toISOString();
}

function withClock<T>(fn: (now: () => Date, advance: (m: number) => void) => T): T {
  let ms = T0.getTime();
  const now = (): Date => new Date(ms);
  const advance = (minutes: number): void => {
    ms += minutes * 60_000;
  };
  return fn(now, advance);
}

function withRepoService(
  agent: typeof AGENTS.planner,
  fn: (ctx: ReturnType<typeof openTestService>, repo: TmpRepo) => void,
): void {
  withClock((now) => {
    const repo = tmpRepo();
    try {
      fn(openTestService(repo, agent, now), repo);
    } finally {
      repo.cleanup();
    }
  });
}

function expectErr(
  result: { ok: boolean; error?: { error: string; [k: string]: unknown } },
  code: string,
): { ok: false; error: { error: string; [k: string]: unknown } } {
  expect(result.ok).toBe(false);
  if (result.ok || result.error === undefined) {
    throw new Error(`expected error ${code}`);
  }
  expect(result.error.error).toBe(code);
  return { ok: false, error: result.error };
}

describe("HandoffService", () => {
  test("create records repo metadata, open status, and a created event", () => {
    withRepoService(AGENTS.planner, (ctx, gitRepo) => {
      fs.mkdirSync(path.join(gitRepo.dir, "src", "auth"), { recursive: true });
      fs.writeFileSync(path.join(gitRepo.dir, "src", "auth", "token.ts"), "export {};\n");

      const created = ctx.service.create(validFixture);
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const { handoff, warnings } = created.value;
      expect(handoff.status).toBe("open");
      expect(handoff.repo.branch).toBe("main");
      expect(handoff.repo.baseCommit).toBeTruthy();
      expect(ctx.repo.events(handoff.id).map((e) => e.type)).toEqual(["created"]);
      expect(warnings).toEqual([]);
    });
  });

  test("create rejects invalid input with validation_failed issues", () => {
    withRepoService(AGENTS.planner, ({ service }) => {
      const bad = service.create({ ...validFixture, title: "short" });
      const err = expectErr(bad, "validation_failed");
      expect(Array.isArray(err.error.issues)).toBe(true);
    });
  });

  test("create warns when a referenced file is missing but still succeeds", () => {
    withRepoService(AGENTS.planner, ({ service }) => {
      const input = {
        ...validFixture,
        context: {
          ...validFixture.context,
          files: [{ path: "src/new.ts", why: "Does not exist yet." }],
        },
      };
      const result = service.create(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.warnings).toHaveLength(1);
    });
  });

  test("create fails with no_commits in an empty git repo", () => {
    withClock((now) => {
      const dir = tmpDir("handoffs-no-commits-");
      try {
        Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
        Bun.spawnSync(["git", "config", "user.email", "t@example.com"], { cwd: dir });
        Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: dir });
        fs.writeFileSync(path.join(dir, "README.md"), "x\n");

        const fakeRepo = {
          dir,
          git: (args: string | readonly string[]) => {
            const argv = typeof args === "string" ? [args] : [...args];
            const r = Bun.spawnSync(["git", ...argv], { cwd: dir, stdout: "pipe", stderr: "pipe" });
            if (r.exitCode !== 0) throw new Error(r.stderr.toString());
            return r.stdout.toString().trimEnd();
          },
          worktree: () => {
            throw new Error("not used");
          },
          cleanup: () => {
            removeDir(dir);
          },
        } satisfies TmpRepo;

        const handle = openTestService(fakeRepo, AGENTS.planner, now);
        try {
          expectErr(handle.service.create(validFixture), "no_commits");
        } finally {
          handle.close();
        }
      } finally {
        removeDir(dir);
      }
    });
  });

  test("claim sets lease, enforces already_claimed, and is idempotent for the claimant", () => {
    withClock((now, advance) => {
      const repo = tmpRepo();
      try {
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(validFixture);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;

        planner.close();

        const cursor = openTestService(repo, AGENTS.cursorImpl, now);
        const claim = cursor.service.claim(id);
        expect(claim.ok).toBe(true);
        if (!claim.ok) return;
        expect(claim.value.status).toBe("claimed");
        expect(claim.value.claim?.leaseUntil).toBe(isoPlusMinutes(T0, 30));

        const other = openTestService(repo, AGENTS.planner, now);
        const blocked = expectErr(other.service.claim(id), "already_claimed");
        expect(blocked.error.by).toBe("cursor-impl");
        other.close();

        advance(1);
        const again = cursor.service.claim(id);
        expect(again.ok).toBe(true);
        expect(cursor.repo.events(id).filter((e) => e.type === "claimed")).toHaveLength(1);
        cursor.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("claim without id picks the highest-priority candidate for cursor-impl", () => {
    withClock((now) => {
      const repo = tmpRepo();
      try {
        const planner = openTestService(repo, AGENTS.planner, now);
        const mk = (to: string, priority: "low" | "normal" | "high", title: string) => {
          const r = planner.service.create({
            ...validFixture,
            title: `${title} handoff title`,
            to,
            priority,
          });
          expect(r.ok).toBe(true);
        };
        mk("any", "normal", "Normal any");
        mk("cursor-impl", "high", "High cursor");
        mk("planner", "high", "High planner");
        mk("any", "low", "Low any");
        planner.close();

        const cursor = openTestService(repo, AGENTS.cursorImpl, now);
        const claim = cursor.service.claim();
        expect(claim.ok).toBe(true);
        if (!claim.ok) return;
        expect(claim.value.to).toBe("cursor-impl");
        expect(claim.value.priority).toBe("high");
        cursor.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("claim without id returns nothing_to_claim when no open candidates remain", () => {
    withClock((now) => {
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
        expectErr(cursor.service.claim(), "nothing_to_claim");
        cursor.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("claim enforces not_addressed_to_you unless the caller is human", () => {
    withClock((now) => {
      const repo = tmpRepo();
      try {
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create({ ...validFixture, to: "planner" });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const cursor = openTestService(repo, AGENTS.cursorImpl, now);
        const blocked = expectErr(cursor.service.claim(id), "not_addressed_to_you");
        expect(blocked.error.to).toBe("planner");
        cursor.close();

        const human = openTestService(repo, AGENTS.humanMj, now);
        expect(human.service.claim(id).ok).toBe(true);
        human.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("update requires the claimant and renews the lease", () => {
    withClock((now, advance) => {
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

        advance(10);
        const plannerAgain = openTestService(repo, AGENTS.planner, now);
        const denied = expectErr(plannerAgain.service.update(id, "note from planner"), "not_permitted");
        expect(denied.error.reason).toBe("only the claimant may update");
        plannerAgain.close();

        const cursorAgain = openTestService(repo, AGENTS.cursorImpl, now);
        const updated = cursorAgain.service.update(id, "progress note here");
        expect(updated.ok).toBe(true);
        if (!updated.ok) return;
        expect(updated.value.claim?.leaseUntil).toBe(isoPlusMinutes(T0, 40));
        const ev = cursorAgain.repo.events(id).find((e) => e.type === "updated");
        expect(ev?.data.note).toBe("progress note here");
        expect(ev?.data.leaseUntil).toBe(isoPlusMinutes(T0, 40));
        cursorAgain.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("release opens the handoff and validates the reason", () => {
    withClock((now) => {
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
        expectErr(cursor.service.release(id, ""), "validation_failed");
        const released = cursor.service.release(id, "done for now");
        expect(released.ok).toBe(true);
        if (!released.ok) return;
        expect(released.value.status).toBe("open");
        expect(released.value.claim).toBeNull();
        const ev = cursor.repo.events(id).find((e) => e.type === "released");
        expect(ev?.data.reason).toBe("done for now");

        cursor.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("cancel permissions and second cancel invalid_transition", () => {
    withClock((now) => {
      const repo = tmpRepo();
      try {
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(validFixture);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const cursor = openTestService(repo, AGENTS.cursorImpl, now);
        expectErr(cursor.service.cancel(id), "not_permitted");
        cursor.close();

        const plannerAgain = openTestService(repo, AGENTS.planner, now);
        expect(plannerAgain.service.cancel(id).ok).toBe(true);
        const again = expectErr(plannerAgain.service.cancel(id), "invalid_transition");
        expect(again.error.reason).toBe("cannot cancel a handoff that is cancelled");
        plannerAgain.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("unknown id returns not_found for mutating and read methods", () => {
    withRepoService(AGENTS.planner, ({ service }) => {
      const id = "h_01JC0000000000000000000000";
      for (const call of [
        () => service.get(id),
        () => service.claim(id),
        () => service.update(id, "note"),
        () => service.release(id, "reason"),
        () => service.cancel(id),
      ]) {
        const result = call();
        const err = expectErr(result, "not_found");
        expect(err.error.id).toBe(id);
      }
    });
  });

  test("list defaults and mine filter return HandoffSummary-shaped rows", () => {
    withClock((now) => {
      const repo = tmpRepo();
      try {
        const planner = openTestService(repo, AGENTS.planner, now);
        const a = planner.service.create(validFixture);
        const b = planner.service.create({ ...validFixture, title: "Second valid handoff title" });
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        const id = a.value.handoff.id;
        planner.close();

        const cursor = openTestService(repo, AGENTS.cursorImpl, now);
        expect(cursor.service.claim(id).ok).toBe(true);
        cursor.close();

        const lister = openTestService(repo, AGENTS.cursorImpl, now);
        const all = lister.service.list();
        expect(all.ok).toBe(true);
        if (!all.ok) return;
        expect(all.value.some((h) => h.status === "cancelled")).toBe(false);

        const mine = lister.service.list({ mine: true });
        expect(mine.ok).toBe(true);
        if (!mine.ok) return;
        expect(mine.value.every((h) => h.from === "cursor-impl" || h.claimBy === "cursor-impl")).toBe(
          true,
        );

        for (const row of mine.value) {
          expect(Object.keys(row).sort()).toEqual([...SUMMARY_KEYS].sort());
          const stored = lister.repo.get(row.id);
          expect(stored).not.toBeNull();
          if (stored) {
            expect(toSummary(stored)).toEqual(row);
          }
        }
        lister.close();
      } finally {
        repo.cleanup();
      }
    });
  });
});
