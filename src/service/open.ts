import type { Config, RepoPaths } from "../config.ts";
import { createGitInfo } from "../git.ts";
import type { AgentRef } from "../schema/handoff.ts";
import { type Db, openDb } from "../store/db.ts";
import { type HandoffRepo, createRepo } from "../store/repo.ts";
import { type TaskRepo, createTaskRepo } from "../store/task-repo.ts";
import { type HandoffAdmin, type HandoffService, createHandoffService } from "./handoffs.ts";
import { type TaskService, createTaskService } from "./tasks.ts";

/** The one place that wires DB + repo + git + service (server, CLI, tests). */
export function openService(opts: {
  paths: RepoPaths;
  config: Config;
  agent: AgentRef;
  now?: () => Date;
}): {
  service: HandoffService & HandoffAdmin;
  tasks: TaskService;
  repo: HandoffRepo;
  taskRepo: TaskRepo;
  db: Db;
  close(): void;
} {
  const db = openDb(opts.paths.dbPath);
  const repo = createRepo(db);
  const taskRepo = createTaskRepo(db);
  const now = opts.now ?? ((): Date => new Date());
  const git = createGitInfo(opts.paths.worktreeRoot);
  const service = createHandoffService({ repo, config: opts.config, paths: opts.paths, agent: opts.agent, now, git });
  const tasks = createTaskService({ tasks: taskRepo, handoffs: repo, paths: opts.paths, agent: opts.agent, now, git });
  let closed = false;
  return {
    service,
    tasks,
    repo,
    taskRepo,
    db,
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
