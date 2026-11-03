import * as fs from "node:fs";
import * as path from "node:path";
import { tmpDir } from "./tmp";

export interface TmpRepo {
  /** Absolute path to the temporary repo. */
  dir: string;
  /** Run git in the repo and return trimmed stdout; throw on a non-zero exit. */
  git(args: string | readonly string[]): string;
  /** Add a linked worktree next to the repo and return its absolute path. */
  worktree(name?: string): string;
  /** Remove the repo and every worktree created through this helper. */
  cleanup(): void;
}

/**
 * Create a temp directory containing a real git repo on `main`, with local
 * user identity and one initial commit.
 */
export function tmpRepo(): TmpRepo {
  const dir = tmpDir("handoffs-repo-");
  const extraDirs: string[] = [];

  const git = (args: string | readonly string[]): string => {
    const argv = typeof args === "string" ? [args] : [...args];
    const result = Bun.spawnSync(["git", ...argv], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString("utf8");
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8");
      throw new Error(
        `git ${argv.join(" ")} failed with exit code ${String(result.exitCode)}: ${stderr}`,
      );
    }
    return stdout.trimEnd();
  };

  const worktree = (name = "wt"): string => {
    const target = `${dir}-${name}`;
    git(["worktree", "add", target, "-b", `feat-${name}`]);
    extraDirs.push(target);
    return target;
  };

  const cleanup = (): void => {
    for (const extra of extraDirs) {
      fs.rmSync(extra, { recursive: true, force: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };

  try {
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Handoffs Test"]);
    git(["config", "user.email", "handoffs-test@example.com"]);
    git(["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(dir, "README.md"), "# test repo\n");
    git(["add", "-A"]);
    git(["commit", "-m", "initial commit"]);
  } catch (error) {
    cleanup();
    throw error;
  }

  return { dir, git, worktree, cleanup };
}
