import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  isHuman,
  loadConfig,
  resolveAgent,
  resolveRepo,
} from "../src/config";
import { HandoffsError } from "../src/errors";
import { testEnv } from "./helpers/env";
import { removeDir, tmpDir } from "./helpers/tmp";
import { tmpRepo, type TmpRepo } from "./helpers/tmpRepo";

function withRepo(fn: (repo: TmpRepo) => void): void {
  const repo = tmpRepo();
  try {
    fn(repo);
  } finally {
    repo.cleanup();
  }
}

function expectHandoffsError(fn: () => unknown, code: string): HandoffsError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }

  if (!(caught instanceof HandoffsError)) {
    const detail =
      caught instanceof Error ? `${caught.name}: ${caught.message}` : typeof caught;
    throw new Error(`expected HandoffsError(${code}), got ${detail}`);
  }

  expect(caught.code).toBe(code);
  return caught;
}

describe("tmpRepo helper", () => {
  test("creates a main-branch repo with one commit", () => {
    const repo = tmpRepo();
    try {
      expect(repo.git(["rev-parse", "--is-inside-work-tree"])).toBe("true");
      expect(repo.git(["branch", "--show-current"])).toBe("main");
      expect(repo.git(["rev-list", "--count", "HEAD"])).toBe("1");
    } finally {
      repo.cleanup();
    }
  });
});

describe("resolveRepo", () => {
  test("finds the main worktree root from a subdirectory", () => {
    withRepo((repo) => {
      fs.mkdirSync(path.join(repo.dir, "src", "deep"), { recursive: true });

      const paths = resolveRepo({
        cwd: path.join(repo.dir, "src", "deep"),
        env: testEnv(),
      });
      const root = fs.realpathSync(repo.dir);

      expect(paths.root).toBe(root);
      expect(paths.worktreeRoot).toBe(root);
      expect(paths.handoffsDir).toBe(path.join(root, ".handproof"));
      expect(paths.configPath).toBe(path.join(root, ".handproof", "config.json"));
      expect(paths.dbPath).toBe(path.join(root, ".handproof", "handoffs.db"));
      expect(paths.runsDir).toBe(path.join(root, ".handproof", "runs"));
    });
  });

  test("uses the main root but the linked worktree toplevel in a linked worktree", () => {
    withRepo((repo) => {
      const worktree = repo.worktree();

      const paths = resolveRepo({ cwd: worktree, env: testEnv() });
      const root = fs.realpathSync(repo.dir);

      expect(paths.root).toBe(root);
      expect(paths.worktreeRoot).toBe(fs.realpathSync(worktree));
      expect(paths.dbPath).toBe(path.join(root, ".handproof", "handoffs.db"));
    });
  });

  test("HANDPROOF_REPO overrides the cwd", () => {
    withRepo((repo) => {
      const elsewhere = tmpDir("handoffs-elsewhere-");
      try {
        const paths = resolveRepo({
          cwd: elsewhere,
          env: testEnv({ HANDPROOF_REPO: repo.dir }),
        });
        const root = fs.realpathSync(repo.dir);

        expect(paths.root).toBe(root);
        expect(paths.dbPath).toBe(path.join(root, ".handproof", "handoffs.db"));
      } finally {
        removeDir(elsewhere);
      }
    });
  });

  test("rejects a cwd that is not inside a git repo", () => {
    const dir = tmpDir("handoffs-nongit-");
    try {
      expectHandoffsError(
        () => resolveRepo({ cwd: dir, env: testEnv() }),
        "not_a_git_repo",
      );
    } finally {
      removeDir(dir);
    }
  });
});

