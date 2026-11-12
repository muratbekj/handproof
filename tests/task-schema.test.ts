import { describe, expect, test } from "bun:test";
import { TASK_ID_RE, newTaskId } from "../src/ids";
import { zodToIssues } from "../src/schema/errors";
import { ApproveInput, CancelInput, PAYLOADS, RejectInput, TaskInput, type LeadMove } from "../src/schema/task";
import { FINAL, VALID_PAYLOADS } from "./helpers/taskFixtures";

function issues(move: LeadMove, payload: unknown) {
  const r = PAYLOADS[move].safeParse(payload, { reportInput: true });
  return r.success ? [] : zodToIssues(r.error, payload);
}

describe("task ids", () => {
  test("t_ + ULID", () => {
    const a = newTaskId();
    const b = newTaskId();
    expect(a).toMatch(TASK_ID_RE);
    expect(a < b).toBe(true);
  });
});

describe("TaskInput", () => {
  test("defaults risk to normal", () => {
    expect(TaskInput.parse({ goal: "Add rate limiting to POST /login" }).risk).toBe("normal");
  });
  test("refuses a short goal and an unknown risk", () => {
    expect(TaskInput.safeParse({ goal: "short" }).success).toBe(false);
    expect(TaskInput.safeParse({ goal: "Add rate limiting to POST /login", risk: "high" }).success).toBe(false);
  });
});

describe("payloads", () => {
  test("one valid payload per lead move", () => {
    for (const [move, payload] of Object.entries(VALID_PAYLOADS)) {
      expect({ move, issues: issues(move as LeadMove, payload) }).toEqual({ move, issues: [] });
    }
  });

  test("a missing field is named", () => {
    const { diff_lines: _d, ...rest } = VALID_PAYLOADS["building>verifying"];
    expect(issues("building>verifying", rest)).toContainEqual({ path: "diff_lines", problem: "required", fix: "add this field" });
  });

  test("a misspelt key is refused and named", () => {
    const { diff_lines: _d, ...rest } = VALID_PAYLOADS["building>verifying"];
    const got = issues("building>verifying", { ...rest, diffLines: 120 });
    expect(got.map((i) => i.path)).toContain("diff_lines");
    expect(got.some((i) => i.problem.includes("diffLines"))).toBe(true);
  });

  test("commits: empty list and non-hex refused", () => {
    const base = VALID_PAYLOADS["building>verifying"];
    expect(issues("building>verifying", { ...base, commits: [] }).length).toBeGreaterThan(0);
    expect(issues("building>verifying", { ...base, commits: ["not-a-sha"] }).length).toBeGreaterThan(0);
  });

  test("security severity LOW refused", () => {
    const base = VALID_PAYLOADS["verifying>building"];
    const sec = [{ file: "a", line: 1, problem: "p", fix: "f", severity: "LOW" }];
    expect(issues("verifying>building", { ...base, security: sec }).map((i) => i.path)).toContain("security[0].severity");
  });

  test("final payload needs 0 failed, APPROVE and PASS", () => {
    const base = VALID_PAYLOADS["verifying>awaiting_human_review"];
    expect(issues("verifying>awaiting_human_review", { ...base, tests: { passed: 1, failed: 1, failing: ["x"] } }).length).toBeGreaterThan(0);
    expect(issues("verifying>awaiting_human_review", { ...base, review_verdict: "CHANGES NEEDED" }).length).toBeGreaterThan(0);
    expect(issues("verifying>awaiting_human_review", { ...base, security_verdict: "FAIL" }).length).toBeGreaterThan(0);
  });

  test("verifying>done refuses a brief", () => {
    expect(issues("verifying>done", { ...FINAL, brief: "x" }).length).toBeGreaterThan(0);
  });

  test("brief over 8000 chars refused", () => {
    const base = VALID_PAYLOADS["planning>awaiting_plan_approval"];
    const got = issues("planning>awaiting_plan_approval", { ...base, brief: "x".repeat(8001) });
    expect(got).toContainEqual({ path: "brief", problem: "too long (8001 chars, max 8000)", fix: "shorten to 8000 chars" });
  });

  test("steps must be a positive integer", () => {
    const base = VALID_PAYLOADS["planning>awaiting_plan_approval"];
    expect(issues("planning>awaiting_plan_approval", { ...base, steps: 0 }).length).toBeGreaterThan(0);
    expect(issues("planning>awaiting_plan_approval", { ...base, steps: 1.5 }).length).toBeGreaterThan(0);
  });
});

describe("human inputs", () => {
  test("approve: comment and rounds optional, rounds 1..10", () => {
    expect(ApproveInput.safeParse({}).success).toBe(true);
    expect(ApproveInput.safeParse({ comment: "ok", rounds: 2 }).success).toBe(true);
    expect(ApproveInput.safeParse({ rounds: 0 }).success).toBe(false);
    expect(ApproveInput.safeParse({ rounds: 11 }).success).toBe(false);
  });
  test("reject needs a comment; cancel needs a reason", () => {
    expect(RejectInput.safeParse({}).success).toBe(false);
    expect(RejectInput.safeParse({ comment: "   " }).success).toBe(false);
    expect(RejectInput.safeParse({ comment: "split step 3" }).success).toBe(true);
    expect(CancelInput.safeParse({}).success).toBe(false);
    expect(CancelInput.safeParse({ reason: "goal dropped" }).success).toBe(true);
  });
});
