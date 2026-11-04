import { existsSync } from "node:fs";
import { posix } from "node:path";
import type { Config } from "../config.ts";
import { type Issue, type ValidationFailure, formatPath, zodToIssues } from "./errors.ts";
import { HandoffInput } from "./handoff.ts";

export interface RuleContext {
  config: Config;
  repoRoot: string;
  fileExists?: (absPath: string) => boolean;
}

/**
 * POSIX path relative to the repo root, or null when it resolves outside it.
 * Works on strings only (no filesystem access), so it also applies to globs.
 * The repo root itself normalizes to ".".
 */
export function normalizeRepoPath(p: string, repoRoot: string): string | null {
  if (p === "" || p.includes("\0")) return null;
  const root = posix.normalize(repoRoot).replace(/\/+$/, "") || "/";
  let rel: string;
  if (posix.isAbsolute(p)) {
    rel = posix.relative(root, posix.normalize(p));
    if (posix.isAbsolute(rel)) return null;
  } else {
    rel = posix.normalize(p);
  }
  // normalize keeps a trailing slash ("src/" stays "src/"); keep it, it matters for globs.
  if (rel === "" || rel === "." || rel === "./") return ".";
  if (rel === ".." || rel.startsWith("../")) return null;
  return rel.startsWith("./") ? rel.slice(2) : rel;
}

const OUTSIDE: Pick<Issue, "problem" | "fix"> = {
  problem: "resolves outside the repo root",
  fix: "use a path relative to the repo root",
};

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function field(v: unknown, key: string): unknown {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
}

interface RuleOutcome {
  issues: Issue[];
  warnings: Issue[];
  /** Normalized paths keyed by formatted field path, for rewriting the parsed value. */
  normalized: Map<string, string>;
}

/** Runs the business rules over input that may be only partly valid; skips anything malformed. */
function runRules(input: unknown, ctx: RuleContext): RuleOutcome {
  const issues: Issue[] = [];
  const warnings: Issue[] = [];
  const normalized = new Map<string, string>();
  const fileExists = ctx.fileExists ?? existsSync;
  const checkNames = Object.keys(ctx.config.checks);

  // context.files[i].path: inside root; missing file is only a warning.
  const files = asArray(field(field(input, "context"), "files"));
  files.forEach((f, i) => {
    const p = field(f, "path");
    if (typeof p !== "string") return;
    const path = formatPath(["context", "files", i, "path"]);
    const norm = normalizeRepoPath(p, ctx.repoRoot);
    if (norm === null) {
      issues.push({ path, ...OUTSIDE });
      return;
    }
    normalized.set(path, norm);
    if (!fileExists(posix.join(ctx.repoRoot, norm))) {
      warnings.push({ path, problem: "file does not exist yet", fix: "fine if the implementer will create it" });
    }
  });

  // scope.allowed / scope.forbidden: inside root; no literal overlap.
  const scope = field(input, "scope");
  const allowedNorm = new Set<string>();
  for (const list of ["allowed", "forbidden"] as const) {
    asArray(field(scope, list)).forEach((g, i) => {
      if (typeof g !== "string") return;
      const path = formatPath(["scope", list, i]);
      const norm = normalizeRepoPath(g, ctx.repoRoot);
      if (norm === null) {
        issues.push({ path, ...OUTSIDE });
        return;
      }
      normalized.set(path, norm);
      if (list === "allowed") {
        allowedNorm.add(norm);
      } else if (allowedNorm.has(norm)) {
        issues.push({ path, problem: `'${norm}' is also in scope.allowed`, fix: "remove it from one of the lists" });
      }
    });
  }

  // acceptance[i].check: must name a configured check.
  asArray(field(input, "acceptance")).forEach((a, i) => {
    const check = field(a, "check");
    if (typeof check !== "string") return;
    if (Object.hasOwn(ctx.config.checks, check)) return;
    issues.push({
      path: formatPath(["acceptance", i, "check"]),
      problem: `unknown check '${check}'`,
      fix: checkNames.length > 0 ? `use one of: ${checkNames.join(", ")}` : "define it in .handoffs/config.json",
    });
  });

  return { issues, warnings, normalized };
}

/** Rules the types cannot express: known checks, paths inside the repo, scope overlap. */
export function checkRules(input: HandoffInput, ctx: RuleContext): { issues: Issue[]; warnings: Issue[] } {
  const { issues, warnings } = runRules(input, ctx);
  return { issues, warnings };
}

function withNormalizedPaths(value: HandoffInput, normalized: Map<string, string>): HandoffInput {
  const pick = (path: string, original: string): string => normalized.get(path) ?? original;
  return {
    ...value,
    context: {
      ...value.context,
      files: value.context.files.map((f, i) => ({
        ...f,
        path: pick(formatPath(["context", "files", i, "path"]), f.path),
      })),
    },
    scope: {
      allowed: value.scope.allowed.map((g, i) => pick(formatPath(["scope", "allowed", i]), g)),
      forbidden: value.scope.forbidden.map((g, i) => pick(formatPath(["scope", "forbidden", i]), g)),
    },
  };
}

/**
 * Schema + rules in one pass. Reports every problem at once: rule checks also run
 * over structurally invalid input, so a short goal and an unknown check show up together.
 * On success, repo paths and scope globs come back normalized (POSIX, relative to the root).
 */
export function parseHandoffInput(
  raw: unknown,
  ctx: RuleContext,
): { ok: true; value: HandoffInput; warnings: Issue[] } | { ok: false; failure: ValidationFailure } {
  const parsed = HandoffInput.safeParse(raw, { reportInput: true });
  const rules = runRules(parsed.success ? parsed.data : raw, ctx);

  const issues: Issue[] = parsed.success ? [] : zodToIssues(parsed.error, raw);
  const seen = new Set(issues.map((i) => i.path));
  for (const issue of rules.issues) {
    if (!seen.has(issue.path)) issues.push(issue);
  }

  if (!parsed.success || issues.length > 0) {
    return { ok: false, failure: { error: "validation_failed", issues } };
  }
  return { ok: true, value: withNormalizedPaths(parsed.data, rules.normalized), warnings: rules.warnings };
}
