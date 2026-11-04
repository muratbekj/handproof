import { describe, expect, test } from "bun:test";
import { HandoffsError } from "../src/errors";
import { createGitInfo } from "../src/git";
import { handoffIdTime, newHandoffId } from "../src/ids";
import { isBusy } from "../src/store/db";
import { removeDir, tmpDir } from "./helpers/tmp";
import { tmpRepo } from "./helpers/tmpRepo";

const ID_RE = /^h_[0-9A-HJKMNP-TV-Z]{26}$/;

describe("newHandoffId", () => {
  test("matches the handoff id regex", () => {
    expect(newHandoffId()).toMatch(ID_RE);
  });

  test("100 ids created in a loop are strictly increasing as strings", () => {
    let previous = "";
    for (let i = 0; i < 100; i += 1) {
      const id = newHandoffId();
      expect(id).toMatch(ID_RE);
      if (previous !== "") {
        expect(id > previous).toBe(true);
      }
      previous = id;
    }
  });
});

describe("handoffIdTime", () => {
  test("decodes time from a valid id", () => {
    const id = newHandoffId();
    const t = handoffIdTime(id);
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThan(0);
  });

  test("throws HandoffsError not_found on malformed id", () => {
    let caught: unknown;
    try {
      handoffIdTime("h_not-a-ulid");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HandoffsError);
    expect((caught as HandoffsError).code).toBe("not_found");
  });
});

describe("createGitInfo", () => {
  test("reports main branch and HEAD in a fresh tmpRepo", () => {
    const repo = tmpRepo();
    try {
      const git = createGitInfo(repo.dir);
      expect(git.branch()).toBe("main");
      expect(git.head()).toBe(repo.git(["rev-parse", "HEAD"]));
    } finally {
      repo.cleanup();
    }
  });

  test("returns null head when there are no commits", () => {
    const dir = tmpDir("handoffs-git-empty-");
    try {
      const init = Bun.spawnSync(["git", "init", "-b", "main"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(init.exitCode).toBe(0);
      Bun.spawnSync(["git", "config", "user.email", "t@example.com"], { cwd: dir });
      Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: dir });

      const git = createGitInfo(dir);
      expect(git.head()).toBeNull();
    } finally {
      removeDir(dir);
    }
  });

  test('reports branch "HEAD" after detached checkout', () => {
    const repo = tmpRepo();
    try {
      repo.git(["checkout", "--detach"]);
      const git = createGitInfo(repo.dir);
      expect(git.branch()).toBe("HEAD");
    } finally {
      repo.cleanup();
    }
  });
});

describe("isBusy", () => {
  test("detects SQLite busy and locked codes", () => {
    expect(isBusy({ code: "SQLITE_BUSY_SNAPSHOT" })).toBe(true);
    expect(isBusy({ code: "SQLITE_BUSY" })).toBe(true);
    expect(isBusy({ code: "SQLITE_LOCKED" })).toBe(true);
  });

  test("rejects constraint errors, generic errors, and null", () => {
    expect(isBusy({ code: "SQLITE_CONSTRAINT" })).toBe(false);
    expect(isBusy(new Error("x"))).toBe(false);
    expect(isBusy(null)).toBe(false);
  });
});
