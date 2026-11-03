#!/usr/bin/env bun
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, resolveAgent, resolveRepo, runInit } from "./config.ts";
import { isHandoffsError } from "./errors.ts";
import { createServer } from "./server.ts";
import { VERSION } from "./version.ts";

const USAGE = `usage: handoffs <command>

commands:
  init     create .handoffs/config.json and add runtime files to .gitignore
  serve    run the MCP server over stdio

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
  const handle = serveStdio(() => createServer({ paths, config, agent }), {
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
  return 0;
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
