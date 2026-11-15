import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { main } from "../src/bin";
import { DEFAULT_CONFIG, resolveRepo, runInit } from "../src/config";
import { testEnv } from "./helpers/env";
import { tmpRepo, type TmpRepo } from "./helpers/tmpRepo";

const CURSOR_COMMAND_FILES = [
  "handproof-create.md",
  "handproof-pickup.md",
  "handproof-review.md",
] as const;

const GITIGNORE_LINES = [
  ".handproof/handoffs.db",
  ".handproof/handoffs.db-*",
  ".handproof/runs/",
] as const;

function withRepo(fn: (repo: TmpRepo) => void): void {
  const repo = tmpRepo();
  try {
    fn(repo);
  } finally {
    repo.cleanup();
  }
}

async function withRepoAsync(fn: (repo: TmpRepo) => Promise<void>): Promise<void> {
  const repo = tmpRepo();
  try {
    await fn(repo);
  } finally {
    repo.cleanup();
  }
}

function countLine(content: string, line: string): number {
  return content.split(/\r?\n/).filter((entry) => entry === line).length;
}

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

async function captureStderr<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stderr: string }> {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalError = console.error;

  const write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as typeof process.stderr.write;

  process.stderr.write = write;
  console.error = (...args: unknown[]): void => {
    chunks.push(`${args.map((arg) => formatArg(arg)).join(" ")}\n`);
  };

  try {
    const result = await fn();
    return { result, stderr: chunks.join("") };
  } finally {
    process.stderr.write = originalWrite;
    console.error = originalError;
  }
}

describe("runInit", () => {
  test("writes config.json with the defaults and appends the gitignore lines once", () => {
    withRepo((repo) => {
      const paths = resolveRepo({ cwd: repo.dir, env: testEnv() });

      runInit(paths);

      const rawConfig = fs.readFileSync(paths.configPath, "utf8");
      const parsedConfig: unknown = JSON.parse(rawConfig);
      expect(parsedConfig).toEqual(DEFAULT_CONFIG);
      expect(rawConfig.endsWith("\n")).toBe(true);

      const formatted = JSON.stringify(parsedConfig, null, 2);
      expect(rawConfig).toBe(`${formatted}\n`);

      const gitignore = fs.readFileSync(
        path.join(paths.root, ".gitignore"),
        "utf8",
      );
      expect(countLine(gitignore, "# handproof")).toBe(1);
      for (const line of GITIGNORE_LINES) {
        expect(countLine(gitignore, line)).toBe(1);
      }
    });
  });

  test("is idempotent on a second run", () => {
    withRepo((repo) => {
      const paths = resolveRepo({ cwd: repo.dir, env: testEnv() });
      runInit(paths);

      const gitignorePath = path.join(paths.root, ".gitignore");
      const configBefore = fs.readFileSync(paths.configPath, "utf8");
      const gitignoreBefore = fs.readFileSync(gitignorePath, "utf8");

      const second = runInit(paths);

      expect(second.created).toEqual([]);
      expect(fs.readFileSync(paths.configPath, "utf8")).toBe(configBefore);
      expect(fs.readFileSync(gitignorePath, "utf8")).toBe(gitignoreBefore);
    });
  });

  test("does not merge an existing .gitignore line that lacks a trailing newline", () => {
    withRepo((repo) => {
      const paths = resolveRepo({ cwd: repo.dir, env: testEnv() });
      const gitignorePath = path.join(paths.root, ".gitignore");
      fs.writeFileSync(gitignorePath, "node_modules");

      runInit(paths);

      const gitignore = fs.readFileSync(gitignorePath, "utf8");
      expect(gitignore.startsWith("node_modules\n")).toBe(true);
      expect(countLine(gitignore, "node_modules")).toBe(1);
      for (const line of GITIGNORE_LINES) {
        expect(countLine(gitignore, line)).toBe(1);
      }
    });
  });

  test("writes the three Cursor commands under .cursor/commands", () => {
    withRepo((repo) => {
      const paths = resolveRepo({ cwd: repo.dir, env: testEnv() });

      const res = runInit(paths);

      for (const name of CURSOR_COMMAND_FILES) {
        const rel = `.cursor/commands/${name}`;
        expect(res.created).toContain(rel);
        const content = fs.readFileSync(path.join(paths.root, rel), "utf8");
        // Cursor uses the first heading as the command's description.
        expect(content.split("\n")[0]).toMatch(/^# \S/);
        expect(content.endsWith("\n")).toBe(true);
      }
      const read = (name: string): string =>
        fs.readFileSync(path.join(paths.root, ".cursor/commands", name), "utf8");
      expect(read("handproof-create.md")).toContain("`handoff_create`");
      expect(read("handproof-create.md")).toContain("Don't do the task yourself");
      expect(read("handproof-pickup.md")).toContain("`handoff_claim`");
      expect(read("handproof-review.md")).toContain("`handoff_review`");
      expect(read("handproof-review.md")).toContain("Never invent a reason");
    });
  });

  test("never overwrites an existing Cursor command and reports it as existing", () => {
    withRepo((repo) => {
      const paths = resolveRepo({ cwd: repo.dir, env: testEnv() });
      const dir = path.join(paths.root, ".cursor", "commands");
      fs.mkdirSync(dir, { recursive: true });
      const custom = "# my own pickup\n";
      fs.writeFileSync(path.join(dir, "handproof-pickup.md"), custom);

      const res = runInit(paths);

      expect(fs.readFileSync(path.join(dir, "handproof-pickup.md"), "utf8")).toBe(custom);
      expect(res.skipped).toContain(".cursor/commands/handproof-pickup.md");
      expect(res.created).toContain(".cursor/commands/handproof-create.md");
      expect(res.created).toContain(".cursor/commands/handproof-review.md");
    });
  });

  test("never overwrites an existing config.json", () => {
    withRepo((repo) => {
      const paths = resolveRepo({ cwd: repo.dir, env: testEnv() });
      fs.mkdirSync(paths.handoffsDir, { recursive: true });
      const custom = '{"leaseMinutes": 99, "checks": {}}\n';
      fs.writeFileSync(paths.configPath, custom);

      runInit(paths);

      expect(fs.readFileSync(paths.configPath, "utf8")).toBe(custom);
    });
  });
});

describe("main", () => {
  test("init returns 0 and creates the files", async () => {
    await withRepoAsync(async (repo) => {
      const code = await main(["init"], testEnv(), repo.dir);

      expect(code).toBe(0);
      expect(
        fs.existsSync(path.join(repo.dir, ".handproof", "config.json")),
      ).toBe(true);
      const gitignore = fs.readFileSync(
        path.join(repo.dir, ".gitignore"),
        "utf8",
      );
      for (const line of GITIGNORE_LINES) {
        expect(countLine(gitignore, line)).toBe(1);
      }
    });
  });

  test("an unknown command returns non-zero and prints usage to stderr", async () => {
    await withRepoAsync(async (repo) => {
      const { result, stderr } = await captureStderr(() =>
        main(["bogus"], testEnv(), repo.dir),
      );

      expect(result).not.toBe(0);
      expect(stderr).toMatch(/usage/i);
    });
  });
});
