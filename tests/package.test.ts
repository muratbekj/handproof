import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import packageJson from "../package.json";
import { removeDir, tmpDir } from "./helpers/tmp";
import { testEnv } from "./helpers/env";
import { tmpRepo } from "./helpers/tmpRepo";

const PROJECT_ROOT = path.join(import.meta.dir, "..");
const GITIGNORE_LINES = [".handproof/handoffs.db", ".handproof/handoffs.db-*", ".handproof/runs/"] as const;

describe("bun pm pack dry-run (PLAN Step 4)", () => {
  test("pack list excludes src, tests, docs, notes, examples, SPEC", () => {
    const result = Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    expect(out).toContain("package.json");
    expect(out).toContain("dist/bin.js");
    for (const forbidden of ["src/", "tests/", "docs/", "notes/", "examples/", "SPEC.md"]) {
      expect(out).not.toContain(forbidden);
    }
  });
});

describe("packaged tarball install (PLAN Step 4)", () => {
  test("handproof init and --version from installed pack", () => {
    const packDir = tmpDir("handoffs-pack-");
    const installDir = tmpDir("handoffs-install-");
    const repo = tmpRepo();
    try {
      const pack = Bun.spawnSync(["bun", "pm", "pack", "--destination", packDir], {
        cwd: PROJECT_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(pack.exitCode).toBe(0);
      const tarball = fs.readdirSync(packDir).find((f) => f.endsWith(".tgz"));
      if (tarball === undefined) throw new Error("pack did not produce a .tgz");

      const add = Bun.spawnSync(["bun", "add", path.join(packDir, tarball)], {
        cwd: installDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(add.exitCode).toBe(0);

      const bin = path.join(installDir, "node_modules", ".bin", "handproof");
      expect(fs.existsSync(bin)).toBe(true);

      const init = Bun.spawnSync([bin, "init"], {
        cwd: repo.dir,
        env: testEnv({ HANDPROOF_REPO: repo.dir }),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(init.exitCode).toBe(0);
      expect(fs.existsSync(path.join(repo.dir, ".handproof", "config.json"))).toBe(true);
      const gitignore = fs.readFileSync(path.join(repo.dir, ".gitignore"), "utf8");
      for (const line of GITIGNORE_LINES) {
        expect(gitignore).toContain(line);
      }

      const versionProc = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
      expect(versionProc.exitCode).toBe(0);
      expect(versionProc.stdout.toString().trim()).toBe(packageJson.version);
    } finally {
      repo.cleanup();
      removeDir(packDir);
      removeDir(installDir);
    }
  });
});
