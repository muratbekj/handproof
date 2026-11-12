// Pure task move table: no I/O, no store.
import type { LeadMove, TaskStatus } from "../schema/task.ts";

export type Mover = "lead" | "human";
export type HumanAction = "approve" | "reject" | "cancel";

export interface TaskMove {
  from: TaskStatus;
  to: TaskStatus;
  by: Mover;
  /** Human moves only. */
  action?: HumanAction;
}

const GATES: readonly TaskStatus[] = ["awaiting_plan_approval", "blocked", "awaiting_human_review"];
const NON_TERMINAL: readonly TaskStatus[] = [
  "new",
  "researching",
  "planning",
  "awaiting_plan_approval",
  "building",
  "verifying",
  "blocked",
  "awaiting_human_review",
];

const lead = (from: TaskStatus, to: TaskStatus): TaskMove => Object.freeze({ from, to, by: "lead" });
const human = (from: TaskStatus, action: HumanAction, to: TaskStatus): TaskMove =>
  Object.freeze({ from, to, by: "human", action });

/** `done` and `cancelled` are terminal. Gate states are left only by a human. */
export const TASK_MOVES: readonly TaskMove[] = Object.freeze([
  lead("new", "researching"),
  lead("new", "planning"),
  lead("researching", "planning"),
  lead("planning", "researching"),
  lead("planning", "awaiting_plan_approval"),
  human("awaiting_plan_approval", "approve", "building"),
  human("awaiting_plan_approval", "reject", "planning"),
  lead("building", "verifying"),
  lead("verifying", "building"),
  lead("verifying", "blocked"),
  human("blocked", "approve", "building"),
  human("blocked", "reject", "planning"),
  lead("verifying", "awaiting_human_review"),
  lead("verifying", "done"),
  human("awaiting_human_review", "approve", "done"),
  human("awaiting_human_review", "reject", "building"),
  ...NON_TERMINAL.map((s) => human(s, "cancel", "cancelled")),
]);

export function isGate(s: TaskStatus): boolean {
  return GATES.includes(s);
}

/** States the lead may move to from `from`, in table order. */
export function leadTargets(from: TaskStatus): TaskStatus[] {
  return TASK_MOVES.filter((m) => m.by === "lead" && m.from === from).map((m) => m.to);
}

export type LeadMoveResult =
  | { ok: true; move: LeadMove }
  | { ok: false; code: "invalid_transition"; reason: string; allowed: TaskStatus[] };

export function leadMove(from: TaskStatus, to: TaskStatus): LeadMoveResult {
  const m = TASK_MOVES.find((r) => r.by === "lead" && r.from === from && r.to === to);
  if (m !== undefined) return { ok: true, move: `${from}>${to}` as LeadMove };
  const allowed = leadTargets(from);
  let reason: string;
  if (isGate(from)) {
    reason = `the task is ${from} and waits on a human: handproof approve <id> or handproof reject <id> "<why>"`;
  } else if (allowed.length === 0) {
    reason = `the task is ${from}; it can't move any more`;
  } else {
    reason = `cannot move a task from ${from} to ${to}; allowed: ${allowed.join(", ")}`;
  }
  return { ok: false, code: "invalid_transition", reason, allowed };
}

export type HumanMoveResult = { ok: true; to: TaskStatus } | { ok: false; code: "invalid_transition"; reason: string };

export function humanMove(from: TaskStatus, action: HumanAction): HumanMoveResult {
  const m = TASK_MOVES.find((r) => r.by === "human" && r.from === from && r.action === action);
  if (m !== undefined) return { ok: true, to: m.to };
  const reason =
    action === "cancel"
      ? `the task is ${from}; it can't be cancelled`
      : `the task is ${from}, not waiting on a human; ${action} works only at awaiting_plan_approval, blocked or awaiting_human_review`;
  return { ok: false, code: "invalid_transition", reason };
}
