import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENTS, openTestService, writeConfig } from "./helpers/serviceSetup";
import {
  criteriaFor,
  implementHandoffInput,
  initPhase2Repo,
  withPhase2Clock,
} from "./helpers/phase2Setup";
import { tmpRepo } from "./helpers/tmpRepo";

const SUMMARY =
  "Implemented auth ok marker file under src/auth and kept edits inside the allowed scope.";

function expectErr(
  result: { ok: boolean; error?: { error: string; [k: string]: unknown } },
  code: string,
) {
  expect(result.ok).toBe(false);
  if (result.ok || result.error === undefined) throw new Error(`expected ${code}`);
  expect(result.error.error).toBe(code);
  return result.error;
}

function claimAndPrepareOkFile(
  repo: ReturnType<typeof tmpRepo>,
  now: () => Date,
  input = implementHandoffInput(),
) {
  const paths = initPhase2Repo(repo);
  const planner = openTestService(repo, AGENTS.planner, now);
  const created = planner.service.create(input);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("create failed");
  const id = created.value.handoff.id;
  planner.close();

  const worker = openTestService(repo, AGENTS.cursorImpl, now);
  expect(worker.service.claim(id).ok).toBe(true);
  fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");
  return { id, worker, paths };
}

describe("submit, verify, and review (PLAN Step 5)", () => {
  test("okfile check and in-scope edits → verified with passed verification", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const { id, worker } = claimAndPrepareOkFile(repo, now);
        const submitted = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) return;
        expect(submitted.value.handoff.status).toBe("verified");
        expect(submitted.value.verification.passed).toBe(true);
        const types = worker.repo.events(id).map((e) => e.type);
        expect(types.slice(-2)).toEqual(["submitted", "verified"]);
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("package.json violation → changes_requested with scope violations and renewed lease", async () => {
    await withPhase2Clock(async (now, advance) => {
      const repo = tmpRepo();
      try {
        const { id, worker } = claimAndPrepareOkFile(repo, now);
        fs.writeFileSync(path.join(repo.dir, "package.json"), '{"name":" touched"}\n');
        const submitted = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) return;
        expect(submitted.value.handoff.status).toBe("changes_requested");
        expect(submitted.value.verification.scope.violations).toEqual([
          { path: "package.json", rule: "outside src/auth/**" },
        ]);
        advance(0);
        const lease = submitted.value.handoff.claim?.leaseUntil;
        expect(lease).toBe(new Date(now().getTime() + 30 * 60_000).toISOString());
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("resubmit after reverting package.json → verified", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const { id, worker } = claimAndPrepareOkFile(repo, now);
        fs.writeFileSync(path.join(repo.dir, "package.json"), "{}\n");
        await worker.service.submit(id, { summary: SUMMARY, criteria: criteriaFor(["ac1"]) });
        fs.rmSync(path.join(repo.dir, "package.json"), { force: true });
        const again = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(again.ok).toBe(true);
        if (!again.ok) return;
        expect(again.value.handoff.status).toBe("verified");
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("check-backed criterion ignores self-report; failing check → changes_requested", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const input = implementHandoffInput([
          { id: "ac1", description: "Fail check overrides self report.", check: "fail" },
        ]);
        const { id, worker } = claimAndPrepareOkFile(repo, now, input);
        const submitted = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: [{ id: "ac1", met: true }],
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) return;
        expect(submitted.value.handoff.status).toBe("changes_requested");
        const crit = submitted.value.verification.criteria.find((c) => c.id === "ac1");
        expect(crit).toEqual({ id: "ac1", met: false, source: "check", check: "fail" });
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("self-reported unmet criterion without check → changes_requested", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const input = implementHandoffInput([
          { id: "ac1", description: "Manual criterion only.", check: undefined },
        ]);
        const { id, worker } = claimAndPrepareOkFile(repo, now, input);
        const submitted = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: [{ id: "ac1", met: false }],
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) return;
        expect(submitted.value.handoff.status).toBe("changes_requested");
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("missing criterion id → validation_failed, status unchanged", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const input = implementHandoffInput([
          { id: "ac1", description: "First.", check: "okfile" },
          { id: "ac2", description: "Second.", check: "okfile" },
        ]);
        const { id, worker } = claimAndPrepareOkFile(repo, now, input);
        const before = worker.repo.get(id)?.status;
        const bad = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: [{ id: "ac1", met: true }],
        });
        const err = expectErr(bad, "validation_failed");
        const issue = (err.issues as { path: string; problem: string }[]).find((i) => i.path === "criteria");
        expect(issue?.problem).toMatch(/missing criteria for: ac2/);
        expect(worker.repo.get(id)?.status).toBe(before);
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("slow check times out → changes_requested", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const input = implementHandoffInput([
          { id: "ac1", description: "Slow check.", check: "slow" },
        ]);
        const { id, worker } = claimAndPrepareOkFile(repo, now, input);
        const submitted = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) return;
        expect(submitted.value.handoff.status).toBe("changes_requested");
        expect(submitted.value.verification.checks.some((c) => c.timedOut)).toBe(true);
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("unknown check after config change → changes_requested, no throw", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const { id, worker, paths } = claimAndPrepareOkFile(repo, now);
        writeConfig(paths, { leaseMinutes: 30, checks: {} });
        const submitted = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) return;
        expect(submitted.value.handoff.status).toBe("changes_requested");
        expect(submitted.value.verification.checks.some((c) => c.error === "unknown_check")).toBe(true);
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("submit permissions and invalid transitions", async () => {
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

        const plannerAgain = openTestService(repo, AGENTS.planner, now);
        expectErr(
          await plannerAgain.service.submit(id, { summary: SUMMARY, criteria: criteriaFor(["ac1"]) }),
          "not_permitted",
        );
        plannerAgain.close();

        const openHandoff = openTestService(repo, AGENTS.planner, now);
        const second = openHandoff.service.create({
          ...implementHandoffInput(),
          title: "Second open handoff for submit test",
        });
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        openHandoff.close();

        const workerAgain = openTestService(repo, AGENTS.cursorImpl, now);
        expectErr(
          await workerAgain.service.submit(second.value.handoff.id, {
            summary: SUMMARY,
            criteria: criteriaFor(["ac1"]),
          }),
          "invalid_transition",
        );
        workerAgain.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("past verification deadline on tick → changes_requested and verification_interrupted", () => {
    withPhase2Clock((now) => {
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
        worker.repo.transitionState(
          id,
          { status: "claimed", claimBy: "cursor-impl" },
          {
            status: "submitted",
            claim: {
              by: AGENTS.cursorImpl,
              leaseUntil: "2026-11-03T11:00:00.000Z",
            },
            updatedAt: now().toISOString(),
          },
          { at: now().toISOString(), actor: "cursor-impl", type: "submitted", data: {} },
        );
        worker.close();

        const reader = openTestService(repo, AGENTS.planner, now);
        expect(reader.service.get(id).ok).toBe(true);
        const row = reader.repo.get(id);
        expect(row?.status).toBe("changes_requested");
        expect(reader.repo.events(id).some((e) => e.type === "verification_interrupted")).toBe(true);
        reader.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("verify by creator on claimed leaves status and appends verification event", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const { id, worker } = claimAndPrepareOkFile(repo, now);
        worker.close();
        const planner = openTestService(repo, AGENTS.planner, now);
        const verified = await planner.service.verify(id);
        expect(verified.ok).toBe(true);
        if (!verified.ok) return;
        expect(planner.repo.get(id)?.status).toBe("claimed");
        expect(planner.repo.events(id).filter((e) => e.type === "verification")).toHaveLength(1);
        expect(verified.value.verification.passed).toBeTypeOf("boolean");
        planner.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("review accept and reject rules", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const { id, worker } = claimAndPrepareOkFile(repo, now);
        const done = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(done.ok).toBe(true);
        if (!done.ok) return;
        expect(done.value.handoff.status).toBe("verified");

        expectErr(worker.service.review(id, "accept"), "not_permitted");

        const planner = openTestService(repo, AGENTS.planner, now);
        expect(planner.service.review(id, "accept").ok).toBe(true);
        expect(planner.repo.get(id)?.status).toBe("done");
        expect(planner.repo.events(id).some((e) => e.type === "accepted")).toBe(true);
        planner.close();

        const repo2 = tmpRepo();
        try {
          const ctx = claimAndPrepareOkFile(repo2, now);
          const sub = await ctx.worker.service.submit(ctx.id, {
            summary: SUMMARY,
            criteria: criteriaFor(["ac1"]),
          });
          expect(sub.ok).toBe(true);
          if (!sub.ok) return;
          const human = openTestService(repo2, AGENTS.humanMj, now);
          expect(human.service.review(ctx.id, "accept").ok).toBe(true);
          human.close();
          ctx.worker.close();
        } finally {
          repo2.cleanup();
        }

        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("review reject requires reason and resets handoff context", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const { id, worker } = claimAndPrepareOkFile(repo, now);
        const sub = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(sub.ok).toBe(true);
        if (!sub.ok) return;
        worker.close();

        const planner = openTestService(repo, AGENTS.planner, now);
        expectErr(planner.service.review(id, "reject"), "validation_failed");
        const rejected = planner.service.review(id, "reject", "tests are flaky");
        expect(rejected.ok).toBe(true);
        if (!rejected.ok) return;
        const h = rejected.value;
        expect(h.status).toBe("open");
        expect(h.claim).toBeNull();
        expect(h.result).toBeNull();
        const tried = h.context.tried.at(-1);
        expect(tried).toEqual({ approach: SUMMARY, outcome: "rejected: tests are flaky" });
        planner.close();
      } finally {
        repo.cleanup();
      }
    });
  });
});
