import type { Config, RepoPaths } from "../config.ts";
import { isHandoffsError } from "../errors.ts";
import type { GitInfo } from "../git.ts";
import { newHandoffId } from "../ids.ts";
import type { Issue } from "../schema/errors.ts";
import type { AgentRef, Handoff, Kind, Priority, Status } from "../schema/handoff.ts";
import { parseHandoffInput } from "../schema/rules.ts";
import { isBusy } from "../store/db.ts";
import type { HandoffEvent, HandoffRepo, NewEvent } from "../store/repo.ts";
import { transition } from "./lifecycle.ts";
import { rolesFor } from "./roles.ts";

export type ServiceError = { error: string; message: string; [k: string]: unknown };
export type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

export interface HandoffSummary {
  id: string;
  title: string;
  kind: Kind;
  status: Status;
  priority: Priority;
  to: string;
  from: string;
  claimBy: string | null;
  leaseUntil: string | null;
  createdAt: string;
}

export interface ServiceDeps {
  repo: HandoffRepo;
  config: Config;
  paths: RepoPaths;
  agent: AgentRef;
  now: () => Date;
  git: GitInfo;
}

export interface ListOptions {
  status?: Status[];
  kind?: Kind;
  to?: string;
  mine?: boolean;
  limit?: number;
}

export interface HandoffService {
  create(raw: unknown): Result<{ handoff: Handoff; warnings: Issue[] }>;
  list(f?: ListOptions): Result<HandoffSummary[]>;
  get(id: string): Result<{ handoff: Handoff; events: HandoffEvent[] }>;
  claim(id?: string): Result<Handoff>;
  update(id: string, note: string): Result<Handoff>;
  release(id: string, reason: string): Result<Handoff>;
  cancel(id: string, reason?: string): Result<Handoff>;
  /** Open handoffs addressed to this agent or "any", in claim order (for the inbox resource). */
  inbox(): Result<Handoff[]>;
}

export function toSummary(h: Handoff): HandoffSummary {
  return {
    id: h.id,
    title: h.title,
    kind: h.kind,
    status: h.status,
    priority: h.priority,
    to: h.to,
    from: h.from.name,
    claimBy: h.claim?.by.name ?? null,
    leaseUntil: h.claim?.leaseUntil ?? null,
    createdAt: h.createdAt,
  };
}

export const NOTE_MAX = 2000;
export const REASON_MAX = 500;
const DEFAULT_LIST_STATUSES: Status[] = ["open", "claimed", "submitted", "changes_requested", "verified"];
/** Retries after a lost compare-and-set before giving up with db_busy. */
const CAS_ATTEMPTS = 3;

type ClaimantAction = "update" | "release" | "cancel";
const EVENT_FOR: Record<ClaimantAction, NewEvent["type"]> = {
  update: "updated",
  release: "released",
  cancel: "cancelled",
};

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: ServiceError): Result<T> => ({ ok: false, error });

function notFound(id: string): ServiceError {
  return { error: "not_found", message: `no handoff with id ${id}`, id };
}

function dbBusy(): ServiceError {
  return { error: "db_busy", message: "the handoffs database is busy; retry the call", retryable: true };
}

function textIssue(path: string, value: unknown, max: number): Issue | null {
  if (typeof value !== "string") {
    return value === undefined
      ? { path, problem: "required", fix: "add this field" }
      : { path, problem: `expected string, got ${value === null ? "null" : typeof value}`, fix: "use a string" };
  }
  if (value.trim().length === 0) return { path, problem: "too short (0 chars, min 1)", fix: `use 1–${max} chars` };
  if (value.length > max) return { path, problem: `too long (${value.length} chars, max ${max})`, fix: `shorten to ${max} chars` };
  return null;
}

function validationFailed(issues: Issue[]): ServiceError {
  const summary = issues.map((i) => `${i.path === "" ? "(root)" : i.path}: ${i.problem}`).join("; ");
  return { error: "validation_failed", message: `invalid input: ${summary}`, issues };
}

