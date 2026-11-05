import * as z from "zod/v4";
import { zodToIssues } from "../schema/errors.ts";
import type { ServiceError } from "../service/handoffs.ts";

/**
 * Advertises `schema`'s JSON Schema in tools/list but lets every argument through, so the handler
 * can answer with a fixable `validation_failed` result instead of the SDK's plain-text error.
 * The cast is a lie for the SDK's generic: handlers receive raw JSON and must call parseArgs.
 */
export function looseInput<T extends z.ZodType>(schema: T): T {
  const jsonSchema = schema["~standard"].jsonSchema;
  return {
    "~standard": {
      version: 1 as const,
      vendor: "handproof",
      jsonSchema,
      validate: (data: unknown) => ({ value: data ?? {} }),
    },
  } as unknown as T;
}

export function parseArgs<T extends z.ZodType>(
  schema: T,
  raw: unknown,
): { ok: true; value: z.infer<T> } | { ok: false; error: ServiceError } {
  const input = raw ?? {};
  const parsed = schema.safeParse(input, { reportInput: true });
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = zodToIssues(parsed.error, input);
  const summary = issues.map((i) => `${i.path === "" ? "(root)" : i.path}: ${i.problem}`).join("; ");
  return { ok: false, error: { error: "validation_failed", message: `invalid input: ${summary}`, issues } };
}

export const HandoffId = z.string().min(1).describe("Handoff id, e.g. h_01JC3Z…");
