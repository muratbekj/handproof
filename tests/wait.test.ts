import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { main } from "../src/bin";
import type { Result, ServiceError } from "../src/service/handoffs";
import type { Status } from "../src/schema/handoff";
import { waitForStatus } from "../src/service/wait";

/** Expected shape from src/service/wait.ts (see plan). */
type WaitReady = { id: string; status: Status };
type WaitResult =
  | { timedOut: false; ready: WaitReady[] }
  | { timedOut: true; exitCode: 124; lines: string[] };
import { captureStdoutStderr } from "./helpers/cliCapture";
import { testEnv } from "./helpers/env";
import {
  criteriaFor,
  implementHandoffInput,
  initPhase2Repo,
  withPhase2Clock,
} from "./helpers/phase2Setup";
import { AGENTS, openTestService } from "./helpers/serviceSetup";
import { tmpRepo } from "./helpers/tmpRepo";
import validFixture from "./fixtures/handoffs/valid.json";

const SUMMARY =
  "Implemented auth ok marker file under src/auth and kept edits inside the allowed scope.";
const BIN = path.join(import.meta.dir, "..", "src", "bin.ts");

type StatusesFn = (ids: string[]) => Result<Record<string, Status>>;

type StatusCapable = {
  statuses(ids: string[]): Result<Record<string, Status>>;
};

function serviceStatuses(handle: ReturnType<typeof openTestService>): StatusesFn {
  return (ids) => (handle.service as unknown as StatusCapable).statuses(ids);
}

