import * as z from "zod/v4";

export const Kind = z.enum(["implement", "fix", "review", "investigate", "test"]);
export type Kind = z.infer<typeof Kind>;

export const Status = z.enum([
  "open",
  "claimed",
  "submitted",
  "changes_requested",
  "verified",
  "done",
  "cancelled",
]);
export type Status = z.infer<typeof Status>;

export const Harness = z.enum(["claude-code", "cursor", "codex", "other"]);
export type Harness = z.infer<typeof Harness>;

export const AgentRef = z.object({
  name: z.string(), // "planner", "cursor-impl"
  harness: Harness,
  session: z.string().optional(),
});
export type AgentRef = z.infer<typeof AgentRef>;

export const Priority = z.enum(["low", "normal", "high"]);
export type Priority = z.infer<typeof Priority>;

export const HandoffInput = z.object({
  kind: Kind,
  title: z.string().min(8).max(120),
  goal: z.string().min(40), // what done looks like, in prose
  to: z.string().default("any"), // agent name or "any"
  priority: Priority.default("normal"),
  context: z.object({
    summary: z.string().min(40),
    files: z.array(z.object({ path: z.string(), why: z.string() })).max(30),
    decisions: z.array(z.string()).default([]), // fixed, don't revisit
    tried: z.array(z.object({ approach: z.string(), outcome: z.string() })).default([]),
    links: z.array(z.url()).default([]),
  }),
  constraints: z.array(z.string()).default([]), // "no new dependencies"
  scope: z.object({
    allowed: z.array(z.string()).min(1), // globs: "src/auth/**"
    forbidden: z.array(z.string()).default([]), // "**/migrations/**"
  }),
  acceptance: z
    .array(
      z.object({
        id: z.string(), // "ac1"
        description: z.string(),
        check: z.string().optional(), // a named check from config, e.g. "test"
      }),
    )
    .min(1),
});
/** Parsed input, defaults applied. */
export type HandoffInput = z.infer<typeof HandoffInput>;
/** What a caller may send (defaulted fields optional). */
export type HandoffInputRaw = z.input<typeof HandoffInput>;

/** An uncommitted change that existed at create: repo-relative POSIX path and its `git hash-object` (null = deleted). */
export const Preexisting = z.object({
  path: z.string(),
  blob: z.string().nullable(),
});
export type Preexisting = z.infer<typeof Preexisting>;

export const Handoff = HandoffInput.extend({
  id: z.string(), // "h_01JC..." (ULID)
  schemaVersion: z.literal(1),
  status: Status,
  from: AgentRef,
  repo: z.object({
    root: z.string(),
    branch: z.string(),
    baseCommit: z.string(),
    worktree: z.string().optional(), // absolute worktreeRoot of the creator; absent on Phase 1–2 rows
    preexisting: z.array(Preexisting).default([]), // uncommitted changes when the handoff was created
  }),
  claim: z.object({ by: AgentRef, leaseUntil: z.iso.datetime() }).nullable(),
  result: z
    .object({
      summary: z.string(),
      commits: z.array(z.string()),
      criteria: z.array(z.object({ id: z.string(), met: z.boolean(), note: z.string().optional() })),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Handoff = z.infer<typeof Handoff>;

/** `repo.preexisting`, or [] for rows written before Phase 3 (stored docs are not re-parsed on read). */
export function preexistingOf(h: Handoff): Preexisting[] {
  return (h.repo as { preexisting?: Preexisting[] }).preexisting ?? [];
}
