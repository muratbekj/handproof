import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import validFixture from "./fixtures/handoffs/valid.json";
import { AGENTS, openTestService } from "./helpers/serviceSetup";
import { tmpRepo } from "./helpers/tmpRepo";

const WORKER = path.join(import.meta.dir, "helpers", "claimWorker.ts");
const PROJECT_ROOT = path.join(import.meta.dir, "..");
const ROUNDS = 50;
const SAME_NAME_ROUNDS = 20;
const SAME_NAME_AGENT = "race-same-agent";

interface WorkerResult {
  ok: boolean;
  id?: string;
  claimBy?: string | null;
  error?: { error: string; [k: string]: unknown };
}

function isWorkerResult(message: unknown): message is WorkerResult {
  return typeof message === "object" && message !== null && "ok" in message;
}

function spawnClaimWorker(repoDir: string, agentName: string, handoffId: string) {
  let resolveReady!: () => void;
  let resolveResult!: (result: WorkerResult) => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const result = new Promise<WorkerResult>((resolve) => {
    resolveResult = resolve;
  });

  const proc = Bun.spawn(["bun", WORKER, repoDir, agentName, handoffId], {
    cwd: PROJECT_ROOT,
    ipc(message) {
      if (message === "ready") {
        resolveReady();
        return;
      }
      if (isWorkerResult(message)) {
        resolveResult(message);
      }
    },
    serialization: "json",
    stdout: "ignore",
    stderr: "pipe",
  });

  return { proc, ready, result };
}

describe("claim race", () => {
  test(
    "two workers contending on the same id produce one winner per round",
    async () => {
      const repo = tmpRepo();
      try {
        const planner = openTestService(repo, AGENTS.planner);
        let claimedEvents = 0;

        for (let round = 0; round < ROUNDS; round += 1) {
          const created = planner.service.create({
            ...validFixture,
            title: `Race handoff round ${String(round).padStart(2, "0")}`,
          });
          expect(created.ok).toBe(true);
          if (!created.ok) return;
          const id = created.value.handoff.id;

          const a = spawnClaimWorker(repo.dir, "race-agent-a", id);
          const b = spawnClaimWorker(repo.dir, "race-agent-b", id);

          await Promise.all([a.ready, b.ready]);
          a.proc.send("go");
          b.proc.send("go");

          const [ra, rb] = await Promise.all([a.result, b.result]);

          const wins = [ra, rb].filter((r) => r.ok).length;
          expect(wins).toBe(1);
          const loser = ra.ok ? rb : ra;
          expect(loser.ok).toBe(false);
          if (!loser.ok) {
            expect(loser.error?.error).toBe("already_claimed");
          }

          await Promise.all([a.proc.exited, b.proc.exited]);
          claimedEvents += planner.repo
            .events(id)
            .filter((e) => e.type === "claimed").length;
        }

        expect(claimedEvents).toBe(ROUNDS);
        planner.close();
      } finally {
        repo.cleanup();
      }
    },
    120_000,
  );

  test(
    "same agent name: both workers succeed with one claimed event per round",
    async () => {
      const repo = tmpRepo();
      try {
        const planner = openTestService(repo, AGENTS.planner);

        for (let round = 0; round < SAME_NAME_ROUNDS; round += 1) {
          const created = planner.service.create({
            ...validFixture,
            title: `Same-name race round ${String(round).padStart(2, "0")}`,
          });
          expect(created.ok).toBe(true);
          if (!created.ok) return;
          const id = created.value.handoff.id;

          const a = spawnClaimWorker(repo.dir, SAME_NAME_AGENT, id);
          const b = spawnClaimWorker(repo.dir, SAME_NAME_AGENT, id);

          await Promise.all([a.ready, b.ready]);
          a.proc.send("go");
          b.proc.send("go");

          const [ra, rb] = await Promise.all([a.result, b.result]);

          expect(ra.ok).toBe(true);
          expect(rb.ok).toBe(true);
          expect(ra.id).toBe(id);
          expect(rb.id).toBe(id);
          expect(ra.claimBy).toBe(SAME_NAME_AGENT);
          expect(rb.claimBy).toBe(SAME_NAME_AGENT);
          expect(ra.claimBy).toBe(rb.claimBy);

          await Promise.all([a.proc.exited, b.proc.exited]);

          const claimedCount = planner.repo
            .events(id)
            .filter((e) => e.type === "claimed").length;
          expect(claimedCount).toBe(1);
        }

        planner.close();
      } finally {
        repo.cleanup();
      }
    },
    120_000,
  );
});
