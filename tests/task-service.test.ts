import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/config";
import type { AgentRef } from "../src/schema/handoff";
import type { LeadMove, Task, TaskStatus } from "../src/schema/task";
import { openService } from "../src/service/open";
import type { TaskService } from "../src/service/tasks";
import { initRepoHandoffs } from "./helpers/serviceSetup";
import { VALID_PAYLOADS } from "./helpers/taskFixtures";
import { type TmpRepo, tmpRepo } from "./helpers/tmpRepo";

const LEAD: AgentRef = { name: "lead", harness: "other" };
const OTHER: AgentRef = { name: "builder", harness: "claude-code" };
const HUMAN: AgentRef = { name: "human-cli", harness: "other" };
const GOAL = "Add rate limiting to POST /login";

let repo: TmpRepo;
let closers: (() => void)[];

function svc(agent: AgentRef): TaskService {
  const paths = initRepoHandoffs(repo);
  const handle = openService({ paths, config: loadConfig(paths), agent });
  closers.push(() => {
    handle.close();
  });
  return handle.tasks;
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: { error: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.error}: ${r.error.message}`);
  return r.value;
}

const p = (m: LeadMove) => VALID_PAYLOADS[m];

function move(lead: TaskService, t: Task, to: TaskStatus, payload?: Record<string, unknown>): Task {
  const m = `${t.status}>${to}` as LeadMove;
  return must(lead.transition(t.id, to, payload ?? p(m))).task;
}

/** new → researching → planning → awaiting_plan_approval → (human approve) → building → verifying. */
function toVerifying(lead: TaskService, human: TaskService, risk: "low" | "normal" = "normal"): Task {
  let t = must(lead.create({ goal: GOAL, risk }));
  t = move(lead, t, "researching");
  t = move(lead, t, "planning");
  t = move(lead, t, "awaiting_plan_approval");
  must(human.approve(t.id, {}));
  t = must(lead.get(t.id)).task;
  return move(lead, t, "verifying");
}

const roundWith = (severity: "HIGH" | "MEDIUM") => ({
  ...p("verifying>building"),
  security: [{ file: "src/b.ts", line: 1, problem: "p", fix: "f", severity }],
});

beforeEach(() => {
  repo = tmpRepo();
  closers = [];
  fs.mkdirSync(path.join(repo.dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, "notes/RESEARCH.md"), "# research\n");
  fs.writeFileSync(path.join(repo.dir, "notes/PLAN.md"), "# plan\n");
});

afterEach(() => {
  for (const c of closers) c();
  repo.cleanup();
});

describe("task service", () => {
  test("create records repo, rounds and creator", () => {
    const t = must(svc(LEAD).create({ goal: GOAL }));
    expect(t).toMatchObject({ status: "new", risk: "normal", from: LEAD, rounds: { used: 0, limit: 3 }, planCommit: null });
    expect(t.id).toMatch(/^t_/);
    expect(t.repo.branch).toBe("main");
  });

  test("create refuses bad input and secrets", () => {
    const lead = svc(LEAD);
    const r = lead.create({ goal: "short" });
    expect(!r.ok && r.error.error).toBe("validation_failed");
    const s = lead.create({ goal: `${GOAL} with key AKIAIOSFODNN7EXAMPLE` });
    expect(!s.ok && s.error.error).toBe("secret_detected");
  });

  test("normal path through both gates to done", () => {
    const lead = svc(LEAD);
    const human = svc(HUMAN);
    let t = toVerifying(lead, human);
    t = move(lead, t, "building", roundWith("MEDIUM"));
    expect(t.rounds.used).toBe(1);
    t = move(lead, t, "verifying");
    const r = must(lead.transition(t.id, "awaiting_human_review", p("verifying>awaiting_human_review")));
    expect(r.waitingOnHuman).toBe(true);
    expect(r.next).toEqual([]);
    expect(must(human.approve(t.id, { comment: "ship it" })).status).toBe("done");
    const events = must(lead.get(t.id)).events;
    expect(events.map((e) => e.type)).toEqual([
      "created", "moved", "moved", "moved", "approved", "moved", "moved", "moved", "moved", "approved",
    ]);
    expect(events.at(-1)?.data).toMatchObject({ from: "awaiting_human_review", to: "done", comment: "ship it" });
  });

  test("transition returns the next lead moves", () => {
    const lead = svc(LEAD);
    const t = must(lead.create({ goal: GOAL }));
    const r = must(lead.transition(t.id, "researching", p("new>researching")));
    expect(r.next).toEqual(["planning"]);
    expect(r.waitingOnHuman).toBe(false);
  });

  test("approve at the plan gate records planCommit = HEAD and resets rounds", () => {
    const lead = svc(LEAD);
    const human = svc(HUMAN);
    const t = toVerifying(lead, human);
    expect(t.planCommit).toBe(repo.git(["rev-parse", "HEAD"]));
    expect(t.rounds).toEqual({ used: 0, limit: 3 });
  });

  test("4th round is refused with round_limit; blocked; approve --rounds 2 gives exactly 2 more", () => {
    const lead = svc(LEAD);
    const human = svc(HUMAN);
    let t = toVerifying(lead, human);
    for (let i = 0; i < 3; i++) {
      t = move(lead, t, "building");
      t = move(lead, t, "verifying");
    }
    const r = lead.transition(t.id, "building", p("verifying>building"));
    expect(!r.ok && r.error.error).toBe("round_limit");
    expect(!r.ok && r.error.message).toContain("blocked");
    t = move(lead, t, "blocked");
    expect(must(human.approve(t.id, { rounds: 2 })).rounds).toEqual({ used: 3, limit: 5 });
    t = must(lead.get(t.id)).task;
    t = move(lead, t, "verifying");
    t = move(lead, t, "building");
    t = move(lead, t, "verifying");
    t = move(lead, t, "building");
    t = move(lead, t, "verifying");
    const again = lead.transition(t.id, "building", p("verifying>building"));
    expect(!again.ok && again.error.error).toBe("round_limit");
  });

  test("approve from blocked defaults to 3 more rounds", () => {
    const lead = svc(LEAD);
    const human = svc(HUMAN);
    let t = toVerifying(lead, human);
    t = move(lead, t, "blocked");
    expect(must(human.approve(t.id, {})).rounds).toEqual({ used: 0, limit: 6 });
  });

  test("blocked → planning, then re-approval resets the round count", () => {
    const lead = svc(LEAD);
    const human = svc(HUMAN);
    let t = toVerifying(lead, human);
    t = move(lead, t, "building");
    t = move(lead, t, "verifying");
    t = move(lead, t, "blocked");
    expect(must(human.reject(t.id, { comment: "rethink step 3" })).status).toBe("planning");
    t = must(lead.get(t.id)).task;
    t = move(lead, t, "awaiting_plan_approval");
    expect(must(human.approve(t.id, {})).rounds).toEqual({ used: 0, limit: 3 });
  });

  test("human reject at the final review goes to building without using a round", () => {
    const lead = svc(LEAD);
    const human = svc(HUMAN);
    let t = toVerifying(lead, human);
    t = move(lead, t, "awaiting_human_review");
    const back = must(human.reject(t.id, { comment: "rename the flag" }));
    expect(back.status).toBe("building");
    expect(back.rounds.used).toBe(0);
  });

  test("rounds on a gate other than blocked is refused", () => {
    const lead = svc(LEAD);
    const human = svc(HUMAN);
    let t = must(lead.create({ goal: GOAL }));
    t = move(lead, t, "researching");
    t = move(lead, t, "planning");
    t = move(lead, t, "awaiting_plan_approval");
    const r = human.approve(t.id, { rounds: 2 });
    expect(!r.ok && r.error.error).toBe("validation_failed");
    expect(must(lead.get(t.id)).task.status).toBe("awaiting_plan_approval");
  });

  test("a round with nothing to fix is refused", () => {
    const lead = svc(LEAD);
    const t = toVerifying(lead, svc(HUMAN));
    const r = lead.transition(t.id, "building", {
      tests: { passed: 5, failed: 0, failing: [] },
      blocking: [],
      security: [],
      wrong_tests: [],
      message_to_builder: "nothing",
    });
    expect(!r.ok && r.error.error).toBe("validation_failed");
    expect(!r.ok && JSON.stringify(r.error)).toContain("nothing to fix");
  });

  describe("low risk", () => {
    test("normal risk cannot skip research or the final review", () => {
      const lead = svc(LEAD);
      const t = must(lead.create({ goal: GOAL }));
      const r = lead.transition(t.id, "planning", p("new>planning"));
      expect(!r.ok && r.error.error).toBe("not_permitted");
      const v = toVerifying(lead, svc(HUMAN));
      const d = lead.transition(v.id, "done", p("verifying>done"));
      expect(!d.ok && d.error.error).toBe("not_permitted");
    });

    test("low risk may skip research and finish without the human review", () => {
      const lead = svc(LEAD);
      const human = svc(HUMAN);
      let t = must(lead.create({ goal: GOAL, risk: "low" }));
      t = move(lead, t, "planning");
      t = move(lead, t, "awaiting_plan_approval");
      must(human.approve(t.id, {}));
      t = move(lead, must(lead.get(t.id)).task, "verifying");
      t = move(lead, t, "building", roundWith("MEDIUM"));
      t = move(lead, t, "verifying");
      expect(move(lead, t, "done").status).toBe("done");
    });

    test("low risk after a HIGH finding must go to the human review", () => {
      const lead = svc(LEAD);
      let t = toVerifying(lead, svc(HUMAN), "low");
      t = move(lead, t, "building", roundWith("HIGH"));
      expect(t.flags.severeEver).toBe(true);
      t = move(lead, t, "verifying");
      const r = lead.transition(t.id, "done", p("verifying>done"));
      expect(!r.ok && r.error.error).toBe("not_permitted");
      expect(!r.ok && r.error.message).toContain("CRITICAL/HIGH");
    });

    test("low risk with UNVERIFIED findings must go to the human review", () => {
      const lead = svc(LEAD);
      const t = toVerifying(lead, svc(HUMAN), "low");
      const r = lead.transition(t.id, "done", { ...p("verifying>done"), unverified: ["maybe SSRF in fetch"] });
      expect(!r.ok && r.error.error).toBe("not_permitted");
    });
  });

  describe("who may move", () => {
    test("only the creator makes lead moves", () => {
      const t = must(svc(LEAD).create({ goal: GOAL }));
      const r = svc(OTHER).transition(t.id, "researching", p("new>researching"));
      expect(!r.ok && r.error.error).toBe("not_permitted");
    });

    test("only a human approves, rejects or cancels", () => {
      const lead = svc(LEAD);
      let t = must(lead.create({ goal: GOAL }));
      t = move(lead, t, "researching");
      t = move(lead, t, "planning");
      t = move(lead, t, "awaiting_plan_approval");
      for (const r of [lead.approve(t.id, {}), lead.reject(t.id, { comment: "x" }), lead.cancel(t.id, { reason: "x" })]) {
        expect(!r.ok && r.error.error).toBe("not_permitted");
      }
    });

    test("the lead cannot leave a gate through transition", () => {
      const lead = svc(LEAD);
      let t = must(lead.create({ goal: GOAL }));
      t = move(lead, t, "researching");
      t = move(lead, t, "planning");
      t = move(lead, t, "awaiting_plan_approval");
      const r = lead.transition(t.id, "building", {});
      expect(!r.ok && r.error.error).toBe("invalid_transition");
      expect(!r.ok && r.error.message).toContain("handproof approve");
    });

    test("cancel from a non-terminal state; not twice", () => {
      const lead = svc(LEAD);
      const human = svc(HUMAN);
      const t = must(lead.create({ goal: GOAL }));
      expect(must(human.cancel(t.id, { reason: "goal dropped" })).status).toBe("cancelled");
      const again = human.cancel(t.id, { reason: "again" });
      expect(!again.ok && again.error.error).toBe("invalid_transition");
    });
  });

  test("plan_file that does not exist is refused with a field issue", () => {
    const lead = svc(LEAD);
    let t = must(lead.create({ goal: GOAL }));
    t = move(lead, t, "researching");
    t = move(lead, t, "planning");
    const r = lead.transition(t.id, "awaiting_plan_approval", { ...p("planning>awaiting_plan_approval"), plan_file: "notes/NOPE.md" });
    expect(!r.ok && r.error.error).toBe("validation_failed");
    expect(!r.ok && JSON.stringify(r.error.issues)).toContain("plan_file");
  });

  test("absolute research_file is accepted", () => {
    const lead = svc(LEAD);
    let t = must(lead.create({ goal: GOAL }));
    t = move(lead, t, "researching");
    t = move(lead, t, "planning", { ...p("researching>planning"), research_file: path.join(repo.dir, "notes/RESEARCH.md") });
    expect(t.status).toBe("planning");
  });

  test("payload with a secret is refused", () => {
    const lead = svc(LEAD);
    const t = must(lead.create({ goal: GOAL }));
    const r = lead.transition(t.id, "researching", { goal: GOAL, questions: ["is AKIAIOSFODNN7EXAMPLE live?"] });
    expect(!r.ok && r.error.error).toBe("secret_detected");
  });

  test("unknown task id is not_found everywhere", () => {
    const lead = svc(LEAD);
    const human = svc(HUMAN);
    for (const r of [lead.get("t_nope"), lead.transition("t_nope", "researching", {}), human.approve("t_nope", {})]) {
      expect(!r.ok && r.error.error).toBe("not_found");
    }
  });

  test("list defaults to unfinished tasks", () => {
    const lead = svc(LEAD);
    const human = svc(HUMAN);
    const a = must(lead.create({ goal: GOAL }));
    const b = must(lead.create({ goal: `${GOAL} again` }));
    must(human.cancel(b.id, { reason: "dup" }));
    expect(must(lead.list({})).map((s) => s.id)).toEqual([a.id]);
    expect(must(lead.list({ status: ["cancelled"] })).map((s) => s.id)).toEqual([b.id]);
  });
});
