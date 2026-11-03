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
