import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as z from "zod/v4";
import { HandoffsError } from "./errors.ts";
import { AgentRef, Harness } from "./schema/handoff.ts";

export interface RepoPaths {
  /** Absolute main-worktree root (or HANDOFFS_REPO). */
  root: string;
  /** Absolute toplevel of the current worktree. */
  worktreeRoot: string;
  /** <root>/.handoffs */
  handoffsDir: string;
  /** <root>/.handoffs/config.json */
  configPath: string;
  /** <root>/.handoffs/handoffs.db */
  dbPath: string;
  /** <root>/.handoffs/runs */
  runsDir: string;
}

// ---------------------------------------------------------------------------
// Repo resolution
// ---------------------------------------------------------------------------

/** Git variables that would make `git rev-parse` ignore `cwd`. */
const GIT_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];

function gitEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !GIT_LOCATION_VARS.includes(k)) out[k] = v;
  }
  return out;
}

/** Runs `git rev-parse <args>` in `cwd`; returns trimmed stdout or null when git fails. */
function revParse(cwd: string, args: string[]): string | null {
  let proc;
  try {
    proc = Bun.spawnSync(["git", "rev-parse", ...args], {
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

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

interface GitLocation {
  root: string;
  worktreeRoot: string;
}

function locateGit(dir: string): GitLocation | null {
  if (!isDirectory(dir)) return null;
  const toplevel = revParse(dir, ["--path-format=absolute", "--show-toplevel"]);
  const commonDir = revParse(dir, ["--path-format=absolute", "--git-common-dir"]);
  if (toplevel === null || commonDir === null) return null;
  const worktreeRoot = realpathSync(toplevel);
  const common = commonDir.replace(/\/+$/, "");
  // Main worktree's .git dir → its parent is the shared root. Anything else
  // (submodule under .git/modules, custom layout) → fall back to this worktree.
  const root = common.endsWith("/.git") ? realpathSync(dirname(common)) : worktreeRoot;
  return { root, worktreeRoot };
}

export function resolveRepo(opts: { cwd: string; env: NodeJS.ProcessEnv }): RepoPaths {
  const cwd = resolve(opts.cwd);
  const override = opts.env.HANDOFFS_REPO;
  let loc: GitLocation;

  if (override !== undefined && override !== "") {
    const overrideDir = resolve(cwd, override);
    const target = locateGit(overrideDir);
    if (target === null) {
      throw new HandoffsError(
        "not_a_git_repo",
        `HANDOFFS_REPO=${override} is not inside a git repository`,
        { path: overrideDir },
      );
    }
    const root = realpathSync(overrideDir);
    // Use the caller's worktree only when cwd belongs to the same repository.
    const here = locateGit(cwd);
    const worktreeRoot = here !== null && here.root === target.root ? here.worktreeRoot : target.worktreeRoot;
    loc = { root, worktreeRoot };
  } else {
    const here = locateGit(cwd);
    if (here === null) {
      throw new HandoffsError(
        "not_a_git_repo",
        `${cwd} is not inside a git repository (run inside a repo or set HANDOFFS_REPO)`,
        { path: cwd },
      );
    }
    loc = here;
  }

  const handoffsDir = join(loc.root, ".handoffs");
  return {
    root: loc.root,
    worktreeRoot: loc.worktreeRoot,
    handoffsDir,
    configPath: join(handoffsDir, "config.json"),
    dbPath: join(handoffsDir, "handoffs.db"),
    runsDir: join(handoffsDir, "runs"),
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const CHECK_NAME_RE = /^[a-z][a-z0-9_-]*$/;

export const CheckName = z.string().regex(CHECK_NAME_RE, "check names must match ^[a-z][a-z0-9_-]*$");

export const CheckDef = z.object({
  run: z.string().min(1),
  timeoutSec: z.number().int().positive().default(300),
});
export type CheckDef = z.infer<typeof CheckDef>;

export const ConfigSchema = z.object({
  leaseMinutes: z.number().int().positive().default(30),
  checks: z.record(CheckName, CheckDef).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = Object.freeze({
  leaseMinutes: 30,
  checks: Object.freeze({
    test: Object.freeze({ run: "bun test", timeoutSec: 300 }),
    typecheck: Object.freeze({ run: "bunx tsc --noEmit", timeoutSec: 120 }),
    lint: Object.freeze({ run: "bunx eslint .", timeoutSec: 120 }),
  }),
});

function formatConfigPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

/** Missing file → defaults with no checks. Unreadable, malformed or invalid → HandoffsError("config_invalid"). */
export function loadConfig(paths: RepoPaths): Config {
  if (!existsSync(paths.configPath)) {
    return { leaseMinutes: DEFAULT_CONFIG.leaseMinutes, checks: {} };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.configPath, "utf8"));
  } catch (err) {
    throw new HandoffsError("config_invalid", `${paths.configPath} is not valid JSON`, {
      file: paths.configPath,
      issues: [{ path: "", message: err instanceof Error ? err.message : String(err) }],
    });
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: formatConfigPath(i.path), message: i.message }));
    const summary = issues.map((i) => `${i.path === "" ? "(root)" : i.path}: ${i.message}`).join("; ");
    throw new HandoffsError("config_invalid", `${paths.configPath} is invalid: ${summary}`, {
      file: paths.configPath,
      issues,
    });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

export function resolveAgent(env: NodeJS.ProcessEnv): AgentRef {
  const name = env.HANDOFFS_AGENT?.trim();
  const harness = Harness.safeParse(env.HANDOFFS_HARNESS?.trim());
  const session = env.HANDOFFS_SESSION?.trim();
  const agent: AgentRef = {
    name: name !== undefined && name !== "" ? name : "anonymous",
    harness: harness.success ? harness.data : "other",
  };
  if (session !== undefined && session !== "") agent.session = session;
  return AgentRef.parse(agent);
}

export function isHuman(agent: AgentRef): boolean {
  return agent.name.startsWith("human");
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export const GITIGNORE_COMMENT = "# handoffs-mcp";
export const GITIGNORE_LINES = [".handoffs/handoffs.db", ".handoffs/handoffs.db-*", ".handoffs/runs/"] as const;

export interface InitResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

/** Idempotent: writes .handoffs/config.json if missing and appends missing .gitignore lines. Paths in the result are relative to the repo root. */
export function runInit(paths: RepoPaths): InitResult {
  const result: InitResult = { created: [], updated: [], skipped: [] };

  mkdirSync(paths.handoffsDir, { recursive: true });

  const configRel = ".handoffs/config.json";
  if (existsSync(paths.configPath)) {
    result.skipped.push(configRel);
  } else {
    writeFileSync(paths.configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx" });
    result.created.push(configRel);
  }

  const gitignoreRel = ".gitignore";
  const gitignorePath = join(paths.root, gitignoreRel);
  const existed = existsSync(gitignorePath);
  const current = existed ? readFileSync(gitignorePath, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !present.has(l));

  if (missing.length === 0) {
    result.skipped.push(gitignoreRel);
  } else {
    let next = current;
    if (next !== "" && !next.endsWith("\n")) next += "\n";
    if (next !== "") next += "\n";
    if (!present.has(GITIGNORE_COMMENT)) next += `${GITIGNORE_COMMENT}\n`;
    next += missing.map((l) => `${l}\n`).join("");
    writeFileSync(gitignorePath, next);
    (existed ? result.updated : result.created).push(gitignoreRel);
  }

  return result;
}
