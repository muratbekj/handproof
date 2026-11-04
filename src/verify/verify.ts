import { type Config, type RepoPaths, loadConfig } from "../config.ts";
import { isHandoffsError } from "../errors.ts";
import type { Handoff } from "../schema/handoff.ts";
import { type CheckResult, checksToRun, runCheck } from "./checks.ts";
import { type Violation, changedFiles, checkScope } from "./scope.ts";

export interface CriterionResult {
  id: string;
  met: boolean;
  source: "check" | "self";
  check?: string;
  note?: string;
}

export interface Verification {
  at: string;
  by: string;
  passed: boolean;
  checks: CheckResult[];
  scope: { base: string | null; usedMergeBase: boolean; files: string[]; violations: Violation[]; error?: string };
  criteria: CriterionResult[];
}

export interface VerifyDeps {
  paths: RepoPaths;
  now: () => Date;
  by: string;
}

/** Sum of the timeouts of the checks `h` runs; unknown checks count 0. */
export function checksTimeoutSec(h: Handoff, config: Config): number {
  return checksToRun(h).reduce((sum, name) => sum + (Object.hasOwn(config.checks, name) ? (config.checks[name]?.timeoutSec ?? 0) : 0), 0);
}

function scopeResult(h: Handoff, paths: RepoPaths): Verification["scope"] {
  try {
    const changed = changedFiles({ cwd: paths.worktreeRoot, baseCommit: h.repo.baseCommit, branch: h.repo.branch });
    return {
      base: changed.base,
      usedMergeBase: changed.usedMergeBase,
      files: changed.files,
      violations: checkScope(changed.files, h.scope, h.kind),
    };
  } catch (err) {
    if (!isHandoffsError(err)) throw err;
    return { base: null, usedMergeBase: false, files: [], violations: [], error: `${err.code}: ${err.message}` };
  }
}

function criteriaResults(h: Handoff, checks: CheckResult[]): CriterionResult[] {
  const reported = new Map((h.result?.criteria ?? []).map((c) => [c.id, c]));
  return h.acceptance.map((a): CriterionResult => {
    const self = reported.get(a.id);
    const note = self?.note !== undefined ? { note: self.note } : {};
    if (a.check !== undefined) {
      const passed = checks.find((c) => c.name === a.check)?.passed ?? false;
      return { id: a.id, met: passed, source: "check", check: a.check, ...note };
    }
    if (self === undefined) return { id: a.id, met: false, source: "self", note: "not reported" };
    return { id: a.id, met: self.met, source: "self", ...note };
  });
}

/**
 * Runs the handoff's checks (sequentially, in the caller's worktree), then the scope diff, and
 * judges every acceptance criterion. Runs outside any transaction; never changes state.
 * Config is re-read from disk on every run, so a long-running server uses the current checks
 * (throws config_invalid when it is broken).
 */
export async function verifyHandoff(h: Handoff, deps: VerifyDeps): Promise<Verification> {
  const config = loadConfig(deps.paths);
  const at = deps.now().toISOString();
  const checks: CheckResult[] = [];
  for (const name of checksToRun(h)) {
    const def = Object.hasOwn(config.checks, name) ? config.checks[name] : undefined;
    checks.push(
      await runCheck(name, def, {
        cwd: deps.paths.worktreeRoot,
        runsDir: deps.paths.runsDir,
        repoRoot: deps.paths.root,
        handoffId: h.id,
        now: deps.now,
      }),
    );
  }
  const scope = scopeResult(h, deps.paths);
  const criteria = criteriaResults(h, checks);
  const passed =
    checks.every((c) => c.passed) &&
    scope.violations.length === 0 &&
    scope.error === undefined &&
    criteria.every((c) => c.met);
  return { at, by: deps.by, passed, checks, scope, criteria };
}
