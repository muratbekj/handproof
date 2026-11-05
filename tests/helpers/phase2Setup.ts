import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "../../src/config";
import validFixture from "../fixtures/handoffs/valid.json";
import { initRepoHandoffs, writeConfig, type ServiceHandle } from "./serviceSetup";
import type { TmpRepo } from "./tmpRepo";

/** Checks and scope used in PLAN Steps 5–7 acceptance tests. */
export const PHASE2_CONFIG: Config = {
  leaseMinutes: 30,
  checks: {
    pass: { run: "true", timeoutSec: 60 },
    fail: { run: "false", timeoutSec: 60 },
    slow: { run: "sleep 5", timeoutSec: 1 },
    okfile: { run: "test -f src/auth/ok.txt", timeoutSec: 60 },
    test: { run: "test -f src/auth/ok.txt", timeoutSec: 60 },
  },
};

export const DEMO_CONFIG: Config = {
  leaseMinutes: 30,
  checks: {
    test: { run: "test -f src/auth/ok.txt", timeoutSec: 120 },
  },
};

export function initPhase2Repo(repo: TmpRepo, config: Config = PHASE2_CONFIG) {
  const paths = initRepoHandoffs(repo);
  writeConfig(paths, config);
  fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
  repo.git(["add", ".gitignore", ".handoffs/config.json"]);
  repo.git(["commit", "-m", "track handoffs setup"]);
  return paths;
}

export function implementHandoffInput(
  acceptance: { id: string; description: string; check?: string }[] = [
    {
      id: "ac1",
      description: "Auth ok file exists and scope is respected.",
      check: "okfile",
    },
  ],
) {
  return {
    ...validFixture,
    scope: { allowed: ["src/auth/**"], forbidden: [] },
    acceptance,
  };
}

export function criteriaFor(ids: string[], met = true) {
  return ids.map((id) => ({ id, met }));
}

export const T0 = new Date("2026-11-03T12:00:00.000Z");

export function withPhase2Clock<T>(fn: (now: () => Date, advanceMinutes: (m: number) => void) => T): T {
  let ms = T0.getTime();
  const now = (): Date => new Date(ms);
  const advanceMinutes = (minutes: number): void => {
    ms += minutes * 60_000;
  };
  return fn(now, advanceMinutes);
}

export function closeHandle(handle: ServiceHandle): void {
  handle.close();
}
