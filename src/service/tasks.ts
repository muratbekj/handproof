import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as z from "zod/v4";
import { type RepoPaths, isHuman } from "../config.ts";
import { isHandoffsError } from "../errors.ts";
import type { GitInfo } from "../git.ts";
import { newTaskId } from "../ids.ts";
import { type Issue, zodToIssues } from "../schema/errors.ts";
import type { AgentRef } from "../schema/handoff.ts";
import {
  ApproveInput,
  CancelInput,
  type LeadMove,
  PAYLOADS,
  type Payload,
  RejectInput,
  type Risk,
  type Task,
  TaskInput,
  TaskStatus,
} from "../schema/task.ts";
import { isBusy } from "../store/db.ts";
import type { HandoffRepo } from "../store/repo.ts";
import type { NewTaskEvent, TaskEvent, TaskRepo } from "../store/task-repo.ts";
import { scanSecrets, secretError } from "../verify/secrets.ts";
import { type HandoffSummary, type Result, type ServiceError, toSummary } from "./handoffs.ts";
import { type HumanAction, humanMove, isGate, leadMove, leadTargets } from "./task-lifecycle.ts";

/** Fix rounds a fresh plan (and each un-blocking, by default) allows. */
export const DEFAULT_ROUNDS = 3;

export interface TaskSummary {
  id: string;
  status: TaskStatus;
  risk: Risk;
  goal: string;
  from: string;
  rounds: { used: number; limit: number };
  createdAt: string;
  updatedAt: string;
}

