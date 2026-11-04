import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { main } from "../src/bin";
import { parseTimeout, waitForStatus, type StatusReader } from "../src/service/wait";
import { captureStderr, captureStdoutStderr } from "./helpers/cliCapture";
import { testEnv } from "./helpers/env";
import {
  criteriaFor,
  implementHandoffInput,
  initPhase2Repo,
  withPhase2Clock,
} from "./helpers/phase2Setup";
import { AGENTS, openTestService, type ServiceHandle } from "./helpers/serviceSetup";
import { tmpRepo } from "./helpers/tmpRepo";
import validFixture from "./fixtures/handoffs/valid.json";

const SUMMARY =
  "Implemented auth ok marker file under src/auth and kept edits inside the allowed scope.";
const BIN = path.join(import.meta.dir, "..", "src", "bin.ts");
const FAST_POLL_MS = 1;

function statusReader(handle: ServiceHandle): StatusReader {
  return { statuses: (ids) => handle.service.statuses(ids) };
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

        let sleeps = 0;
        const sleep = (_ms: number): Promise<void> => {
          sleeps += 1;
          if (sleeps === 3) {
            return worker.service
              .submit(id, { summary: SUMMARY, criteria: criteriaFor(["ac1"]) })
              .then(() => undefined);
          }
          return Promise.resolve();
        };

        const hits = await waitForStatus(
          [id],
          { intervalMs: FAST_POLL_MS },
          { service: statusReader(worker), sleep, now },
        );
        expect(sleeps).toBe(3);
        expect(hits).toEqual([{ id, status: "verified" }]);
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

        let sleeps = 0;
        const sleep = (_ms: number): Promise<void> => {
          sleeps += 1;
          if (sleeps === 1) {
            return worker.service
              .submit(id, { summary: SUMMARY, criteria: criteriaFor(["ac1"]) })
              .then(() => undefined);
          }
          return Promise.resolve();
        };

        const hits = await waitForStatus(
          [id],
          { until: ["verified", "changes_requested"], intervalMs: FAST_POLL_MS },
          { service: statusReader(worker), sleep, now },
        );
        expect(hits).toEqual([{ id, status: "verified" }]);
        expect(sleeps).toBe(1);
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
        const sleep = (_ms: number): Promise<void> => {
          sleeps += 1;
          return Promise.resolve();
        };

        const hits = await waitForStatus(
          [id],
          { until: ["verified"], intervalMs: FAST_POLL_MS },
          { service: statusReader(worker), sleep, now },
        );
        expect(sleeps).toBe(0);
        expect(hits).toEqual([{ id, status: "verified" }]);
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

        let sleeps = 0;
        const sleep = (_ms: number): Promise<void> => {
          sleeps += 1;
          if (sleeps === 1) {
            w2.service.release(id2, "done early");
          }
          return Promise.resolve();
        };

        const reader = openTestService(repo, AGENTS.planner, now);
        const hits = await waitForStatus(
          [id1, id2],
          { intervalMs: FAST_POLL_MS },
          { service: statusReader(reader), sleep, now },
        );
        reader.close();
        expect(hits).toEqual([{ id: id2, status: "open" }]);
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

        let sleeps = 0;
        const sleep = (_ms: number): Promise<void> => {
          sleeps += 1;
          advanceMinutes(31);
          return Promise.resolve();
        };

        const reader = openTestService(repo, AGENTS.planner, now);
        const hits = await waitForStatus(
          [id],
          { intervalMs: FAST_POLL_MS },
          { service: statusReader(reader), sleep, now },
        );
        expect(hits).toEqual([{ id, status: "open" }]);
        expect(sleeps).toBeGreaterThanOrEqual(1);
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

      const timeoutMs = parseTimeout("5s");
      expect(timeoutMs).toBe(5000);

      const sleep = (_ms: number): Promise<void> => {
        ms += 1000;
        return Promise.resolve();
      };

      const hits = await waitForStatus(
        [id],
        { timeoutMs: timeoutMs ?? undefined, intervalMs: 1000 },
        { service: statusReader(worker), sleep, now },
      );
      expect(hits).toEqual([{ id, status: "claimed", timedOut: true }]);
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

      const missing = await captureStderr(() => main(["wait", "h_nope"], env, repo.dir));
      expect(missing.result).toBe(1);
      expect(missing.stderr).toContain("not_found");
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
        const sleep = (_ms: number): Promise<void> => {
          worker.service.release(id, "done");
          return Promise.resolve();
        };

        const base = statusReader(worker);
        const service: StatusReader = {
          statuses(ids) {
            statusReads += 1;
            if (statusReads === 2) {
              return {
                ok: false,
                error: { error: "db_busy", message: "busy", retryable: true },
              };
            }
            return base.statuses(ids);
          },
        };

        const hits = await waitForStatus(
          [id],
          { intervalMs: FAST_POLL_MS },
          { service, sleep, now },
        );
        expect(hits).toEqual([{ id, status: "open" }]);
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });
});

describe("handoffs wait CLI (t-ac23)", () => {
  test("subprocess exits 0 when handoff becomes verified; SIGINT exits 130", async () => {
    const repo = tmpRepo();
    try {
      initPhase2Repo(repo);
      const planner = openTestService(repo, AGENTS.planner);
      const created = planner.service.create(implementHandoffInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = created.value.handoff.id;
      planner.close();

      const worker = openTestService(repo, AGENTS.cursorImpl);
      expect(worker.service.claim(id).ok).toBe(true);
      worker.close();

      const env = testEnv({
        HANDOFFS_REPO: repo.dir,
        HANDOFFS_AGENT: "human-cli",
        HANDOFFS_HARNESS: "other",
      });

      const proc = Bun.spawn(["bun", BIN, "wait", id, "--until", "verified"], {
        cwd: repo.dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      await Bun.sleep(200);
      const actor = openTestService(repo, AGENTS.cursorImpl);
      fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, "src/auth/ok.txt"), "ok\n");
      const submitted = await actor.service.submit(id, {
        summary: SUMMARY,
        criteria: criteriaFor(["ac1"]),
      });
      expect(submitted.ok).toBe(true);
      actor.close();

      const code = await proc.exited;
      const out = await proc.stdout.text();
      expect(code).toBe(0);
      expect(out.trim()).toBe(`${id} verified`);

      const repo2 = tmpRepo();
      try {
        initPhase2Repo(repo2);
        const p2 = openTestService(repo2, AGENTS.planner);
        const h = p2.service.create(validFixture);
        expect(h.ok).toBe(true);
        if (!h.ok) return;
        const id2 = h.value.handoff.id;
        p2.close();
        const w = openTestService(repo2, AGENTS.cursorImpl);
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

describe("README wait (t-ac24)", () => {
  test("README lists handoffs wait with --until and --timeout", () => {
    const readme = fs.readFileSync(path.join(import.meta.dir, "..", "README.md"), "utf8");
    expect(readme).toContain("handoffs wait");
    expect(readme).toContain("--until");
    expect(readme).toContain("--timeout");
  });
});
