import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { main } from "../src/bin";
import { loadConfig } from "../src/config";
import type { Task } from "../src/schema/task";
import { openService } from "../src/service/open";
import { captureStderr, captureStdout } from "./helpers/cliCapture";
import { testEnv } from "./helpers/env";
import { initRepoHandoffs } from "./helpers/serviceSetup";
import { VALID_PAYLOADS } from "./helpers/taskFixtures";
import { type TmpRepo, tmpRepo } from "./helpers/tmpRepo";

let repo: TmpRepo;

async function cli(argv: string[], extra: Record<string, string> = {}) {
  const env = testEnv({ HANDPROOF_REPO: repo.dir, ...extra });
  const { result, stderr } = await captureStderr(() => captureStdout(() => main(argv, env, repo.dir)));
  return { code: result.code, out: result.out, err: stderr };
}

/** A task created by `lead` and moved to awaiting_plan_approval. */
function taskAtPlanGate(): Task {
  const paths = initRepoHandoffs(repo);
  const h = openService({ paths, config: loadConfig(paths), agent: { name: "lead", harness: "other" } });
  try {
    const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    };
    const t = must(h.tasks.create({ goal: "Add rate limiting to POST /login" }));
    must(h.tasks.transition(t.id, "researching", VALID_PAYLOADS["new>researching"]));
    must(h.tasks.transition(t.id, "planning", VALID_PAYLOADS["researching>planning"]));
    return must(
      h.tasks.transition(t.id, "awaiting_plan_approval", {
        ...VALID_PAYLOADS["planning>awaiting_plan_approval"],
        brief: "Approach: token bucket per IP",
      }),
    ).task;
  } finally {
    h.close();
  }
}

beforeEach(() => {
  repo = tmpRepo();
  fs.mkdirSync(path.join(repo.dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, "notes/RESEARCH.md"), "# r\n");
  fs.writeFileSync(path.join(repo.dir, "notes/PLAN.md"), "# p\n");
});

afterEach(() => {
  repo.cleanup();
});

describe("task CLI", () => {
  test("approve at the plan gate prints the new status", async () => {
    const t = taskAtPlanGate();
    const r = await cli(["approve", t.id, "looks", "good"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${t.id} building\n`);
    const show = await cli(["task", "show", t.id]);
    expect(show.out).toContain("looks good");
    expect(show.out).toContain("plan approved at");
  });

  test("reject sends the task back to planning with the comment", async () => {
    const t = taskAtPlanGate();
    const r = await cli(["reject", t.id, "split", "step", "3"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${t.id} planning\n`);
    expect((await cli(["task", "show", t.id])).out).toContain("split step 3");
  });

  test("an agent identity can't approve", async () => {
    const t = taskAtPlanGate();
    const r = await cli(["approve", t.id], { HANDPROOF_AGENT: "lead" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("not_permitted");
  });

  test("reject without a comment and bad --rounds are usage errors", async () => {
    const t = taskAtPlanGate();
    expect((await cli(["reject", t.id])).code).toBe(2);
    expect((await cli(["approve", t.id, "--rounds", "abc"])).code).toBe(2);
    expect((await cli(["approve"])).code).toBe(2);
  });

  test("--rounds outside blocked is refused by the service", async () => {
    const t = taskAtPlanGate();
    const r = await cli(["approve", t.id, "--rounds", "2"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("rounds only applies to a blocked task");
  });

  test("task ls lists unfinished tasks; --all includes cancelled", async () => {
    const t = taskAtPlanGate();
    const ls = await cli(["task", "ls"]);
    expect(ls.code).toBe(0);
    expect(ls.out).toContain("ROUNDS");
    expect(ls.out).toContain(t.id);
    expect(ls.out).toContain("awaiting_plan_approval");
    expect((await cli(["task", "cancel", t.id, "goal", "dropped"])).out).toBe(`${t.id} cancelled\n`);
    expect((await cli(["task", "ls"])).out).toBe("no tasks\n");
    expect((await cli(["task", "ls", "--all"])).out).toContain(t.id);
    expect((await cli(["task", "ls", "--status", "cancelled"])).out).toContain(t.id);
    expect((await cli(["task", "ls", "--status", "bogus"])).code).toBe(1);
  });

  test("task show prints the markdown with the brief; unknown id fails", async () => {
    const t = taskAtPlanGate();
    const r = await cli(["task", "show", t.id]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`# Task ${t.id}`);
    expect(r.out).toContain("Approach: token bucket per IP");
    const bad = await cli(["task", "show", "t_nope"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("not_found");
  });

  test("task cancel needs a reason", async () => {
    const t = taskAtPlanGate();
    expect((await cli(["task", "cancel", t.id])).code).toBe(2);
  });

  test("usage lists the task commands", async () => {
    const r = await cli(["--help"]);
    for (const s of ["task ls", "task show", "task cancel", "approve <id>", "reject <id>"]) expect(r.out).toContain(s);
  });
});
