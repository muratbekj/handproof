#!/usr/bin/env bun
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type RepoPaths, loadConfig, resolveAgent, resolveRepo, runInit } from "./config.ts";
import { renderBrief } from "./render/markdown.ts";
import { type AgentRef, Status } from "./schema/handoff.ts";
import type { HandoffAdmin, HandoffService, HandoffSummary, ServiceError } from "./service/handoffs.ts";
import { DEFAULT_PRUNE_DAYS, formatPruneReport, parseOlderThan } from "./service/prune.ts";
import { parseTimeout, waitForStatus } from "./service/wait.ts";
import { isHandoffsError } from "./errors.ts";
import { createServer } from "./server.ts";
import { openService } from "./service/open.ts";
import { VERSION } from "./version.ts";

const USAGE = `usage: handproof <command>

commands:
  init     create .handproof/config.json and add runtime files to .gitignore
  serve    run the MCP server over stdio
  ls       list handoffs (default: not done or cancelled)
             --all                 include done and cancelled
             --status <s>[,<s>]    only these statuses
  show <id>  print the markdown brief for one handoff
  review <id> accept|reject [reason...]
             accept a verified handoff (done) or reject it (reopened); reject needs a reason
  prune    delete check logs (.handproof/runs/) of done or cancelled handoffs
             --older-than <N>d     only handoffs finished at least N days ago (default 30d)
             --dry-run             list what would be deleted; delete nothing
  wait <id> [<id>...]
             block until a handoff's status changes, then print "<id> <status>"
             --until <s>[,<s>]     wait until a status is one of these instead
             --timeout <N>s|m|h    give up after this long (exit 124)

options:
  -h, --help     show this help
  -v, --version  print the version
`;

