import * as fs from "node:fs";
import * as path from "node:path";
import type { RepoPaths } from "../../src/config";
import type { Status } from "../../src/schema/handoff";
import type { HandoffRepo } from "../../src/store/repo";
import { fixtureHandoff } from "./handoffFixtures";
import { initRepoHandoffs, openTestService, type ServiceHandle } from "./serviceSetup";
import type { TmpRepo } from "./tmpRepo";
import { testEnv } from "./env";

/** Prune command "now"; handoffs 31d old are eligible at default --older-than 30d. */
export const PRUNE_NOW = new Date("2026-11-04T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;

export function isoDaysBefore(base: Date, days: number): string {
  return new Date(base.getTime() - days * MS_PER_DAY).toISOString();
}

export const OLD_UPDATED_AT = isoDaysBefore(PRUNE_NOW, 31);
export const RECENT_UPDATED_AT = isoDaysBefore(PRUNE_NOW, 29);

export function pruneNowEnv(repoDir: string): Record<string, string | undefined> {
  return testEnv({
    HANDPROOF_REPO: repoDir,
    HANDPROOF_NOW: PRUNE_NOW.toISOString(),
  });
}

export function withPruneClock<T>(fn: (now: () => Date) => T): T {
  const now = (): Date => PRUNE_NOW;
  return fn(now);
}

export function writeRunLogs(
  runsDir: string,
  handoffId: string,
  fileNames: string[],
  contents?: string[],
): { absPaths: string[]; relPaths: string[] } {
  const dir = path.join(runsDir, handoffId);
  fs.mkdirSync(dir, { recursive: true });
  const absPaths: string[] = [];
  const relPaths: string[] = [];
  fileNames.forEach((name, i) => {
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, contents?.[i] ?? `log body for ${name}\n`);
    absPaths.push(abs);
    relPaths.push(`.handproof/runs/${handoffId}/${name}`);
  });
  return { absPaths, relPaths };
}

export function touchMtime(filePath: string, when: Date): void {
  const sec = when.getTime() / 1000;
  fs.utimesSync(filePath, sec, sec);
}

const DONE_RESULT = {
  summary: "Completed for prune fixture.",
  commits: ["abc123"],
  criteria: [{ id: "ac1", met: true }],
};

export function insertHandoffRow(
  repo: HandoffRepo,
  status: Status,
  updatedAt: string,
  title: string,
): string {
  const claim =
    status === "claimed" || status === "submitted" || status === "changes_requested" || status === "verified"
      ? {
          by: { name: "cursor-impl", harness: "cursor" as const },
          leaseUntil: isoDaysBefore(PRUNE_NOW, -1),
        }
      : null;
  const result =
    status === "verified" || status === "done"
      ? DONE_RESULT
      : status === "submitted" || status === "changes_requested"
        ? DONE_RESULT
        : null;
  const h = fixtureHandoff({
    status,
    updatedAt,
    claim,
    result,
    title,
  });
  repo.insert(h, {
    at: h.createdAt,
    actor: "planner",
    type: "created",
    data: { title: h.title, kind: h.kind, to: h.to },
  });
  return h.id;
}

export function seedOldDoneWithLogAndLeftoverPruning(repo: TmpRepo): {
  handle: ServiceHandle;
  id: string;
  relPaths: string[];
  logContent: string;
  leftoverContent: string;
} {
  return withPruneClock((now) => {
    const paths = initRepoHandoffs(repo);
    const handle = openTestService(repo, { name: "human-cli", harness: "other" }, now);
    const id = insertHandoffRow(handle.repo, "done", OLD_UPDATED_AT, "Done handoff with leftover .pruning");
    const dir = path.join(paths.runsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const logContent = "original check log\n";
    const leftoverContent = "leftover from interrupted prune\n";
    fs.writeFileSync(path.join(dir, "x.log"), logContent);
    fs.writeFileSync(path.join(dir, "x.log.pruning"), leftoverContent);
    const relPaths = [`.handproof/runs/${id}/x.log`, `.handproof/runs/${id}/x.log.pruning`];
    return { handle, id, relPaths, logContent, leftoverContent };
  });
}

export function seedOldDoneWithTwoLogs(repo: TmpRepo): {
  handle: ServiceHandle;
  id: string;
  relPaths: string[];
  paths: RepoPaths;
} {
  return withPruneClock((now) => {
    const paths = initRepoHandoffs(repo);
    const handle = openTestService(repo, { name: "human-cli", harness: "other" }, now);
    const id = insertHandoffRow(handle.repo, "done", OLD_UPDATED_AT, "Old done handoff for prune");
    const { relPaths } = writeRunLogs(paths.runsDir, id, ["check-a.log", "check-b.log"], ["aa\n", "bbbb\n"]);
    return { handle, id, relPaths, paths };
  });
}