describe("loadConfig", () => {
  test("returns the missing-file defaults", () => {
    withRepo((repo) => {
      const paths = resolveRepo({ cwd: repo.dir, env: testEnv() });
      expect(fs.existsSync(paths.configPath)).toBe(false);

      const config = loadConfig(paths);

      expect(config.leaseMinutes).toBe(30);
      expect(config.checks).toEqual({});
    });
  });

  test("rejects a non-numeric leaseMinutes with a field-named config_invalid error", () => {
    withRepo((repo) => {
      const paths = resolveRepo({ cwd: repo.dir, env: testEnv() });
      fs.mkdirSync(paths.handoffsDir, { recursive: true });
      fs.writeFileSync(paths.configPath, JSON.stringify({ leaseMinutes: "x" }));

      const error = expectHandoffsError(() => loadConfig(paths), "config_invalid");

      expect(JSON.stringify(error.details)).toContain("leaseMinutes");
    });
  });

  test("rejects malformed JSON as config_invalid", () => {
    withRepo((repo) => {
      const paths = resolveRepo({ cwd: repo.dir, env: testEnv() });
      fs.mkdirSync(paths.handoffsDir, { recursive: true });
      fs.writeFileSync(paths.configPath, "not json");

      expectHandoffsError(() => loadConfig(paths), "config_invalid");
    });
  });

  test("parses a valid config and applies the default check timeout", () => {
    withRepo((repo) => {
      const paths = resolveRepo({ cwd: repo.dir, env: testEnv() });
      fs.mkdirSync(paths.handoffsDir, { recursive: true });
      fs.writeFileSync(
        paths.configPath,
        JSON.stringify({
          leaseMinutes: 45,
          checks: { custom: { run: "bun test" } },
        }),
      );

      const config = loadConfig(paths);

      expect(config.leaseMinutes).toBe(45);
      expect(config.checks.custom).toEqual({
        run: "bun test",
        timeoutSec: 300,
      });
    });
  });
});

describe("ConfigSchema and DEFAULT_CONFIG", () => {
  test("ConfigSchema supplies defaults", () => {
    expect(ConfigSchema.parse({})).toEqual({ leaseMinutes: 30, checks: {} });
    expect(ConfigSchema.parse({ checks: { x: { run: "true" } } })).toEqual({
      leaseMinutes: 30,
      checks: { x: { run: "true", timeoutSec: 300 } },
    });
  });

  test("DEFAULT_CONFIG matches the global constraints", () => {
    expect(DEFAULT_CONFIG.leaseMinutes).toBe(30);
    expect(DEFAULT_CONFIG.checks).toEqual({
      test: { run: "bun test", timeoutSec: 300 },
      typecheck: { run: "bunx tsc --noEmit", timeoutSec: 120 },
      lint: { run: "bunx eslint .", timeoutSec: 120 },
    });
  });
});

describe("resolveAgent and isHuman", () => {
  test("reads identity from the environment", () => {
    const planner = resolveAgent({
      HANDPROOF_AGENT: "planner",
      HANDPROOF_HARNESS: "claude-code",
    });
    expect(planner.name).toBe("planner");
    expect(planner.harness).toBe("claude-code");
    expect(planner.session).toBeUndefined();

    const anonymous = resolveAgent({});
    expect(anonymous.name).toBe("anonymous");
    expect(anonymous.harness).toBe("other");
    expect(anonymous.session).toBeUndefined();

    const invalidHarness = resolveAgent({ HANDPROOF_HARNESS: "vim" });
    expect(invalidHarness.name).toBe("anonymous");
    expect(invalidHarness.harness).toBe("other");

    const plannerWithInvalidHarness = resolveAgent({
      HANDPROOF_AGENT: "planner",
      HANDPROOF_HARNESS: "vim",
    });
    expect(plannerWithInvalidHarness.name).toBe("planner");
    expect(plannerWithInvalidHarness.harness).toBe("other");
  });

  test("keeps an explicit session", () => {
    const agent = resolveAgent({ HANDPROOF_SESSION: "ses_123" });
    expect(agent.session).toBe("ses_123");
  });

  test("recognizes human agent names by prefix", () => {
    expect(isHuman({ name: "human-mj", harness: "other" })).toBe(true);
    expect(isHuman({ name: "planner", harness: "other" })).toBe(false);
  });
});
