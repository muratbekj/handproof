import * as fs from "node:fs";
import {
  DEFAULT_CONFIG,
  loadConfig,
  resolveAgent,
  resolveRepo,
  runInit,
  type Config,
  type RepoPaths,
} from "../../src/config";
import type { AgentRef } from "../../src/schema/handoff";
import { openService } from "../../src/service/open";
import type { HandoffAdmin, HandoffService } from "../../src/service/handoffs";
import type { HandoffRepo } from "../../src/store/repo";
import type { Db } from "../../src/store/db";
import { testEnv } from "./env";
import type { TmpRepo } from "./tmpRepo";

export interface ServiceHandle {
  service: HandoffService & HandoffAdmin;
  repo: HandoffRepo;
  db: Db;
  paths: RepoPaths;
  config: Config;
  agent: AgentRef;
  close(): void;
}

export function initRepoHandoffs(repo: TmpRepo): RepoPaths {
  const paths = resolveRepo({
    cwd: repo.dir,
    env: testEnv({ HANDOFFS_REPO: repo.dir }),
  });
  runInit(paths);
  return paths;
}

export function openTestService(
  repo: TmpRepo,
  agent: AgentRef,
  now: () => Date = () => new Date(),
): ServiceHandle {
  const paths = initRepoHandoffs(repo);
  const config = loadConfig(paths);
  const handle = openService({ paths, config, agent, now });
  return { ...handle, paths, config, agent };
}

/** Agent presets used in Phase 1 service acceptance tests. */
export const AGENTS = {
  planner: { name: "planner", harness: "claude-code" as const },
  cursorImpl: { name: "cursor-impl", harness: "cursor" as const },
  humanMj: { name: "human-mj", harness: "other" as const },
  humanCli: { name: "human-cli", harness: "other" as const },
};

export function agentEnv(agent: AgentRef): Record<string, string | undefined> {
  return testEnv({
    HANDOFFS_AGENT: agent.name,
    HANDOFFS_HARNESS: agent.harness,
  });
}

export function resolvePaths(repo: TmpRepo, env: Record<string, string | undefined>): RepoPaths {
  return resolveRepo({
    cwd: repo.dir,
    env: { ...env, HANDOFFS_REPO: repo.dir },
  });
}

export function writeConfig(paths: RepoPaths, config: Config = DEFAULT_CONFIG): void {
  fs.mkdirSync(paths.handoffsDir, { recursive: true });
  fs.writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function resolveAgentFromRepo(
  repo: TmpRepo,
  env: Record<string, string | undefined>,
): AgentRef {
  return resolveAgent({ ...env, HANDOFFS_REPO: repo.dir });
}
