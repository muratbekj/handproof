import picomatch from "picomatch/posix";
import { gitEnv } from "../config.ts";
import { HandoffsError } from "../errors.ts";
import type { Kind } from "../schema/handoff.ts";

export interface ChangedFiles {
  files: string[];
  base: string;
  usedMergeBase: boolean;
}

export interface Violation {
  path: string;
  rule: string;
}

/** Always judged, even though they live under .handoffs/: editing them could weaken the checks. */
export const PROTECTED_PATHS: readonly string[] = Object.freeze([".handoffs/config.json"]);

const NO_CHANGE_KINDS: readonly Kind[] = ["review", "investigate"];

interface GitRun {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

function git(cwd: string, args: string[]): GitRun {
  let proc;
  try {
    proc = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new HandoffsError("git_not_found", "could not run git; is it installed and on PATH?", { cause: String(err) });
  }
  return { exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr.toString().trim() };
}

function nulList(out: Buffer): string[] {
  return out
    .toString("utf8")
    .split("\0")
    .filter((p) => p !== "");
}

function isRuntimeFile(p: string): boolean {
  return (p === ".handoffs" || p.startsWith(".handoffs/")) && !PROTECTED_PATHS.includes(p);
}

/** The recorded base when it is a commit and an ancestor of HEAD; otherwise merge-base(branch, HEAD). */
function resolveBase(cwd: string, baseCommit: string, branch: string): { base: string; usedMergeBase: boolean } {
  const usable =
    git(cwd, ["cat-file", "-e", `${baseCommit}^{commit}`]).exitCode === 0 &&
    git(cwd, ["merge-base", "--is-ancestor", baseCommit, "HEAD"]).exitCode === 0;
  if (usable) return { base: baseCommit, usedMergeBase: false };
  const mb = git(cwd, ["merge-base", branch, "HEAD"]);
  const base = mb.stdout.toString("utf8").trim();
  if (mb.exitCode !== 0 || base === "") {
    throw new HandoffsError(
      "scope_base_unavailable",
      `base commit ${baseCommit.slice(0, 12)} is not an ancestor of HEAD and branch '${branch}' has no merge-base with HEAD; cannot tell which files changed`,
      { baseCommit, branch },
    );
  }
  return { base, usedMergeBase: true };
}

/**
 * Files changed in the worktree at `cwd` since the base: committed, staged, unstaged and untracked
 * (ignored files excluded). Runtime files under .handoffs/ are dropped except PROTECTED_PATHS.
 * Never returns "no changes" for an unusable base: throws scope_base_unavailable instead.
 */
export function changedFiles(opts: { cwd: string; baseCommit: string; branch: string }): ChangedFiles {
  const { base, usedMergeBase } = resolveBase(opts.cwd, opts.baseCommit, opts.branch);
  const diff = git(opts.cwd, ["diff", "-z", "--name-only", "--no-renames", base]);
  if (diff.exitCode !== 0) {
    throw new HandoffsError("scope_diff_failed", `git diff against ${base.slice(0, 12)} failed: ${diff.stderr}`, { base });
  }
  const untracked = git(opts.cwd, ["ls-files", "-z", "--others", "--exclude-standard"]);
  if (untracked.exitCode !== 0) {
    throw new HandoffsError("scope_diff_failed", `git ls-files failed: ${untracked.stderr}`, { base });
  }
  const all = new Set([...nulList(diff.stdout), ...nulList(untracked.stdout)]);
  const files = [...all].filter((p) => !isRuntimeFile(p)).sort();
  return { files, base, usedMergeBase };
}

/**
 * POSIX glob matcher with `dot: true` (src/auth/** covers src/auth/.env). picomatch's regex uses `.`,
 * which skips "\n"; the `s` flag keeps a file name containing a newline inside its directory's glob.
 */
function globMatcher(glob: string): (path: string) => boolean {
  const re = picomatch.makeRe(glob, { dot: true });
  const dotAll = new RegExp(re.source, re.flags.includes("s") ? re.flags : `${re.flags}s`);
  return (path) => dotAll.test(path);
}

/** One violation per offending file; the first rule that applies names it. */
export function checkScope(files: string[], scope: { allowed: string[]; forbidden: string[] }, kind: Kind): Violation[] {
  const forbidden = scope.forbidden.map((g) => ({ glob: g, match: globMatcher(g) }));
  const allowed = scope.allowed.map(globMatcher);
  const outside = `outside ${scope.allowed.join(", ")}`;
  const violations: Violation[] = [];
  for (const path of files) {
    if (PROTECTED_PATHS.includes(path)) {
      violations.push({ path, rule: `protected: ${path}` });
    } else if (NO_CHANGE_KINDS.includes(kind)) {
      violations.push({ path, rule: `no changes allowed for ${kind}` });
    } else {
      const hit = forbidden.find((f) => f.match(path));
      if (hit !== undefined) violations.push({ path, rule: hit.glob });
      else if (!allowed.some((m) => m(path))) violations.push({ path, rule: outside });
    }
  }
  return violations;
}