describe("waitForStatus (plan acceptance 15–22)", () => {
  test("t-ac15: claimed handoff, no --until, submit on 3rd poll", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        initPhase2Repo(repo);
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(implementHandoffInput());
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        expect(worker.service.claim(id).ok).toBe(true);
        fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");

        let polls = 0;
        const sleep = async (): Promise<void> => {
          polls += 1;
          if (polls === 3) {
            await worker.service.submit(id, { summary: SUMMARY, criteria: criteriaFor(["ac1"]) });
          }
        };

        const result = (await waitForStatus([id], {}, {
          sleep,
          now,
          statuses: serviceStatuses(worker),
        })) as WaitResult;
        expect(polls).toBe(3);
        expect(result.timedOut).toBe(false);
        expect(result.ready).toEqual([{ id, status: "submitted" }]);
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("t-ac16: --until verified,changes_requested stops at verified", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        initPhase2Repo(repo);
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(implementHandoffInput());
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        expect(worker.service.claim(id).ok).toBe(true);
        fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");

        let polls = 0;
        const sleep = async (): Promise<void> => {
          polls += 1;
          if (polls === 1) {
            await worker.service.submit(id, { summary: SUMMARY, criteria: criteriaFor(["ac1"]) });
          }
          if (polls === 2) {
            const lead = openTestService(repo, AGENTS.planner, now);
            expect(lead.service.review(id, "accept").ok).toBe(true);
            lead.close();
          }
        };

        const result = (await waitForStatus(
          [id],
          { until: ["verified", "changes_requested"] },
          { sleep, now, statuses: serviceStatuses(worker) },
        )) as WaitResult;
        expect(result.timedOut).toBe(false);
        expect(result.ready).toEqual([{ id, status: "verified" }]);
        expect(polls).toBe(2);
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("t-ac17: already verified with --until verified returns immediately", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        initPhase2Repo(repo);
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(implementHandoffInput());
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        expect(worker.service.claim(id).ok).toBe(true);
        fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");
        await worker.service.submit(id, { summary: SUMMARY, criteria: criteriaFor(["ac1"]) });
        expect(worker.repo.get(id)?.status).toBe("verified");

        let sleeps = 0;
        const sleep = async (): Promise<void> => {
          sleeps += 1;
        };

        const result = (await waitForStatus(
          [id],
          { until: ["verified"] },
          { sleep, now, statuses: serviceStatuses(worker) },
        )) as WaitResult;
        expect(sleeps).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.ready).toEqual([{ id, status: "verified" }]);
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("t-ac18: two ids, second changes first", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        initPhase2Repo(repo);
        const planner = openTestService(repo, AGENTS.planner, now);
        const a = planner.service.create(validFixture);
        const b = planner.service.create({ ...validFixture, title: "Second handoff for wait test" });
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        const id1 = a.value.handoff.id;
        const id2 = b.value.handoff.id;
        planner.close();

        const w1 = openTestService(repo, AGENTS.cursorImpl, now);
        const w2 = openTestService(repo, AGENTS.cursorImpl, now);
        expect(w1.service.claim(id1).ok).toBe(true);
        expect(w2.service.claim(id2).ok).toBe(true);

        let polls = 0;
        const sleep = async (): Promise<void> => {
          polls += 1;
          if (polls === 1) {
            w2.service.release(id2, "done early");
          }
        };

        const reader = openTestService(repo, AGENTS.planner, now);
        const result = (await waitForStatus([id1, id2], {}, {
          sleep,
          now,
          statuses: serviceStatuses(reader),
        })) as WaitResult;
        reader.close();
        expect(result.timedOut).toBe(false);
        expect(result.ready).toEqual([{ id: id2, status: "open" }]);
        w1.close();
        w2.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("t-ac19: lease expiry tick reopens to open", async () => {
    await withPhase2Clock(async (now, advanceMinutes) => {
      const repo = tmpRepo();
      try {
        initPhase2Repo(repo);
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(validFixture);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        expect(worker.service.claim(id).ok).toBe(true);
        worker.close();

        let polls = 0;
        const sleep = async (): Promise<void> => {
          polls += 1;
          advanceMinutes(31);
        };

        const reader = openTestService(repo, AGENTS.planner, now);
        const result = (await waitForStatus([id], {}, {
          sleep,
          now,
          statuses: serviceStatuses(reader),
        })) as WaitResult;
        expect(result.timedOut).toBe(false);
        expect(result.ready).toEqual([{ id, status: "open" }]);
        expect(polls).toBeGreaterThanOrEqual(1);
        reader.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("t-ac20: --timeout 5s with no status change", async () => {
    const repo = tmpRepo();
    try {
      initPhase2Repo(repo);
      let ms = new Date("2026-11-03T12:00:00.000Z").getTime();
      const now = (): Date => new Date(ms);
      const planner = openTestService(repo, AGENTS.planner, now);
      const created = planner.service.create(validFixture);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = created.value.handoff.id;
      planner.close();

      const worker = openTestService(repo, AGENTS.cursorImpl, now);
      expect(worker.service.claim(id).ok).toBe(true);

      const sleep = async (): Promise<void> => {
        ms += 1000;
      };

      const result = (await waitForStatus(
        [id],
        { timeout: "5s" },
        { sleep, now, statuses: serviceStatuses(worker) },
      )) as WaitResult;
      expect(result.timedOut).toBe(true);
      if (result.timedOut) {
        expect(result.exitCode).toBe(124);
        expect(result.lines).toEqual([`${id} claimed (timeout)`]);
      }
      worker.close();
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac21: bad wait CLI args and unknown id", async () => {
    const repo = tmpRepo();
    try {
      initPhase2Repo(repo);
      const env = testEnv({ HANDOFFS_REPO: repo.dir });

      const noIds = await captureStdoutStderr(() => main(["wait"], env, repo.dir));
      expect(noIds.code).toBe(2);
      expect(noIds.err.toLowerCase()).toMatch(/usage/);

      const badUntil = await captureStdoutStderr(() =>
        main(["wait", "h_x", "--until", "bogus"], env, repo.dir),
      );
      expect(badUntil.code).toBe(2);
      expect(badUntil.err.toLowerCase()).toMatch(/usage/);

      for (const t of ["0s", "5", "1.5m", "-1s"]) {
        const bad = await captureStdoutStderr(() =>
          main(["wait", "h_x", "--timeout", t], env, repo.dir),
        );
        expect(bad.code).toBe(2);
        expect(bad.err.toLowerCase()).toMatch(/usage/);
      }

      const missing = await captureStdoutStderr(() => main(["wait", "h_nope"], env, repo.dir));
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("not_found");
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac22: db_busy on one poll then success", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        initPhase2Repo(repo);
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(validFixture);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        expect(worker.service.claim(id).ok).toBe(true);

        let statusReads = 0;
        const sleep = async (): Promise<void> => {
          worker.service.release(id, "done");
        };

        const statuses: StatusesFn = (ids) => {
          statusReads += 1;
          if (statusReads === 1) {
            return { ok: false, error: { error: "db_busy", message: "busy", retryable: true } as ServiceError };
          }
          return serviceStatuses(worker)(ids);
        };

        const result = (await waitForStatus([id], {}, { sleep, now, statuses })) as WaitResult;
        expect(result.timedOut).toBe(false);
        expect(result.ready).toEqual([{ id, status: "open" }]);
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });
});

describe("handoffs wait CLI (t-ac23)", () => {
  test("subprocess exits 0 when handoff becomes verified; SIGINT exits 130", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        initPhase2Repo(repo);
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(implementHandoffInput());
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        expect(worker.service.claim(id).ok).toBe(true);
        worker.close();

        const env = {
          ...testEnv({ HANDOFFS_REPO: repo.dir }),
          HANDOFFS_AGENT: "human-cli",
          HANDOFFS_HARNESS: "other",
        };

        const proc = Bun.spawn(["bun", BIN, "wait", id, "--until", "verified"], {
          cwd: repo.dir,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });

        await Bun.sleep(200);
        const actor = openTestService(repo, AGENTS.cursorImpl, now);
        fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");
        await actor.service.submit(id, { summary: SUMMARY, criteria: criteriaFor(["ac1"]) });
        actor.close();

        const stdout = await proc.stdout.text();
        const code = await proc.exited;
        expect(code).toBe(0);
        expect(stdout.trim()).toBe(`${id} verified`);

        const repo2 = tmpRepo();
        try {
          initPhase2Repo(repo2);
          const p2 = openTestService(repo2, AGENTS.planner, now);
          const h = p2.service.create(validFixture);
          expect(h.ok).toBe(true);
          if (!h.ok) return;
          const id2 = h.value.handoff.id;
          p2.close();
          const w = openTestService(repo2, AGENTS.cursorImpl, now);
          expect(w.service.claim(id2).ok).toBe(true);
          w.close();

          const waiter = Bun.spawn(["bun", BIN, "wait", id2], {
            cwd: repo2.dir,
            env: testEnv({ HANDOFFS_REPO: repo2.dir }),
            stdout: "pipe",
            stderr: "pipe",
          });
          await Bun.sleep(300);
          waiter.kill("SIGINT");
          expect(await waiter.exited).toBe(130);
        } finally {
          repo2.cleanup();
        }
      } finally {
        repo.cleanup();
      }
    });
  });
});

describe("README wait (t-ac24)", () => {
  test("README lists handoffs wait with --until and --timeout", () => {
    const readme = fs.readFileSync(path.join(import.meta.dir, "..", "README.md"), "utf8");
    expect(readme).toContain("handoffs wait");
    expect(readme).toContain("--until");
    expect(readme).toContain("--timeout");
  });
});
