#!/usr/bin/env bun
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type RepoPaths, loadConfig, resolveAgent, resolveRepo, runInit } from "./config.ts";
import { renderBrief } from "./render/markdown.ts";
import { type AgentRef, Status } from "./schema/handoff.ts";
import type { HandoffService, HandoffSummary, ServiceError } from "./service/handoffs.ts";
import { isHandoffsError } from "./errors.ts";
import { createServer } from "./server.ts";
import { openService } from "./service/open.ts";
import { VERSION } from "./version.ts";

const USAGE = `usage: handoffs <command>

commands:
  init     create .handoffs/config.json and add runtime files to .gitignore
  serve    run the MCP server over stdio
  ls       list handoffs (default: not done or cancelled)
             --all                 include done and cancelled
             --status <s>[,<s>]    only these statuses
  show <id>  print the markdown brief for one handoff

options:
  -h, --help     show this help
  -v, --version  print the version
`;

function printError(err: unknown): void {
  if (isHandoffsError(err)) {
    console.error(`handoffs: ${err.code}: ${err.message}`);
  } else {
    console.error(`handoffs: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
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
      console.error(`handoffs: ${err.message}`);
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
  const name = env.HANDOFFS_AGENT?.trim();
  return resolveAgent(name === undefined || name === "" ? { ...env, HANDOFFS_AGENT: "human-cli" } : env);
}

function withService<T>(env: NodeJS.ProcessEnv, cwd: string, fn: (service: HandoffService, paths: RepoPaths) => T): T {
  const paths = resolveRepo({ cwd, env });
  const opened = openService({ paths, config: loadConfig(paths), agent: cliAgent(env) });
  try {
    return fn(opened.service, paths);
  } finally {
    opened.close();
  }
}

function serviceFailure(err: ServiceError): number {
  console.error(`handoffs: ${err.error}: ${err.message}`);
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
    console.error(`handoffs: validation_failed: ${parsed.error}`);
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
  if (cmd !== undefined) console.error(`handoffs: unknown command or arguments: ${argv.join(" ")}`);
  process.stderr.write(USAGE);
  return 2;
}

if (import.meta.main) {
  // exitCode (not exit) so pending stdout writes flush before the process ends.
  process.exitCode = await main(process.argv.slice(2), process.env, process.cwd());
}