export function createHandoffService(deps: ServiceDeps): HandoffService {
  const { repo, config, paths, agent, git } = deps;
  const leaseMs = config.leaseMinutes * 60_000;

  const nowIso = (): string => deps.now().toISOString();
  const leaseFrom = (iso: string): string => new Date(Date.parse(iso) + leaseMs).toISOString();

  /** Lazy lease expiry, then renewal of this agent's live leases (decision 5). */
  const tick = (): string => {
    const at = nowIso();
    repo.expireLeases(at);
    repo.renewLeases(agent.name, leaseFrom(at), at);
    return at;
  };

  /** Runs `fn` after the tick; maps busy and coded errors to a ServiceError. */
  const guarded = <T>(fn: (at: string) => Result<T>): Result<T> => {
    try {
      return fn(tick());
    } catch (err) {
      if (isBusy(err)) return fail(dbBusy());
      if (isHandoffsError(err)) {
        const extra = err.details !== null && typeof err.details === "object" ? (err.details as Record<string, unknown>) : {};
        return fail({ ...extra, error: err.code, message: err.message });
      }
      throw err;
    }
  };

  /** True when the agent lost this (now open) handoff to lease expiry. */
  const lostToExpiry = (h: Handoff): boolean => {
    if (h.status !== "open") return false;
    const last = repo.events(h.id).at(-1);
    return last?.type === "lease_expired" && last.data.previous === agent.name;
  };

  /**
   * Shared path for update/release/cancel: lifecycle check, CAS write, re-read on a lost race.
   * `makeClaim` builds the new claim from the current row.
   */
  const applyTransition = (
    id: string,
    action: ClaimantAction,
    at: string,
    makeClaim: (h: Handoff) => Handoff["claim"],
    data: Record<string, unknown>,
  ): Result<Handoff> => {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const h = repo.get(id);
      if (h === null) return fail(notFound(id));
      const t = transition(h.status, action, rolesFor(agent, h));
      if (!t.ok) {
        if ((action === "update" || action === "release") && lostToExpiry(h)) {
          return fail({
            error: "lease_expired",
            message: `your lease on ${id} expired and the handoff was reopened; claim it again to continue`,
            id,
          });
        }
        return fail({ error: t.code, message: t.reason, reason: t.reason });
      }
      const claim = makeClaim(h);
      const ev: NewEvent = {
        at,
        actor: agent.name,
        type: EVENT_FOR[action],
        data,
      };
      const expect = h.claim === null ? { status: h.status } : { status: h.status, claimBy: h.claim.by.name };
      if (repo.transitionState(id, expect, { status: t.to, claim, updatedAt: at }, ev)) {
        const after = repo.get(id);
        return after === null ? fail(notFound(id)) : ok(after);
      }
      // Lost the compare-and-set: loop re-reads and reports what the new state allows.
    }
    return fail(dbBusy());
  };

  const alreadyClaimed = (id: string, by: string): ServiceError => ({
    error: "already_claimed",
    message: `${id} is already claimed by ${by}`,
    id,
    by,
  });

  return {
    create(raw) {
      return guarded((at) => {
        const parsed = parseHandoffInput(raw, { config, repoRoot: paths.worktreeRoot });
        if (!parsed.ok) return fail(validationFailed(parsed.failure.issues));
        const head = git.head();
        if (head === null) {
          return fail({ error: "no_commits", message: "the repository has no commits; commit once before creating a handoff" });
        }
        const handoff: Handoff = {
          ...parsed.value,
          id: newHandoffId(),
          schemaVersion: 1,
          status: "open",
          from: agent,
          repo: { root: paths.root, branch: git.branch(), baseCommit: head },
          claim: null,
          result: null,
          createdAt: at,
          updatedAt: at,
        };
        repo.insert(handoff, {
          at,
          actor: agent.name,
          type: "created",
          data: { title: handoff.title, kind: handoff.kind, to: handoff.to },
        });
        return ok({ handoff, warnings: parsed.warnings });
      });
    },

    list(f = {}) {
      return guarded(() => {
        const rows = repo.list({
          status: f.status ?? DEFAULT_LIST_STATUSES,
          ...(f.kind !== undefined ? { kind: f.kind } : {}),
          ...(f.to !== undefined ? { to: f.to } : {}),
          ...(f.mine === true ? { involving: agent.name } : {}),
          ...(f.limit !== undefined ? { limit: f.limit } : {}),
        });
        return ok(rows.map(toSummary));
      });
    },

    get(id) {
      return guarded(() => {
        const handoff = repo.get(id);
        if (handoff === null) return fail(notFound(id));
        return ok({ handoff, events: repo.events(id) });
      });
    },

    claim(id) {
      return guarded((at) => {
        const leaseUntil = leaseFrom(at);
        if (id === undefined) {
          for (const c of repo.claimCandidates(agent.name)) {
            if (repo.tryClaim(c.id, agent, leaseUntil, at)) {
              const won = repo.get(c.id);
              if (won !== null) return ok(won);
            }
          }
          return fail({ error: "nothing_to_claim", message: `no open handoffs addressed to ${agent.name} or any` });
        }

        const h = repo.get(id);
        if (h === null) return fail(notFound(id));
        const roles = rolesFor(agent, h);
        if (h.to !== agent.name && h.to !== "any" && !roles.has("human")) {
          return fail({
            error: "not_addressed_to_you",
            message: `${id} is addressed to ${h.to}, not ${agent.name}`,
            id,
            to: h.to,
          });
        }
        if ((h.status === "claimed" || h.status === "changes_requested") && h.claim !== null) {
          return h.claim.by.name === agent.name ? ok(h) : fail(alreadyClaimed(id, h.claim.by.name));
        }
        const t = transition(h.status, "claim", roles);
        if (!t.ok) return fail({ error: t.code, message: t.reason, reason: t.reason });

        if (repo.tryClaim(id, agent, leaseUntil, at)) {
          const won = repo.get(id);
          return won === null ? fail(notFound(id)) : ok(won);
        }
        const now = repo.get(id);
        if (now === null) return fail(notFound(id));
        if (now.claim !== null && now.claim.by.name !== agent.name) return fail(alreadyClaimed(id, now.claim.by.name));
        const after = transition(now.status, "claim", rolesFor(agent, now));
        return fail(after.ok ? dbBusy() : { error: after.code, message: after.reason, reason: after.reason });
      });
    },

    update(id, note) {
      const issue = textIssue("note", note, NOTE_MAX);
      if (issue !== null) return fail(validationFailed([issue]));
      return guarded((at) => {
        const leaseUntil = leaseFrom(at);
        return applyTransition(
          id,
          "update",
          at,
          (h) => (h.claim === null ? null : { ...h.claim, leaseUntil }),
          { note, leaseUntil },
        );
      });
    },

    release(id, reason) {
      const issue = textIssue("reason", reason, REASON_MAX);
      if (issue !== null) return fail(validationFailed([issue]));
      return guarded((at) => applyTransition(id, "release", at, () => null, { reason }));
    },

    inbox() {
      return guarded(() => ok(repo.claimCandidates(agent.name)));
    },

    cancel(id, reason) {
      if (reason !== undefined) {
        const issue = textIssue("reason", reason, REASON_MAX);
        if (issue !== null) return fail(validationFailed([issue]));
      }
      return guarded((at) =>
        applyTransition(id, "cancel", at, () => null, reason === undefined ? {} : { reason }),
      );
    },
  };
}
