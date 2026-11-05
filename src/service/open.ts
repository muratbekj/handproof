import type { Config, RepoPaths } from "../config.ts";
import { createGitInfo } from "../git.ts";
import type { AgentRef } from "../schema/handoff.ts";
import { type Db, openDb } from "../store/db.ts";
import { type HandoffRepo, createRepo } from "../store/repo.ts";
import { type HandoffAdmin, type HandoffService, createHandoffService } from "./handoffs.ts";

/** The one place that wires DB + repo + git + service (server, CLI, tests). */
export function openService(opts: {
  paths: RepoPaths;
  config: Config;
  agent: AgentRef;
  now?: () => Date;
}): { service: HandoffService & HandoffAdmin; repo: HandoffRepo; db: Db; close(): void } {
  const db = openDb(opts.paths.dbPath);
  const repo = createRepo(db);
  const service = createHandoffService({
    repo,
    config: opts.config,
    paths: opts.paths,
    agent: opts.agent,
    now: opts.now ?? ((): Date => new Date()),
    git: createGitInfo(opts.paths.worktreeRoot),
  });
  let closed = false;
  return {
    service,
    repo,
    db,
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
