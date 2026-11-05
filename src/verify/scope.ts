import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch/posix";
import { gitEnv } from "../config.ts";
import { HandoffsError } from "../errors.ts";
import type { Kind, Preexisting } from "../schema/handoff.ts";

export interface ChangedFiles {
  files: string[];
  /** Pre-existing changes left untouched since create; excluded from `files`. */
  ignored: string[];
  base: string;
  usedMergeBase: boolean;
}

/** More uncommitted paths than this at create refuses the handoff. */
export const PREEXISTING_MAX = 1000;

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

function git(cwd: string, args: string[], input?: string): GitRun {
  let proc;
  try {
    proc = Bun.spawnSync(["git", ...args], {
      cwd,
      env: gitEnv(),
      stdin: input === undefined ? "ignore" : Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
    });
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

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Working-tree `git hash-object` of each path; null when it isn't a file on disk (deleted).
 * One --stdin-paths call; a path with a newline (or a leading quote, which git would unquote) is hashed alone.
 */
function blobsOf(cwd: string, paths: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const batch: string[] = [];
  for (const p of paths) {
    if (!isFile(join(cwd, p))) out.set(p, null);
    else if (/[\n\r]/.test(p) || p.startsWith('"')) out.set(p, hashOne(cwd, ["hash-object", "--", p]));
    else batch.push(p);
  }
  if (batch.length > 0) {
    const r = git(cwd, ["hash-object", "--stdin-paths"], `${batch.join("\n")}\n`);
    const hashes = r.stdout.toString("utf8").split("\n").filter((l) => l !== "");
    if (r.exitCode !== 0 || hashes.length !== batch.length) {
      throw new HandoffsError("scope_diff_failed", `git hash-object failed: ${r.stderr}`, {});
    }
    batch.forEach((p, i) => out.set(p, hashes[i] ?? null));
  }
  return out;
}

function hashOne(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  const hash = r.stdout.toString("utf8").trim();
  if (r.exitCode !== 0 || hash === "") throw new HandoffsError("scope_diff_failed", `git hash-object failed: ${r.stderr}`, {});
  return hash;
}

/**
 * Uncommitted changes in the worktree at `cwd` (vs HEAD, plus untracked, ignored files excluded),
 * with the working-tree blob of each, sorted by path. Runtime files are dropped like in changedFiles.
 * Throws too_many_preexisting_changes above PREEXISTING_MAX paths, before hashing anything.
 */
export function snapshotDirty(cwd: string): Preexisting[] {
  const diff = git(cwd, ["diff", "-z", "--name-only", "--no-renames", "HEAD"]);
  if (diff.exitCode !== 0) throw new HandoffsError("scope_diff_failed", `git diff against HEAD failed: ${diff.stderr}`, {});
  const untracked = git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]);
  if (untracked.exitCode !== 0) throw new HandoffsError("scope_diff_failed", `git ls-files failed: ${untracked.stderr}`, {});
  const paths = [...new Set([...nulList(diff.stdout), ...nulList(untracked.stdout)])].filter((p) => !isRuntimeFile(p)).sort();
  if (paths.length > PREEXISTING_MAX) {
    throw new HandoffsError(
      "too_many_preexisting_changes",
      `the worktree has ${paths.length} uncommitted paths (max ${PREEXISTING_MAX}); commit or stash unrelated work, then create the handoff`,
      { count: paths.length, max: PREEXISTING_MAX, fix: "commit or stash unrelated work, then create the handoff" },
    );
  }
  const blobs = blobsOf(cwd, paths);
  return paths.map((path) => ({ path, blob: blobs.get(path) ?? null }));
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Splits `files` into changed and ignored: a pre-existing path whose working-tree blob is unchanged. */
function splitPreexisting(cwd: string, files: string[], preexisting: Preexisting[]): { files: string[]; ignored: string[] } {
  const recorded = new Map(preexisting.map((p) => [p.path, p.blob]));
  const candidates = files.filter((f) => recorded.has(f));
  if (candidates.length === 0) return { files, ignored: [] };
  const current = blobsOf(cwd, candidates);
  const ignored = new Set(candidates.filter((f) => current.get(f) === recorded.get(f)));
  return { files: files.filter((f) => !ignored.has(f)), ignored: [...ignored] };
}

/**
 * Files changed in the worktree at `cwd` since the base: committed, staged, unstaged and untracked
 * (ignored files excluded). Runtime files under .handoffs/ are dropped except PROTECTED_PATHS.
 * Pre-existing changes whose blob is unchanged move to `ignored` (protected paths included: an
 * unchanged config is not an edit, a changed one is caught).
 * Never returns "no changes" for an unusable base: throws scope_base_unavailable instead.
 */
export function changedFiles(opts: {
  cwd: string;
  baseCommit: string;
  branch: string;
  /** Uncommitted changes recorded at create; only excluded when `cwd` is `creatorWorktree`. */
  preexisting?: Preexisting[];
  creatorWorktree?: string;
}): ChangedFiles {
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
  const pre = opts.preexisting ?? [];
  // Another worktree's dirty files aren't the creator's: excluding them there would hide real changes.
  if (pre.length === 0 || opts.creatorWorktree === undefined || !samePath(opts.cwd, opts.creatorWorktree)) {
    return { files, ignored: [], base, usedMergeBase };
  }
  return { ...splitPreexisting(opts.cwd, files, pre), base, usedMergeBase };
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
