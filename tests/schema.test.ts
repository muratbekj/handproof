import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { formatPath } from "../src/schema/errors";
import { Handoff } from "../src/schema/handoff";
import {
  normalizeRepoPath,
  parseHandoffInput,
  type RuleContext,
} from "../src/schema/rules";
import fullHandoffFixture from "./fixtures/handoffs/full-handoff.json";
import shortGoalFixture from "./fixtures/handoffs/short-goal.json";
import validFixture from "./fixtures/handoffs/valid.json";
import { removeDir, tmpDir } from "./helpers/tmp";

const TEST_CONFIG: Config = {
  leaseMinutes: 30,
  checks: {
    test: { run: "bun test", timeoutSec: 300 },
    typecheck: { run: "bunx tsc --noEmit", timeoutSec: 120 },
    lint: { run: "bunx eslint .", timeoutSec: 120 },
  },
};

function withTmp(fn: (dir: string) => void): void {
  const dir = tmpDir("handoffs-schema-");
  try {
    fn(dir);
  } finally {
    removeDir(dir);
  }
}

function ruleContext(
  repoRoot: string,
  overrides: Partial<RuleContext> = {},
): RuleContext {
  return {
    config: TEST_CONFIG,
    repoRoot,
    fileExists: () => true,
    ...overrides,
  };
}

function expectOk(result: ReturnType<typeof parseHandoffInput>) {
  if (!result.ok) {
    throw new Error(
      `expected parse to succeed: ${JSON.stringify(result.failure)}`,
    );
  }
  return result;
}

function expectFailure(result: ReturnType<typeof parseHandoffInput>) {
  if (result.ok) throw new Error("expected parse to fail");
  return result.failure;
}

describe("formatPath", () => {
  test("renders array indexes in brackets", () => {
    expect(formatPath(["acceptance", 0, "check"])).toBe("acceptance[0].check");
    expect(formatPath([])).toBe("");
    expect(formatPath(["context", "files", 2, "path"])).toBe(
      "context.files[2].path",
    );
  });
});

