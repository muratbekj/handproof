import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import packageJson from "../package.json";
import { BUN } from "./helpers/bun";
import { AGENTS, initRepoHandoffs } from "./helpers/serviceSetup";
import { testEnv } from "./helpers/env";
import { processGone } from "./helpers/process";
import { removeDir, tmpDir } from "./helpers/tmp";
import { tmpRepo } from "./helpers/tmpRepo";

const PROJECT_ROOT = path.join(import.meta.dir, "..");
const LAUNCHER = path.join(PROJECT_ROOT, "bin/handproof.js");
const NODE = Bun.which("node");

function run(cmd: string[], env: Record<string, string | undefined> = testEnv()) {
  const proc = Bun.spawnSync(cmd, { cwd: PROJECT_ROOT, env, stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

beforeAll(() => {
  // The launcher runs the built server, so dist/bin.js must be current.
  const build = run([BUN, "run", "build"]);
  if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr}`);
});

describe("npx launcher (bin/handproof.js)", () => {
  test("package.json bin points at the launcher, which starts with a node shebang", () => {
    expect(packageJson.bin.handproof).toBe("bin/handproof.js");
    expect(fs.readFileSync(LAUNCHER, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  test("under Bun, runs the server", () => {
    const result = run([BUN, LAUNCHER, "--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  test.skipIf(NODE === null)("under Node with Bun installed, runs the server through Bun", () => {
    const result = run([NODE ?? "node", LAUNCHER, "--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  test.skipIf(NODE === null)("under Node, passes the server's exit code and stderr through", () => {
    const result = run([NODE ?? "node", LAUNCHER, "no-such-command"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown command or arguments: no-such-command");
  });

  test.skipIf(NODE === null)("under Node without Bun on PATH, prints a one-line install hint and exits 1", () => {
    const emptyPath = tmpDir("handproof-nobun-");
    try {
      const result = run([NODE ?? "node", LAUNCHER, "--version"], testEnv({ PATH: emptyPath }));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      const lines = result.stderr.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("handproof needs Bun");
      expect(lines[0]).toContain("https://bun.sh");
    } finally {
      removeDir(emptyPath);
    }
  });

  test.skipIf(NODE === null)("under Node, MCP stdio serve works through the launcher", async () => {
    const repo = tmpRepo();
    try {
      initRepoHandoffs(repo);
      const env = testEnv({
        HANDPROOF_REPO: repo.dir,
        HANDPROOF_AGENT: AGENTS.cursorImpl.name,
        HANDPROOF_HARNESS: AGENTS.cursorImpl.harness,
      });
      const stderrChunks: string[] = [];
      const transport = new StdioClientTransport({
        command: NODE ?? "node",
        args: [LAUNCHER, "serve"],
        env: env as Record<string, string>,
        cwd: PROJECT_ROOT,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });
      const client = new Client({ name: "launcher-test", version: "0.0.1" });
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("handoff_create");
      await client.close();
      expect(stderrChunks.join("")).toBe("");
    } finally {
      repo.cleanup();
    }
  });

  test.skipIf(NODE === null)("under Node, SIGTERM to the launcher stops the server", async () => {
    const repo = tmpRepo();
    const fifoDir = tmpDir("handproof-fifo-");
    let serverPid: number | undefined;
    let stdinFd: number | undefined;
    try {
      initRepoHandoffs(repo);
      // stdin is a FIFO this test holds open, so the server never sees EOF when the launcher dies:
      // it stops only if the signal reaches it.
      const fifo = path.join(fifoDir, "stdin");
      if (Bun.spawnSync(["mkfifo", fifo]).exitCode !== 0) throw new Error("mkfifo failed");
      stdinFd = fs.openSync(fifo, fs.constants.O_RDWR);
      const launcher = Bun.spawn([NODE ?? "node", LAUNCHER, "serve"], {
        cwd: PROJECT_ROOT,
        env: testEnv({ HANDPROOF_REPO: repo.dir, HANDPROOF_AGENT: AGENTS.cursorImpl.name }),
        stdin: stdinFd,
        stdout: "pipe",
        stderr: "pipe",
      });
      for (let i = 0; i < 100 && serverPid === undefined; i++) {
        const out = Bun.spawnSync(["pgrep", "-P", String(launcher.pid)]).stdout.toString().trim();
        if (out !== "") serverPid = Number(out.split("\n")[0]);
        else await Bun.sleep(20);
      }
      if (serverPid === undefined) throw new Error("launcher never started the server");

      launcher.kill("SIGTERM");
      await launcher.exited;
      expect(launcher.signalCode).toBe("SIGTERM");
      expect(await processGone(serverPid)).toBe(true);
    } finally {
      // If the signal wasn't forwarded, don't leave an orphaned server behind.
      if (serverPid !== undefined) {
        try {
          process.kill(serverPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      if (stdinFd !== undefined) fs.closeSync(stdinFd);
      removeDir(fifoDir);
      repo.cleanup();
    }
  });
});
