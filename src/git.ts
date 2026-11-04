import { gitEnv } from "./config.ts";
import { HandoffsError } from "./errors.ts";

export interface GitInfo {
  /** Current branch name; "HEAD" when detached. */
  branch(): string;
  /** Full HEAD commit sha, or null when the repo has no commits. */
  head(): string | null;
}

function run(cwd: string, args: string[]): string | null {
  let proc;
  try {
    proc = Bun.spawnSync(["git", ...args], {
      cwd,
      env: gitEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new HandoffsError("git_not_found", "could not run git; is it installed and on PATH?", {
      cause: String(err),
    });
  }
  if (proc.exitCode !== 0) return null;
  const out = proc.stdout.toString().trim();
  return out === "" ? null : out;
}

export function createGitInfo(cwd: string): GitInfo {
  return {
    branch(): string {
      // symbolic-ref works before the first commit too; fails when detached.
      return run(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]) ?? "HEAD";
    },
    head(): string | null {
      return run(cwd, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    },
  };
}
