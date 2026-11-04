// Pure lifecycle table: no I/O, no store, no Node built-ins.
import * as z from "zod/v4";
import type { Status } from "../schema/handoff.ts";

export const Action = z.enum([
  "claim",
  "update",
  "release",
  "submit",
  "verify_pass",
  "verify_fail",
  "accept",
  "reject",
  "cancel",
  "expire",
]);
export type Action = z.infer<typeof Action>;

/** "any" on a row matches every caller. */
export type Role = "any" | "creator" | "claimant" | "human" | "system";

export interface Transition {
  from: Status;
  action: Action;
  to: Status;
  who: readonly Role[];
}

const row = (from: Status, action: Action, to: Status, who: readonly Role[]): Transition =>
  Object.freeze({ from, action, to, who: Object.freeze([...who]) });

/** `done` and `cancelled` are terminal. `open → expire` is deliberately absent. */
export const TRANSITIONS: readonly Transition[] = Object.freeze([
  row("open", "claim", "claimed", ["any"]),
  row("open", "cancel", "cancelled", ["creator", "human"]),
  row("claimed", "update", "claimed", ["claimant"]),
  row("claimed", "release", "open", ["claimant"]),
  row("claimed", "submit", "submitted", ["claimant"]),
  row("claimed", "expire", "open", ["system"]),
  row("changes_requested", "update", "changes_requested", ["claimant"]),
  row("changes_requested", "release", "open", ["claimant"]),
  row("changes_requested", "submit", "submitted", ["claimant"]),
  row("changes_requested", "expire", "open", ["system"]),
  row("submitted", "verify_pass", "verified", ["system"]),
  row("submitted", "verify_fail", "changes_requested", ["system"]),
  row("verified", "accept", "done", ["creator", "human"]),
  row("verified", "reject", "open", ["creator", "human"]),
]);

export type TransitionResult =
  | { ok: true; to: Status }
  | { ok: false; code: "invalid_transition" | "not_permitted"; reason: string };

function permits(t: Transition, roles: ReadonlySet<Role>): boolean {
  return t.who.some((r) => r === "any" || roles.has(r));
}

export function transition(from: Status, action: Action, roles: ReadonlySet<Role>): TransitionResult {
  const t = TRANSITIONS.find((r) => r.from === from && r.action === action);
  if (t === undefined) {
    return { ok: false, code: "invalid_transition", reason: `cannot ${action} a handoff that is ${from}` };
  }
  if (!permits(t, roles)) {
    return { ok: false, code: "not_permitted", reason: `only the ${t.who.join(" or ")} may ${action}` };
  }
  return { ok: true, to: t.to };
}

/** Actions the caller may take from `from`, in table order. */
export function allowedActions(from: Status, roles: ReadonlySet<Role>): Action[] {
  return TRANSITIONS.filter((t) => t.from === from && permits(t, roles)).map((t) => t.action);
}
