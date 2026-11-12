import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { HandoffsError } from "../src/errors";
import type { CheckDef } from "../src/config";
import { OUTPUT_CAP, runCommand, splitCommand } from "../src/verify/command";
import { checksToRun, runCheck } from "../src/verify/checks";
import { fixtureHandoff } from "./helpers/handoffFixtures";
import { removeDir, tmpDir } from "./helpers/tmp";
import { processGone } from "./helpers/process";

const split = splitCommand;

describe("splitCommand", () => {
  test("parses argv without shell expansion", () => {
    expect(split("bun test --silent")).toEqual(["bun", "test", "--silent"]);
    expect(split('eslint "src/my file.ts"')).toEqual(["eslint", "src/my file.ts"]);
    expect(split('echo foo"bar"')).toEqual(["echo", "foobar"]);
    expect(split("echo ''")).toEqual(["echo", ""]);
    expect(split("echo $HOME *.ts")).toEqual(["echo", "$HOME", "*.ts"]);
  });

  test("throws bad_command on invalid input", () => {
    expect(() => split('echo "unclosed')).toThrow(HandoffsError);
    try {
      split('echo "unclosed');
    } catch (err) {
      expect((err as HandoffsError).code).toBe("bad_command");
    }
    expect(() => split("")).toThrow(HandoffsError);
    try {
      split("");
    } catch (err) {
      expect((err as HandoffsError).code).toBe("bad_command");
    }
  });
});

describe("runCommand and runCheck", () => {
  function repoLayout(): { repoRoot: string; runsDir: string } {
    const repoRoot = tmpDir("handoffs-cmd-cwd-");
    const runsDir = path.join(repoRoot, ".handproof", "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    return { repoRoot, runsDir };
  }

  test("true exits 0 and writes a log under runsDir", async () => {
    const { repoRoot, runsDir } = repoLayout();
    try {
      const def: CheckDef = { run: "true", timeoutSec: 30 };
      const now = () => new Date("2026-11-04T10:00:00.000Z");
      const result = await runCheck("pass", def, {
        cwd: repoRoot,
        runsDir,
        repoRoot,
        handoffId: "h_01JC0000000000000000000001",
        now,
      });
      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.logPath).toMatch(/^\.handproof\/runs\//);
      if (result.logPath === null) throw new Error("expected logPath");
      const logAbs = path.join(repoRoot, result.logPath);
      expect(fs.existsSync(logAbs)).toBe(true);
    } finally {
      removeDir(repoRoot);
    }
  });

  test("non-zero exit is not passed", async () => {
    const { repoRoot, runsDir } = repoLayout();
    try {
      const result = await runCheck("fail", { run: 'sh -c "exit 3"', timeoutSec: 30 }, {
        cwd: repoRoot,
        runsDir,
        repoRoot,
        handoffId: "h_01JC0000000000000000000002",
        now: () => new Date("2026-11-04T10:00:00.000Z"),
      });
      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(3);
    } finally {
      removeDir(repoRoot);
    }
  });

  test("sleep exceeds timeoutSec → timedOut, returns quickly", async () => {
    const { repoRoot, runsDir } = repoLayout();
    try {
      const started = Date.now();
      const result = await runCheck("slow", { run: "sleep 5", timeoutSec: 1 }, {
        cwd: repoRoot,
        runsDir,
        repoRoot,
        handoffId: "h_01JC0000000000000000000003",
        now: () => new Date("2026-11-04T10:00:00.000Z"),
      });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(3000);
      expect(result.timedOut).toBe(true);
      expect(result.passed).toBe(false);
    } finally {
      removeDir(repoRoot);
    }
  });

  test("timeout kills the process group (background sleep pid dies)", async () => {
    const { repoRoot, runsDir } = repoLayout();
    try {
      await runCheck(
        "slow",
        { run: 'sh -c "sleep 30 & echo $! > pid; wait"', timeoutSec: 1 },
        {
          cwd: repoRoot,
          runsDir,
          repoRoot,
          handoffId: "h_01JC0000000000000000000004",
          now: () => new Date("2026-11-04T10:00:00.000Z"),
        },
      );
      const pidText = fs.readFileSync(path.join(repoRoot, "pid"), "utf8").trim();
      const pid = Number(pidText);
      expect(Number.isFinite(pid)).toBe(true);
      // Dead or a zombie: the orphaned sleep is reaped asynchronously after the group kill.
      expect(await processGone(pid)).toBe(true);
    } finally {
      removeDir(repoRoot);
    }
  });

  test("caps combined output at 1 MiB and marks truncated", async () => {
    const { repoRoot, runsDir } = repoLayout();
    try {
      const script =
        'bun -e "process.stdout.write(\'O\'.repeat(2097152)); process.stderr.write(\'END\')"';
      const result = await runCheck("big", { run: script, timeoutSec: 120 }, {
        cwd: repoRoot,
        runsDir,
        repoRoot,
        handoffId: "h_01JC0000000000000000000005",
        now: () => new Date("2026-11-04T10:00:00.000Z"),
      });
      expect(result.exitCode).toBe(0);
      expect(result.passed).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.outputTail.endsWith("END")).toBe(true);
      if (result.logPath === null) throw new Error("expected logPath");
      const logAbs = path.join(repoRoot, result.logPath);
      const stat = fs.statSync(logAbs);
      expect(stat.size).toBeLessThanOrEqual(OUTPUT_CAP + 512);
      const head = fs.readFileSync(logAbs, "utf8").split("\n")[0];
      expect(head).toBe("[handproof] output truncated to the last 1 MiB");
    } finally {
      removeDir(repoRoot);
    }
  });

  test("unknown check and spawn failures are not passed and do not throw", async () => {
    const { repoRoot, runsDir } = repoLayout();
    try {
      const unknown = await runCheck("missing", undefined, {
        cwd: repoRoot,
        runsDir,
        repoRoot,
        handoffId: "h_01JC0000000000000000000006",
        now: () => new Date("2026-11-04T10:00:00.000Z"),
      });
      expect(unknown.error).toBe("unknown_check");
      expect(unknown.passed).toBe(false);
      expect(unknown.logPath).toBeNull();

      const spawnFail = await runCheck("nope", { run: "definitely-not-a-binary-xyz", timeoutSec: 5 }, {
        cwd: repoRoot,
        runsDir,
        repoRoot,
        handoffId: "h_01JC0000000000000000000007",
        now: () => new Date("2026-11-04T10:00:00.000Z"),
      });
      expect(spawnFail.passed).toBe(false);
      expect(spawnFail.logPath).toBeNull();
    } finally {
      removeDir(repoRoot);
    }
  });
});

describe("checksToRun", () => {
  test("dedupes acceptance check names in first-appearance order", () => {
    const h = fixtureHandoff({
      acceptance: [
        { id: "a", description: "a", check: "test" },
        { id: "b", description: "b" },
        { id: "c", description: "c", check: "lint" },
        { id: "d", description: "d", check: "test" },
      ],
    });
    expect(checksToRun(h)).toEqual(["test", "lint"]);
  });
});

describe("runCommand direct", () => {
  test("OUTPUT_CAP constant is 1 MiB", () => {
    expect(OUTPUT_CAP).toBe(1_048_576);
  });

  test("runCommand returns CommandOutcome shape", async () => {
    const cwd = tmpDir("handoffs-run-cmd-");
    try {
      const out = await runCommand(["true"], { cwd, timeoutMs: 5000 });
      expect(out.exitCode).toBe(0);
      expect(out.timedOut).toBe(false);
      expect(out.output).toBeInstanceOf(Uint8Array);
    } finally {
      removeDir(cwd);
    }
  });
});