describe("parseHandoffInput", () => {
  test("parses a valid fixture and applies defaults", () => {
    withTmp((dir) => {
      const result = expectOk(
        parseHandoffInput(validFixture, ruleContext(dir)),
      );

      expect(result.value.to).toBe("any");
      expect(result.value.priority).toBe("normal");
      expect(result.value.constraints).toEqual([]);
      expect(result.value.scope.forbidden).toEqual([]);
      expect(result.value.context.decisions).toEqual([]);
    });
  });

  test("reports a 12-character goal with the exact fixable issue", () => {
    withTmp((dir) => {
      const failure = expectFailure(
        parseHandoffInput(shortGoalFixture, ruleContext(dir)),
      );

      expect(failure.error).toBe("validation_failed");
      const issue = failure.issues.find((entry) => entry.path === "goal");
      expect(issue).toEqual({
        path: "goal",
        problem: "too short (12 chars, min 40)",
        fix: "say what done looks like",
      });
    });
  });

  test("reports an acceptance check that is not in config", () => {
    withTmp((dir) => {
      const input: unknown = {
        ...validFixture,
        acceptance: [
          { id: "ac1", description: "works", check: "tests" },
        ],
      };

      const failure = expectFailure(parseHandoffInput(input, ruleContext(dir)));
      const issue = failure.issues.find(
        (entry) => entry.path === "acceptance[0].check",
      );

      expect(issue).toEqual({
        path: "acceptance[0].check",
        problem: "unknown check 'tests'",
        fix: "use one of: test, typecheck, lint",
      });
    });
  });

  test("reports an invalid kind with an enum fix", () => {
    withTmp((dir) => {
      const input: unknown = { ...validFixture, kind: "build" };

      const failure = expectFailure(parseHandoffInput(input, ruleContext(dir)));
      const issue = failure.issues.find((entry) => entry.path === "kind");

      expect(issue).toBeDefined();
      if (issue === undefined) throw new Error("missing kind issue");
      expect(issue.problem).toBe("invalid value 'build'");
      expect(issue.fix.startsWith("use one of: implement, fix, review")).toBe(
        true,
      );
    });
  });

  test("reports an empty acceptance array", () => {
    withTmp((dir) => {
      const input: unknown = { ...validFixture, acceptance: [] };

      const failure = expectFailure(parseHandoffInput(input, ruleContext(dir)));
      const issue = failure.issues.find(
        (entry) => entry.path === "acceptance",
      );

      expect(issue).toEqual({
        path: "acceptance",
        problem: "needs at least 1 item(s)",
        fix: "add at least 1",
      });
    });
  });

  test("rejects context file paths that escape the repo root", () => {
    withTmp((dir) => {
      for (const badPath of ["../x", "/etc/passwd", "src/../../x"]) {
        const input: unknown = {
          ...validFixture,
          context: {
            ...validFixture.context,
            files: [{ path: badPath, why: "escape attempt" }],
          },
        };

        const failure = expectFailure(
          parseHandoffInput(input, ruleContext(dir)),
        );
        const issue = failure.issues.find(
          (entry) => entry.path === "context.files[0].path",
        );

        expect(issue).toEqual({
          path: "context.files[0].path",
          problem: "resolves outside the repo root",
          fix: "use a path relative to the repo root",
        });
      }
    });
  });

  test("normalizes a leading ./ path and accepts it", () => {
    withTmp((dir) => {
      expect(normalizeRepoPath("./src/a.ts", dir)).toBe("src/a.ts");

      const input: unknown = {
        ...validFixture,
        context: {
          ...validFixture.context,
          files: [{ path: "./src/a.ts", why: "normal path" }],
        },
      };

      const result = expectOk(parseHandoffInput(input, ruleContext(dir)));
      expect(result.value.context.files).toHaveLength(1);
    });
  });

  test("warns about a file that does not exist yet instead of failing", () => {
    withTmp((dir) => {
      const input: unknown = {
        ...validFixture,
        context: {
          ...validFixture.context,
          files: [{ path: "src/new.ts", why: "to be created" }],
        },
      };

      const result = expectOk(
        parseHandoffInput(input, {
          config: TEST_CONFIG,
          repoRoot: dir,
        }),
      );
      const warning = result.warnings.find(
        (entry) => entry.path === "context.files[0].path",
      );

      expect(warning).toEqual({
        path: "context.files[0].path",
        problem: "file does not exist yet",
        fix: "fine if the implementer will create it",
      });
    });
  });

  test("reports overlapping allowed and forbidden scope globs", () => {
    withTmp((dir) => {
      const input: unknown = {
        ...validFixture,
        scope: {
          allowed: ["src/auth/**"],
          forbidden: ["src/auth/**"],
        },
      };

      const failure = expectFailure(parseHandoffInput(input, ruleContext(dir)));
      const issue = failure.issues.find(
        (entry) => entry.path === "scope.forbidden[0]",
      );

      expect(issue).toEqual({
        path: "scope.forbidden[0]",
        problem: "'src/auth/**' is also in scope.allowed",
        fix: "remove it from one of the lists",
      });
    });
  });

  test("reports all problems in one issues array", () => {
    withTmp((dir) => {
      const input: unknown = {
        ...validFixture,
        kind: "build",
        goal: "too short",
        context: {
          ...validFixture.context,
          files: [{ path: "../x", why: "escape attempt" }],
        },
        scope: {
          allowed: ["src/auth/**"],
          forbidden: ["src/auth/**"],
        },
        acceptance: [
          { id: "ac1", description: "works", check: "tests" },
        ],
      };

      const failure = expectFailure(parseHandoffInput(input, ruleContext(dir)));
      const paths = new Set(failure.issues.map((entry) => entry.path));

      expect(paths.has("goal")).toBe(true);
      expect(paths.has("kind")).toBe(true);
      expect(paths.has("context.files[0].path")).toBe(true);
      expect(paths.has("scope.forbidden[0]")).toBe(true);
      expect(paths.has("acceptance[0].check")).toBe(true);
      expect(paths.size).toBeGreaterThanOrEqual(5);
    });
  });
});

describe("Handoff", () => {
  test("parses a stored object with schemaVersion 1", () => {
    const parsed = Handoff.safeParse(fullHandoffFixture);

    if (!parsed.success) {
      throw new Error(
        `expected stored handoff to parse: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    expect(parsed.data.schemaVersion).toBe(1);
  });

  test("rejects schemaVersion 2", () => {
    const input: unknown = { ...fullHandoffFixture, schemaVersion: 2 };

    expect(Handoff.safeParse(input).success).toBe(false);
  });
});