function printError(err: unknown): void {
  if (isHandoffsError(err)) {
    console.error(`handproof: ${err.code}: ${err.message}`);
  } else {
    console.error(`handproof: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

function cmdInit(env: NodeJS.ProcessEnv, cwd: string): number {
  const paths = resolveRepo({ cwd, env });
  const res = runInit(paths);
  for (const f of res.created) process.stdout.write(`created  ${f}\n`);
  for (const f of res.updated) process.stdout.write(`updated  ${f}\n`);
  for (const f of res.skipped) process.stdout.write(`exists   ${f}\n`);
  return 0;
}

async function cmdServe(env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  const paths = resolveRepo({ cwd, env });
  const config = loadConfig(paths);
  const agent = resolveAgent(env);
  const opened = openService({ paths, config, agent });
  const handle = serveStdio(() => createServer({ paths, config, agent, service: opened.service }), {
    onerror: (err) => {
      console.error(`handproof: ${err.message}`);
    },
  });
  // serveStdio closes itself on stdin EOF; resolve then so the caller can finish.
  await new Promise<void>((resolveDone) => {
    const done = (): void => {
      resolveDone();
    };
    process.stdin.once("end", done);
    process.stdin.once("close", done);
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await handle.close().catch(() => undefined);
  opened.close();
  return 0;
}

/** The CLI counts as a human (decision 4): default identity human-cli. */
function cliAgent(env: NodeJS.ProcessEnv): AgentRef {
  const name = env.HANDPROOF_AGENT?.trim();
  return resolveAgent(name === undefined || name === "" ? { ...env, HANDPROOF_AGENT: "human-cli" } : env);
}

function withService<T>(
  env: NodeJS.ProcessEnv,
  cwd: string,
  fn: (service: HandoffService & HandoffAdmin, paths: RepoPaths) => T,
): T {
  const paths = resolveRepo({ cwd, env });
  const opened = openService({ paths, config: loadConfig(paths), agent: cliAgent(env) });
  try {
    return fn(opened.service, paths);
  } finally {
    opened.close();
  }
}

function serviceFailure(err: ServiceError): number {
  console.error(`handproof: ${err.error}: ${err.message}`);
  return 1;
}

const ALL_STATUSES = Status.options;
const LS_COLUMNS = ["ID", "STATUS", "KIND", "PRIORITY", "TO", "TITLE"] as const;

function formatTable(rows: HandoffSummary[]): string {
  const cells = rows.map((h) => [h.id, h.status, h.kind, h.priority, h.to, h.title.replace(/\r?\n/g, " ")]);
  const all = [[...LS_COLUMNS], ...cells];
  const widths = LS_COLUMNS.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all
    .map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  "))
    .join("\n");
}

/** null = bad arguments (usage error). */
function parseLsArgs(args: string[]): { status?: Status[] } | { error: string } | null {
  let status: Status[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") {
      status = [...ALL_STATUSES];
    } else if (a === "--status") {
      const v = args[++i];
      if (v === undefined) return null;
      const parts = v.split(",").map((p) => p.trim()).filter((p) => p !== "");
      const bad = parts.filter((p) => !Status.safeParse(p).success);
      if (parts.length === 0 || bad.length > 0) {
        return { error: `unknown status '${bad.join(",") || v}'; use one of: ${ALL_STATUSES.join(", ")}` };
      }
      status = parts as Status[];
    } else {
      return null;
    }
  }
  return status === undefined ? {} : { status };
}

function cmdLs(args: string[], env: NodeJS.ProcessEnv, cwd: string): number | null {
  const parsed = parseLsArgs(args);
  if (parsed === null) return null;
  if ("error" in parsed) {
    console.error(`handproof: validation_failed: ${parsed.error}`);
    return 1;
  }
  return withService(env, cwd, (service) => {
    const r = service.list({ ...parsed, limit: 200 });
    if (!r.ok) return serviceFailure(r.error);
    process.stdout.write(r.value.length === 0 ? "no handoffs\n" : `${formatTable(r.value)}\n`);
    return 0;
  });
}

function cmdShow(id: string, env: NodeJS.ProcessEnv, cwd: string): number {
  return withService(env, cwd, (service) => {
    const r = service.get(id);
    if (!r.ok) return serviceFailure(r.error);
    process.stdout.write(`${renderBrief(r.value.handoff, r.value.events)}\n`);
    return 0;
  });
}

function cmdReview(args: string[], env: NodeJS.ProcessEnv, cwd: string): number | null {
  const [id, decision, ...words] = args;
  if (id === undefined || (decision !== "accept" && decision !== "reject")) return null;
  const reason = words.length === 0 ? undefined : words.join(" ");
  return withService(env, cwd, (service) => {
    const r = service.review(id, decision, reason);
    if (!r.ok) return serviceFailure(r.error);
    process.stdout.write(`${r.value.id} ${r.value.status}\n`);
    return 0;
  });
}

/** Bad arguments: message plus usage on stderr, exit 2. */
function usageError(message: string): number {
  console.error(`handproof: ${message}`);
  process.stderr.write(USAGE);
  return 2;
}

function cmdPrune(args: string[], env: NodeJS.ProcessEnv, cwd: string): number {
  let olderThanDays = DEFAULT_PRUNE_DAYS;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--older-than") {
      const v = args[++i];
      const days = v === undefined ? null : parseOlderThan(v);
      if (days === null) return usageError(`--older-than needs whole days like 30d, got '${v ?? ""}'`);
      olderThanDays = days;
    } else {
      return usageError(`unknown argument for prune: ${a ?? ""}`);
    }
  }
  return withService(env, cwd, (service) => {
    const r = service.prune({ olderThanDays, dryRun });
    if (!r.ok) return serviceFailure(r.error);
    process.stdout.write(`${formatPruneReport(r.value).join("\n")}\n`);
    return 0;
  });
}

class Interrupted extends Error {}

/** Real sleep that rejects with Interrupted once `signal` aborts. */
function abortableSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolveSleep, rejectSleep) => {
      if (signal.aborted) {
        rejectSleep(new Interrupted());
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        rejectSleep(new Interrupted());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolveSleep();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
}

async function cmdWait(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  const ids: string[] = [];
  let until: Status[] | undefined;
  let timeoutMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--until") {
      const v = args[++i];
      const parts = (v ?? "").split(",").map((p) => p.trim()).filter((p) => p !== "");
      const bad = parts.filter((p) => !Status.safeParse(p).success);
      if (parts.length === 0 || bad.length > 0) {
        return usageError(`unknown status '${bad.join(",") || (v ?? "")}' for --until; use: ${ALL_STATUSES.join(", ")}`);
      }
      until = parts as Status[];
    } else if (a === "--timeout") {
      const v = args[++i];
      const ms = v === undefined ? null : parseTimeout(v);
      if (ms === null) return usageError(`--timeout needs <N>s, <N>m or <N>h with N >= 1, got '${v ?? ""}'`);
      timeoutMs = ms;
    } else if (a.startsWith("-") || a === "") {
      return usageError(`unknown argument for wait: ${a}`);
    } else {
      ids.push(a);
    }
  }
  if (ids.length === 0) return usageError("wait needs at least one handoff id");

  const paths = resolveRepo({ cwd, env });
  const opened = openService({ paths, config: loadConfig(paths), agent: cliAgent(env) });
  const abort = new AbortController();
  const onSignal = (): void => {
    abort.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const hits = await waitForStatus(
      ids,
      { ...(until !== undefined ? { until } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
      { service: opened.service, sleep: abortableSleep(abort.signal), now: () => new Date() },
    );
    const timedOut = hits.some((h) => h.timedOut === true);
    process.stdout.write(hits.map((h) => `${h.id} ${h.status}${h.timedOut === true ? " (timeout)" : ""}\n`).join(""));
    return timedOut ? 124 : 0;
  } catch (err) {
    if (err instanceof Interrupted || abort.signal.aborted) return 130;
    printError(err);
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    opened.close();
  }
}

/** CLI entry. Returns the process exit code; never calls process.exit itself. */
export async function main(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "init":
        if (rest.length > 0) break;
        return cmdInit(env, cwd);
      case "serve":
        if (rest.length > 0) break;
        return await cmdServe(env, cwd);
      case "ls": {
        const code = cmdLs(rest, env, cwd);
        if (code === null) break;
        return code;
      }
      case "review": {
        const code = cmdReview(rest, env, cwd);
        if (code === null) break;
        return code;
      }
      case "prune":
        return cmdPrune(rest, env, cwd);
      case "wait":
        return await cmdWait(rest, env, cwd);
      case "show":
        if (rest.length !== 1 || rest[0] === undefined) break;
        return cmdShow(rest[0], env, cwd);
      case "-h":
      case "--help":
      case "help":
        process.stdout.write(USAGE);
        return 0;
      case "-v":
      case "--version":
        process.stdout.write(`${VERSION}\n`);
        return 0;
      default:
        break;
    }
  } catch (err) {
    printError(err);
    return 1;
  }
  if (cmd !== undefined) console.error(`handproof: unknown command or arguments: ${argv.join(" ")}`);
  process.stderr.write(USAGE);
  return 2;
}

if (import.meta.main) {
  // exitCode (not exit) so pending stdout writes flush before the process ends.
  process.exitCode = await main(process.argv.slice(2), process.env, process.cwd());
}
