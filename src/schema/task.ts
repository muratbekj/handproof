import * as z from "zod/v4";
import { TASK_ID_RE } from "../ids.ts";
import { AgentRef } from "./handoff.ts";

export const TaskStatus = z.enum([
  "new",
  "researching",
  "planning",
  "awaiting_plan_approval",
  "building",
  "verifying",
  "blocked",
  "awaiting_human_review",
  "done",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Risk = z.enum(["low", "normal"]);
export type Risk = z.infer<typeof Risk>;

export const TaskId = z.string().regex(TASK_ID_RE, "expected a task id like t_01JC…").describe("Task id, e.g. t_01JC3Z…");

/** Size limits for payload text (spec "Field rules"). */
export const LONG_MAX = 8000;
export const MID_MAX = 4000;
export const SHORT_MAX = 2000;
export const LIST_MAX = 100;

const text = (max: number) => z.string().trim().min(1).max(max);
const list = (max = LIST_MAX) => z.array(text(SHORT_MAX)).max(max);
const count = z.number().int().min(0);

export const TaskInput = z.strictObject({
  goal: z.string().trim().min(20).max(SHORT_MAX).describe("What done looks like for the whole goal"),
  risk: Risk.default("normal").describe("low allows skipping research and the final human review"),
});
export type TaskInput = z.infer<typeof TaskInput>;

export const Task = TaskInput.extend({
  id: z.string(),
  schemaVersion: z.literal(1),
  status: TaskStatus,
  from: AgentRef,
  repo: z.object({ root: z.string(), worktree: z.string(), branch: z.string() }),
  rounds: z.object({ used: count, limit: count }),
  flags: z.object({ severeEver: z.boolean() }),
  planCommit: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Task = z.infer<typeof Task>;

export const TestsResult = z.strictObject({ passed: count, failed: count, failing: list() });
export type TestsResult = z.infer<typeof TestsResult>;

const Finding = {
  file: text(SHORT_MAX),
  line: count.describe("0 = the whole file"),
  problem: text(SHORT_MAX),
  fix: text(SHORT_MAX),
};
export const Severity = z.enum(["CRITICAL", "HIGH", "MEDIUM"]);

const finalFields = {
  tests: TestsResult.refine((t) => t.failed === 0 && t.failing.length === 0, {
    message: "the final gate needs 0 failed tests",
  }),
  review_verdict: z.literal("APPROVE"),
  security_verdict: z.literal("PASS"),
  nits: list(),
  low_findings: list(),
  unverified: list(),
};

export const PAYLOADS = {
  "new>researching": z.strictObject({ goal: text(MID_MAX), questions: list().min(1) }),
  "new>planning": z.strictObject({ goal: text(MID_MAX), skip_reason: text(MID_MAX) }),
  "researching>planning": z.strictObject({ research_file: text(SHORT_MAX), summary: text(MID_MAX), unverified: list() }),
  "planning>researching": z.strictObject({ questions: list().min(1) }),
  "planning>awaiting_plan_approval": z.strictObject({
    plan_file: text(SHORT_MAX),
    brief: text(LONG_MAX),
    steps: z.number().int().min(1),
    acceptance_criteria: z.number().int().min(1),
    security_sensitive: list(),
    depends_on_unverified: list(),
  }),
  "building>verifying": z.strictObject({
    summary: text(MID_MAX),
    commits: z.array(z.string().regex(/^[0-9a-f]{7,40}$/, "expected a 7–40 char hex commit sha")).min(1).max(LIST_MAX),
    diff_lines: count,
  }),
  "verifying>building": z.strictObject({
    tests: TestsResult,
    blocking: z.array(z.strictObject(Finding)).max(LIST_MAX),
    security: z.array(z.strictObject({ ...Finding, severity: Severity })).max(LIST_MAX),
    wrong_tests: list(),
    message_to_builder: text(LONG_MAX),
  }),
  "verifying>blocked": z.strictObject({ reason: text(MID_MAX), tests: TestsResult, open: list().min(1) }),
  "verifying>awaiting_human_review": z.strictObject({ ...finalFields, brief: text(LONG_MAX) }),
  "verifying>done": z.strictObject(finalFields),
} as const;

export type LeadMove = keyof typeof PAYLOADS;
export type Payload<M extends LeadMove> = z.infer<(typeof PAYLOADS)[M]>;

export const ApproveInput = z.strictObject({
  comment: text(MID_MAX).optional(),
  rounds: z.number().int().min(1).max(10).optional(),
});
export const RejectInput = z.strictObject({ comment: text(MID_MAX) });
export const CancelInput = z.strictObject({ reason: text(MID_MAX) });
