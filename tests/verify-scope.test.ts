import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { HandoffsError } from "../src/errors";
import {
  PROTECTED_PATHS,
  changedFiles,
  checkScope,
} from "../src/verify/scope";
import { tmpRepo } from "./helpers/tmpRepo";

const SCOPE = {
  allowed: ["src/auth/**"],
  forbidden: ["**/migrations/**"],
};

describe("checkScope", () => {
  test("flags package.json outside allowed globs for implement kind", () => {
    const v = checkScope(["package.json"], SCOPE, "implement");
    expect(v).toEqual([{ path: "package.json", rule: "outside src/auth/**" }]);
  });

  test("allows src/auth paths including dotfiles; forbidden migrations glob wins", () => {
    expect(checkScope(["src/auth/login.ts"], SCOPE, "implement")).toEqual([]);
    expect(checkScope(["src/auth/.env"], SCOPE, "implement")).toEqual([]);
    expect(checkScope(["src/auth/migrations/1.sql"], SCOPE, "implement")).toEqual([
      { path: "src/auth/migrations/1.sql", rule: "**/migrations/**" },
    ]);
  });

  test("review kind rejects any file change", () => {
    expect(checkScope(["src/auth/login.ts"], SCOPE, "review")).toEqual([
      { path: "src/auth/login.ts", rule: "no changes allowed for review" },
    ]);
    expect(checkScope([], SCOPE, "review")).toEqual([]);
  });

  test("protected .handproof/config.json", () => {
    expect(PROTECTED_PATHS).toContain(".handproof/config.json");
    expect(checkScope([".handproof/config.json"], SCOPE, "implement")).toEqual([
      { path: ".handproof/config.json", rule: "protected: .handproof/config.json" },
    ]);
  });
});

describe("changedFiles", () => {
  function baseSha(repo: ReturnType<typeof tmpRepo>): string {
    return repo.git(["rev-parse", "HEAD"]);
  }

  test("lists committed, uncommitted, and untracked changes; ignores gitignored files", () => {
    const repo = tmpRepo();
    try {
      const base = baseSha(repo);
      fs.writeFileSync(path.join(repo.dir, "package.json"), '{"name":"t"}\n');
      repo.git(["add", "package.json"]);
      repo.git(["commit", "-m", "touch package"]);

      fs.writeFileSync(path.join(repo.dir, "README.md"), "# changed\n");
      fs.mkdirSync(path.join(repo.dir, "docs"), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, "docs", "x.md"), "x\n");
      fs.appendFileSync(path.join(repo.dir, ".gitignore"), "\nsecret.log\n");
      fs.writeFileSync(path.join(repo.dir, "secret.log"), "ignored\n");

      const { files } = changedFiles({ cwd: repo.dir, baseCommit: base, branch: "main" });
      expect(files).toContain("package.json");
      expect(files).toContain("README.md");
      expect(files).toContain("docs/x.md");
      expect(files).not.toContain("secret.log");
    } finally {
      repo.cleanup();
    }
  });

  test("unicode and space in path is listed exactly", () => {
    const repo = tmpRepo();
    try {
      const base = baseSha(repo);
      const rel = "src/auth/my file ü.ts";
      fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, rel), "export {};\n");
      repo.git(["add", "-A"]);
      repo.git(["commit", "-m", "unicode path"]);

      const { files } = changedFiles({ cwd: repo.dir, baseCommit: base, branch: "main" });
      expect(files).toContain(rel);
    } finally {
      repo.cleanup();
    }
  });

  test("drops .handproof runs but not protected config", () => {
    const repo = tmpRepo();
    try {
      const base = baseSha(repo);
      fs.mkdirSync(path.join(repo.dir, ".handproof", "runs"), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, ".handproof", "runs", "x.log"), "log\n");
      fs.writeFileSync(path.join(repo.dir, ".handproof", "config.json"), "{}\n");
      repo.git(["add", ".handproof/config.json"]);
      repo.git(["commit", "-m", "config"]);

      const { files } = changedFiles({ cwd: repo.dir, baseCommit: base, branch: "main" });
      expect(files).not.toContain(".handproof/runs/x.log");
      expect(files).toContain(".handproof/config.json");
    } finally {
      repo.cleanup();
    }
  });

  test("git mv lists deletion and addition paths", () => {
    const repo = tmpRepo();
    try {
      fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, "src/auth/a.ts"), "a\n");
      repo.git(["add", "src/auth/a.ts"]);
      repo.git(["commit", "-m", "add a"]);
      const base = repo.git(["rev-parse", "HEAD"]);

      fs.mkdirSync(path.join(repo.dir, "lib"), { recursive: true });
      repo.git(["mv", "src/auth/a.ts", "lib/a.ts"]);

      const { files } = changedFiles({ cwd: repo.dir, baseCommit: base, branch: "main" });
      expect(files).toContain("src/auth/a.ts");
      expect(files).toContain("lib/a.ts");
      expect(checkScope(files, SCOPE, "implement").some((v) => v.path === "lib/a.ts")).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  test("unknown base sha falls back to merge-base", () => {
    const repo = tmpRepo();
    try {
      const fake = "0123456789abcdef0123456789abcdef01234567";
      const result = changedFiles({ cwd: repo.dir, baseCommit: fake, branch: "main" });
      expect(result.usedMergeBase).toBe(true);
      expect(result.base).toBe(repo.git(["merge-base", "main", "HEAD"]));
    } finally {
      repo.cleanup();
    }
  });

  test("rebased base uses merge-base and excludes obsolete base-only changes", () => {
    const repo = tmpRepo();
    try {
      const aCommit = baseSha(repo);
      fs.writeFileSync(path.join(repo.dir, "only-on-old-base.txt"), "old\n");
      repo.git(["add", "only-on-old-base.txt"]);
      repo.git(["commit", "-m", "B commit"]);
      const bCommit = repo.git(["rev-parse", "HEAD"]);

      repo.git(["reset", "--hard", aCommit]);
      fs.writeFileSync(path.join(repo.dir, "README.md"), "# amended main\n");
      repo.git(["add", "README.md"]);
      repo.git(["commit", "-m", "B2 on main"]);
      const b2 = repo.git(["rev-parse", "HEAD"]);

      repo.git(["checkout", "-b", "work"]);
      fs.writeFileSync(path.join(repo.dir, "after-rebase.txt"), "new\n");
      repo.git(["add", "after-rebase.txt"]);
      repo.git(["commit", "-m", "work on top of B2"]);

      const result = changedFiles({ cwd: repo.dir, baseCommit: bCommit, branch: "main" });
      expect(result.usedMergeBase).toBe(true);
      expect(result.files).toContain("after-rebase.txt");
      expect(result.files).not.toContain("only-on-old-base.txt");
      expect(bCommit).not.toBe(b2);
    } finally {
      repo.cleanup();
    }
  });

  test("throws scope_base_unavailable when merge-base cannot be resolved", () => {
    const repo = tmpRepo();
    try {
      expect(() =>
        changedFiles({
          cwd: repo.dir,
          baseCommit: "0123456789abcdef0123456789abcdef01234567",
          branch: "no-such-branch-name",
        }),
      ).toThrow(HandoffsError);
      try {
        changedFiles({
          cwd: repo.dir,
          baseCommit: "0123456789abcdef0123456789abcdef01234567",
          branch: "no-such-branch-name",
        });
      } catch (err) {
        expect((err as HandoffsError).code).toBe("scope_base_unavailable");
      }
    } finally {
      repo.cleanup();
    }
  });
});
