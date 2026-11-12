import { newTaskId } from "../../src/ids";
import type { LeadMove, Task } from "../../src/schema/task";

const AT = "2026-11-11T10:00:00.000Z";

export const TESTS_OK = { passed: 12, failed: 0, failing: [] };
export const FINAL = {
  tests: TESTS_OK,
  review_verdict: "APPROVE",
  security_verdict: "PASS",
  nits: ["rename x"],
  low_findings: [],
  unverified: [],
};

export const VALID_PAYLOADS: Record<LeadMove, Record<string, unknown>> = {
  "new>researching": { goal: "Add rate limiting to POST /login", questions: ["Which limiter library?"] },
  "new>planning": { goal: "Fix a typo in the README", skip_reason: "one-line docs change" },
  "researching>planning": { research_file: "notes/RESEARCH.md", summary: "Use a token bucket.", unverified: [] },
  "planning>researching": { questions: ["Does the proxy strip X-Forwarded-For?"] },
  "planning>awaiting_plan_approval": {
    plan_file: "notes/PLAN.md",
    brief: "Task #1: rate limiting …",
    steps: 4,
    acceptance_criteria: 9,
    security_sensitive: ["user input on /login"],
    depends_on_unverified: [],
  },
  "building>verifying": { summary: "Limiter added.", commits: ["abc1234"], diff_lines: 120 },
  "verifying>building": {
    tests: { passed: 10, failed: 2, failing: ["login > limits"] },
    blocking: [{ file: "src/a.ts", line: 3, problem: "off by one", fix: "use <=" }],
    security: [{ file: "src/b.ts", line: 0, problem: "IP spoofing", fix: "trust only proxy", severity: "HIGH" }],
    wrong_tests: [],
    message_to_builder: "Fix HIGH first: …",
  },
  "verifying>blocked": { reason: "3 rounds used", tests: { passed: 10, failed: 1, failing: ["x"] }, open: ["HIGH in src/b.ts"] },
  "verifying>awaiting_human_review": { ...FINAL, brief: "Task #1 review …" },
  "verifying>done": FINAL,
};


export function fixtureTask(overrides: Partial<Task> = {}): Task {
  return {
    id: newTaskId(),
    schemaVersion: 1,
    goal: "Add rate limiting to POST /login",
    risk: "normal",
    status: "new",
    from: { name: "lead", harness: "other" },
    repo: { root: "/r", worktree: "/r", branch: "main" },
    rounds: { used: 0, limit: 3 },
    flags: { severeEver: false },
    planCommit: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

