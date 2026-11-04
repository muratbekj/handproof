import type * as z from "zod/v4";

/** One fixable problem: where, what is wrong, and what to do about it. */
export interface Issue {
  path: string;
  problem: string;
  fix: string;
}

export interface ValidationFailure {
  error: "validation_failed";
  issues: Issue[];
}

/** ["acceptance",0,"check"] → "acceptance[0].check"; [] → "". */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      const key = typeof seg === "symbol" ? (seg.description ?? "") : seg;
      out += out === "" ? key : `.${key}`;
    }
  }
  return out;
}

const SHORT_STRING_FIX: Readonly<Record<string, string>> = {
  goal: "say what done looks like",
  title: "use 8–120 chars",
  "context.summary": "summarize what was done and what is left",
};

const MISSING = Symbol("missing");

/** Value at `path` inside `root`, or MISSING when any step is absent. */
function valueAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return MISSING;
    const rec = cur as Record<PropertyKey, unknown>;
    if (!(seg in rec)) return MISSING;
    cur = rec[seg];
  }
  return cur;
}

/** The value the issue is about: zod's `input` when reported, else looked up in the raw input. */
function issueInput(issue: z.core.$ZodIssue, raw: unknown, hasRaw: boolean): unknown {
  if ("input" in issue) return issue.input;
  if (!hasRaw) return MISSING;
  return valueAt(raw, issue.path);
}

function sizeOf(v: unknown): number | null {
  if (typeof v === "string" || Array.isArray(v)) return v.length;
  return null;
}

function show(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === MISSING || v === undefined) return "undefined";
  try {
    return JSON.stringify(v);
  } catch {
    return typeName(v);
  }
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function article(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

function toIssue(issue: z.core.$ZodIssue, raw: unknown, hasRaw: boolean): Issue {
  const path = formatPath(issue.path);
  const input = issueInput(issue, raw, hasRaw);

  switch (issue.code) {
    case "invalid_type": {
      const missing =
        input === undefined || (input === MISSING && (hasRaw || /received undefined/.test(issue.message)));
      if (missing) return { path, problem: "required", fix: "add this field" };
      const got = input === MISSING ? "a different type" : typeName(input);
      return { path, problem: `expected ${issue.expected}, got ${got}`, fix: `use ${article(issue.expected)}` };
    }

    case "too_small": {
      const n = sizeOf(input);
      const min = Number(issue.minimum);
      if (issue.origin === "string") {
        return {
          path,
          problem: `too short (${n ?? "?"} chars, min ${min})`,
          fix: SHORT_STRING_FIX[path] ?? `use at least ${min} chars`,
        };
      }
      if (issue.origin === "array" || issue.origin === "set") {
        return { path, problem: `needs at least ${min} item(s)`, fix: `add at least ${min}` };
      }
      return { path, problem: `too small (min ${min})`, fix: `use a value of at least ${min}` };
    }

    case "too_big": {
      const n = sizeOf(input);
      const max = Number(issue.maximum);
      if (issue.origin === "string") {
        return { path, problem: `too long (${n ?? "?"} chars, max ${max})`, fix: `shorten to ${max} chars` };
      }
      if (issue.origin === "array" || issue.origin === "set") {
        return { path, problem: `too many items (${n ?? "?"}, max ${max})`, fix: `keep at most ${max}` };
      }
      return { path, problem: `too big (max ${max})`, fix: `use a value of at most ${max}` };
    }

    case "invalid_value": {
      const values = issue.values.map((v) => show(v));
      if (values.length === 1) {
        return { path, problem: `invalid value '${show(input)}'`, fix: `use ${values[0] ?? ""}` };
      }
      return { path, problem: `invalid value '${show(input)}'`, fix: `use one of: ${values.join(", ")}` };
    }

    case "invalid_format": {
      if (issue.format === "url") {
        return { path, problem: `not a valid URL ('${show(input)}')`, fix: "use an absolute URL like https://example.com/x" };
      }
      if (issue.format === "datetime") {
        return { path, problem: `not an ISO 8601 timestamp ('${show(input)}')`, fix: "use a UTC timestamp like 2026-01-31T12:00:00Z" };
      }
      return { path, problem: `invalid ${issue.format}`, fix: issue.message };
    }

    case "unrecognized_keys":
      return {
        path,
        problem: `unknown field(s): ${issue.keys.join(", ")}`,
        fix: "remove them",
      };

    default:
      return { path, problem: issue.message, fix: "check this field against the schema" };
  }
}

/**
 * Turns a ZodError into fixable issues, in the order zod reported them.
 * Pass the raw input when the parse did not use `reportInput: true`, so sizes and bad values can be named.
 */
export function zodToIssues(err: z.ZodError, raw?: unknown): Issue[] {
  const hasRaw = raw !== undefined;
  return err.issues.map((i) => toIssue(i, raw, hasRaw));
}
