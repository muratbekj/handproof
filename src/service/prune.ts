import { lstatSync, mkdtempSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { RepoPaths } from "../config.ts";
import type { AgentRef } from "../schema/handoff.ts";
import type { HandoffRepo } from "../store/repo.ts";

export interface PruneOptions {
  olderThanDays: number;
  dryRun: boolean;
}

export interface PrunedFile {
  /** Repo-relative POSIX path, e.g. `.handoffs/runs/<id>/<file>.log`. */
  path: string;
  bytes: number;
  /** Run directory name: the handoff id (or the orphan directory's name). */
  dir: string;
  orphan: boolean;
}

export interface PruneReport {
  dryRun: boolean;
  /** Sorted by path. */
  files: PrunedFile[];
  /** Run directories that had files pruned (handoffs and orphans). */
  dirs: number;
  bytes: number;
}

export interface PruneDeps {
  repo: HandoffRepo;
  paths: RepoPaths;
  now: () => Date;
  agent: AgentRef;
}

export const DEFAULT_PRUNE_DAYS = 30;
const DAY_MS = 86_400_000;
/** Prefix of the fresh staging directory created inside a run dir while its files are pruned. */
const STAGING_PREFIX = ".prune-staging-";
const TERMINAL = new Set(["done", "cancelled"]);

/** `<N>d` with N a non-negative integer → N; anything else → null. */
export function parseOlderThan(text: string): number | null {
  const m = /^(\d+)d$/.exec(text);
  if (m === null || m[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

interface Entry {
  abs: string;
  name: string;
  bytes: number;
  mtimeMs: number;
  regular: boolean;
}

/** Entries directly inside `dir`, via lstat (symlinks are never followed). */
function entriesOf(dir: string): Entry[] {
  return readdirSync(dir)
    .map((name) => {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      return { abs, name, bytes: st.size, mtimeMs: st.mtimeMs, regular: st.isFile() };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function removeIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // Not empty or already gone: leave it.
  }
}

/**
 * Deletes check logs of handoffs that are done/cancelled and older than the cutoff, plus orphan run
 * directories whose files are all older than it. Only regular files directly inside
 * `runsDir/<name>/` are touched; symlinks are never followed or removed. Each pruned handoff gets
 * one `logs_pruned` event. Throws on a DB error (e.g. busy); the failing handoff's files are restored.
 */
export function pruneLogs(deps: PruneDeps, opts: PruneOptions): PruneReport {
  const { repo, paths, agent } = deps;
  const at = deps.now();
  const cutoffMs = at.getTime() - opts.olderThanDays * DAY_MS;
  const rel = (abs: string): string => relative(paths.root, abs).split(sep).join("/");

  const report: PruneReport = { dryRun: opts.dryRun, files: [], dirs: 0, bytes: 0 };
  if (!isRealDir(paths.runsDir)) return report;

  const dirNames = readdirSync(paths.runsDir).sort();
  for (const name of dirNames) {
    const dir = join(paths.runsDir, name);
    if (!isRealDir(dir)) continue;
    const h = repo.get(name);
    const entries = entriesOf(dir);
    if (h !== null) {
      if (!TERMINAL.has(h.status) || Date.parse(h.updatedAt) > cutoffMs) continue;
    } else if (entries.length === 0 || entries.some((e) => e.mtimeMs > cutoffMs)) {
      continue;
    }
    const files = entries.filter((e) => e.regular);
    if (files.length === 0) continue;

    const pruned: PrunedFile[] = files.map((f) => ({ path: rel(f.abs), bytes: f.bytes, dir: name, orphan: h === null }));
    const bytes = pruned.reduce((s, f) => s + f.bytes, 0);

    if (!opts.dryRun) {
      if (h === null) {
        for (const f of files) unlinkSync(f.abs);
      } else {
        // Stage by rename into a fresh directory (names can't collide with anything there), so a
        // failed event append can put every file back under its original name.
        const stage = mkdtempSync(join(dir, STAGING_PREFIX));
        const staged: { from: string; to: string }[] = [];
        try {
          for (const f of files) {
            const to = join(stage, f.name);
            renameSync(f.abs, to);
            staged.push({ from: f.abs, to });
          }
          repo.appendEvent(h.id, {
            at: at.toISOString(),
            actor: agent.name,
            type: "logs_pruned",
            data: { paths: pruned.map((p) => p.path), bytes },
          });
        } catch (err) {
          for (const s of staged) {
            try {
              renameSync(s.to, s.from);
            } catch {
              // Best effort: a file that can't be moved back stays in the staging directory.
            }
          }
          removeIfEmpty(stage);
          throw err;
        }
        for (const s of staged) unlinkSync(s.to);
        rmdirSync(stage);
      }
      removeIfEmpty(dir);
    }

    report.files.push(...pruned);
    report.dirs += 1;
    report.bytes += bytes;
  }
  report.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return report;
}

/** Bytes below 1024 as `B`, then `KB`, `MB` with one decimal (1024-based). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** CLI output lines for a report (no trailing newline). */
export function formatPruneReport(r: PruneReport): string[] {
  if (r.files.length === 0) return ["nothing to prune"];
  const verb = r.dryRun ? "would prune" : "pruned";
  return [
    ...r.files.map((f) => `${verb}  ${f.path}`),
    `${verb} ${plural(r.files.length, "file")} (${formatBytes(r.bytes)}) from ${plural(r.dirs, "handoff")}`,
  ];
}
