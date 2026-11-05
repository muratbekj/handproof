import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { CheckDef } from "../config.ts";
import { isHandoffsError } from "../errors.ts";
import type { Handoff } from "../schema/handoff.ts";
import { runCommand, splitCommand } from "./command.ts";

export interface CheckResult {
  name: string;
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  /** Repo-relative POSIX path of the captured output, e.g. ".handoffs/runs/h_…/2026-11-04T10-00-00-000Z-test.log". */
  logPath: string | null;
  /** Last 4096 bytes of output, UTF-8 decoded (lossy). */
  outputTail: string;
  error?: "unknown_check" | "bad_command" | "spawn_failed";
}

export interface RunCheckOptions {
  /** Where the command runs: the calling agent's worktree. */
  cwd: string;
  runsDir: string;
  repoRoot: string;
  handoffId: string;
  now: () => Date;
}

export const TAIL_BYTES = 4096;
export const TRUNCATED_MARKER = "[handoffs] output truncated to the last 1 MiB";

/** Unique acceptance[].check names in first-appearance order. */
export function checksToRun(h: Handoff): string[] {
  const names: string[] = [];
  for (const a of h.acceptance) {
    if (a.check !== undefined && !names.includes(a.check)) names.push(a.check);
  }
  return names;
}

function failed(name: string, error: NonNullable<CheckResult["error"]>, explanation: string): CheckResult {
  return {
    name,
    passed: false,
    exitCode: null,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: 0,
    logPath: null,
    outputTail: explanation,
    error,
  };
}

function logFileName(at: Date, name: string): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}-${name}.log`;
}

/** Runs one configured check. Never throws for a bad, unknown or unspawnable command. */
export async function runCheck(name: string, def: CheckDef | undefined, opts: RunCheckOptions): Promise<CheckResult> {
  if (def === undefined) {
    return failed(name, "unknown_check", `check '${name}' is not defined in .handoffs/config.json`);
  }
  let argv: string[];
  try {
    argv = splitCommand(def.run);
  } catch (err) {
    if (isHandoffsError(err)) return failed(name, "bad_command", err.message);
    throw err;
  }

  const startedAt = opts.now();
  let outcome;
  try {
    outcome = await runCommand(argv, { cwd: opts.cwd, timeoutMs: def.timeoutSec * 1000 });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return failed(name, "spawn_failed", `could not start '${argv[0] ?? ""}': ${why}`.replace(/\r?\n/g, " "));
  }

  const dir = join(opts.runsDir, opts.handoffId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, logFileName(startedAt, name));
  const marker = outcome.truncated ? new TextEncoder().encode(`${TRUNCATED_MARKER}\n`) : new Uint8Array(0);
  const log = new Uint8Array(marker.byteLength + outcome.output.byteLength);
  log.set(marker, 0);
  log.set(outcome.output, marker.byteLength);
  writeFileSync(file, log);

  const tail = outcome.output.subarray(Math.max(0, outcome.output.byteLength - TAIL_BYTES));
  return {
    name,
    passed: outcome.exitCode === 0 && !outcome.timedOut,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    truncated: outcome.truncated,
    durationMs: outcome.durationMs,
    logPath: relative(opts.repoRoot, file).split(sep).join("/"),
    outputTail: new TextDecoder("utf-8", { fatal: false }).decode(tail),
  };
}