export function toTaskSummary(t: Task): TaskSummary {
  return {
    id: t.id,
    status: t.status,
    risk: t.risk,
    goal: t.goal,
    from: t.from.name,
    rounds: t.rounds,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export interface TransitionOutcome {
  task: Task;
  /** Moves the lead may make next; empty at a gate or terminal state. */
  next: TaskStatus[];
  waitingOnHuman: boolean;
}

export interface TaskService {
  create(raw: unknown): Result<Task>;
  /** Lead moves (creator only). Gate states are left only through approve / reject. */
  transition(id: string, to: string, payload: unknown): Result<TransitionOutcome>;
  get(id: string): Result<{ task: Task; events: TaskEvent[]; handoffs: HandoffSummary[] }>;
  /** Default: every status except done and cancelled. */
  list(f: { status?: TaskStatus[]; limit?: number }): Result<TaskSummary[]>;
  /** Human only (CLI). */
  approve(id: string, raw: unknown): Result<Task>;
  reject(id: string, raw: unknown): Result<Task>;
  cancel(id: string, raw: unknown): Result<Task>;
}

export interface TaskServiceDeps {
  tasks: TaskRepo;
  handoffs: HandoffRepo;
  paths: RepoPaths;
  agent: AgentRef;
  now: () => Date;
  git: GitInfo;
}

const UNFINISHED = TaskStatus.options.filter((s) => s !== "done" && s !== "cancelled");
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: ServiceError): Result<T> => ({ ok: false, error });

function notFound(id: string): ServiceError {
  return { error: "not_found", message: `no task with id ${id}`, id };
}

function validationFailed(issues: Issue[]): ServiceError {
  const summary = issues.map((i) => `${i.path === "" ? "(root)" : i.path}: ${i.problem}`).join("; ");
  return { error: "validation_failed", message: `invalid input: ${summary}`, issues };
}

function parse<T extends z.ZodType>(schema: T, raw: unknown): Result<z.infer<T>> {
  const input = raw ?? {};
  const r = schema.safeParse(input, { reportInput: true });
  return r.success ? ok(r.data) : fail(validationFailed(zodToIssues(r.error, input)));
}

const notPermitted = (message: string): ServiceError => ({ error: "not_permitted", message, reason: message });

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const { tasks, handoffs, paths, agent, git } = deps;
  const nowIso = (): string => deps.now().toISOString();

  const guarded = <T>(fn: () => Result<T>): Result<T> => {
    try {
      return fn();
    } catch (err) {
      if (isBusy(err)) {
        return fail({ error: "db_busy", message: "the handproof database is busy; retry the call", retryable: true });
      }
      if (isHandoffsError(err)) return fail({ error: err.code, message: err.message });
      throw err;
    }
  };

  /** Writes `next` if the task is still in `expect`; a lost race reports the state it moved to. */
  const save = (prev: Task, next: Task, ev: NewTaskEvent): Result<Task> => {
    if (tasks.transition(prev.id, prev.status, next, ev)) return ok(next);
    const now = tasks.get(prev.id);
    return fail({
      error: "invalid_transition",
      message: `the task moved to ${now?.status ?? "?"} while this call ran; read it again`,
      reason: "concurrent update",
    });
  };

  const fileIssue = (field: string, value: string): Issue | null => {
    const abs = isAbsolute(value) ? value : join(paths.worktreeRoot, value);
    return existsSync(abs)
      ? null
      : { path: field, problem: `file not found: ${value}`, fix: "write the file first, or give its absolute path" };
  };

  /** Rules beyond the payload's shape; returns the task to store or an error. */
  const applyLeadRules = (t: Task, move: LeadMove, payload: unknown, at: string): Result<Task> => {
    const next: Task = { ...t, status: move.split(">")[1] as TaskStatus, updatedAt: at };
    switch (move) {
      case "new>planning":
        if (t.risk !== "low") return fail(notPermitted("only a low-risk task may skip research"));
        break;
      case "researching>planning": {
        const issue = fileIssue("research_file", (payload as Payload<"researching>planning">).research_file);
        if (issue !== null) return fail(validationFailed([issue]));
        break;
      }
      case "planning>awaiting_plan_approval": {
        const issue = fileIssue("plan_file", (payload as Payload<"planning>awaiting_plan_approval">).plan_file);
        if (issue !== null) return fail(validationFailed([issue]));
        break;
      }
      case "verifying>building": {
        const r = payload as Payload<"verifying>building">;
        const work = r.tests.failed + r.blocking.length + r.security.length + r.wrong_tests.length;
        if (work === 0) {
          return fail(
            validationFailed([
              {
                path: "",
                problem: "nothing to fix: 0 failed tests and no blocking, security or wrong-test items",
                fix: "move to awaiting_human_review (or done) instead, or list what needs fixing",
              },
            ]),
          );
        }
        if (t.rounds.used >= t.rounds.limit) {
          return fail({
            error: "round_limit",
            message: `all ${t.rounds.limit} fix rounds are used; move the task to blocked and ask the human`,
            rounds: t.rounds,
          });
        }
        const severe = r.security.some((s) => s.severity === "CRITICAL" || s.severity === "HIGH");
        next.rounds = { ...t.rounds, used: t.rounds.used + 1 };
        next.flags = { severeEver: t.flags.severeEver || severe };
        break;
      }
      case "verifying>done": {
        const r = payload as Payload<"verifying>done">;
        if (t.risk !== "low") return fail(notPermitted("only a low-risk task may skip the human review"));
        if (t.flags.severeEver) {
          return fail(notPermitted("a CRITICAL/HIGH finding was raised on this task; it needs the human review"));
        }
        if (r.unverified.length > 0) {
          return fail(notPermitted("UNVERIFIED findings are open; they need the human review"));
        }
        break;
      }
      default:
        break;
    }
    return ok(next);
  };

  const humanAct = (id: string, action: HumanAction, raw: unknown): Result<Task> =>
    guarded(() => {
      const t = tasks.get(id);
      if (t === null) return fail(notFound(id));
      if (!isHuman(agent)) {
        return fail(notPermitted(`only a human may ${action} a task (agent ${agent.name} is not human)`));
      }
      const m = humanMove(t.status, action);
      if (!m.ok) return fail({ error: m.code, message: m.reason, reason: m.reason });
      const at = nowIso();
      const next: Task = { ...t, status: m.to, updatedAt: at };
      const data: Record<string, unknown> = { from: t.status, to: m.to };

      if (action === "cancel") {
        const input = parse(CancelInput, raw);
        if (!input.ok) return input;
        const secrets = secretError(scanSecrets(input.value.reason, ["reason"]));
        if (secrets !== null) return fail(secrets);
        return save(t, next, { at, actor: agent.name, type: "cancelled", data: { ...data, reason: input.value.reason } });
      }

      if (action === "reject") {
        const input = parse(RejectInput, raw);
        if (!input.ok) return input;
        const secrets = secretError(scanSecrets(input.value.comment, ["comment"]));
        if (secrets !== null) return fail(secrets);
        return save(t, next, { at, actor: agent.name, type: "rejected", data: { ...data, comment: input.value.comment } });
      }

      const input = parse(ApproveInput, raw);
      if (!input.ok) return input;
      const { comment, rounds } = input.value;
      if (rounds !== undefined && t.status !== "blocked") {
        return fail(
          validationFailed([{ path: "rounds", problem: `rounds only applies to a blocked task (this one is ${t.status})`, fix: "drop --rounds" }]),
        );
      }
      if (comment !== undefined) {
        const secrets = secretError(scanSecrets(comment, ["comment"]));
        if (secrets !== null) return fail(secrets);
      }
      if (comment !== undefined) data.comment = comment;
      if (t.status === "awaiting_plan_approval") {
        next.planCommit = git.head();
        next.rounds = { used: 0, limit: DEFAULT_ROUNDS };
        data.planCommit = next.planCommit;
      } else if (t.status === "blocked") {
        const more = rounds ?? DEFAULT_ROUNDS;
        next.rounds = { ...t.rounds, limit: t.rounds.limit + more };
        data.rounds = more;
      }
      return save(t, next, { at, actor: agent.name, type: "approved", data });
    });

  return {
    create(raw) {
      return guarded(() => {
        const input = parse(TaskInput, raw);
        if (!input.ok) return input;
        const secrets = secretError(scanSecrets(input.value.goal, ["goal"]));
        if (secrets !== null) return fail(secrets);
        const at = nowIso();
        const t: Task = {
          ...input.value,
          id: newTaskId(),
          schemaVersion: 1,
          status: "new",
          from: agent,
          repo: { root: paths.root, worktree: paths.worktreeRoot, branch: git.branch() },
          rounds: { used: 0, limit: DEFAULT_ROUNDS },
          flags: { severeEver: false },
          planCommit: null,
          createdAt: at,
          updatedAt: at,
        };
        tasks.insert(t, { at, actor: agent.name, type: "created", data: { goal: t.goal, risk: t.risk } });
        return ok(t);
      });
    },

    transition(id, to, payload) {
      return guarded(() => {
        const t = tasks.get(id);
        if (t === null) return fail(notFound(id));
        if (t.from.name !== agent.name) {
          return fail(notPermitted(`only the task's creator (${t.from.name}) may move it`));
        }
        const target = TaskStatus.safeParse(to);
        if (!target.success) {
          return fail(validationFailed([{ path: "to", problem: `unknown status '${to}'`, fix: `use one of: ${leadTargets(t.status).join(", ") || "(none: waiting on a human)"}` }]));
        }
        const m = leadMove(t.status, target.data);
        if (!m.ok) return fail({ error: m.code, message: m.reason, reason: m.reason, allowed: m.allowed });
        const parsed = parse(PAYLOADS[m.move], payload);
        if (!parsed.ok) return parsed;
        const secrets = secretError(scanSecrets(parsed.value, ["payload"]));
        if (secrets !== null) return fail(secrets);
        const at = nowIso();
        const next = applyLeadRules(t, m.move, parsed.value, at);
        if (!next.ok) return next;
        const saved = save(t, next.value, {
          at,
          actor: agent.name,
          type: "moved",
          data: { from: t.status, to: next.value.status, payload: parsed.value },
        });
        if (!saved.ok) return saved;
        const s = saved.value.status;
        return ok({ task: saved.value, next: leadTargets(s), waitingOnHuman: isGate(s) });
      });
    },

    get(id) {
      return guarded(() => {
        const task = tasks.get(id);
        if (task === null) return fail(notFound(id));
        const linked = handoffs.list({ task: id, limit: 200 }).map(toSummary);
        return ok({ task, events: tasks.events(id), handoffs: linked });
      });
    },

    list(f) {
      return guarded(() => ok(tasks.list({ status: f.status ?? UNFINISHED, ...(f.limit !== undefined ? { limit: f.limit } : {}) }).map(toTaskSummary)));
    },

    approve: (id, raw) => humanAct(id, "approve", raw),
    reject: (id, raw) => humanAct(id, "reject", raw),
    cancel: (id, raw) => humanAct(id, "cancel", raw),
  };
}
