import { type Config, type RepoPaths, loadConfig } from "../config.ts";
import { isHandoffsError } from "../errors.ts";
import type { GitInfo } from "../git.ts";
import { newHandoffId } from "../ids.ts";
import * as z from "zod/v4";
import { type Issue, zodToIssues } from "../schema/errors.ts";
import type { AgentRef, Handoff, Kind, Priority, Status } from "../schema/handoff.ts";
import { parseHandoffInput } from "../schema/rules.ts";
import { isBusy } from "../store/db.ts";
import type { HandoffEvent, HandoffRepo, NewEvent, StatePatch } from "../store/repo.ts";
import { transition } from "./lifecycle.ts";
import { type PruneOptions, type PruneReport, pruneLogs } from "./prune.ts";
import { rolesFor } from "./roles.ts";
import { snapshotDirty } from "../verify/scope.ts";
import { scanSecrets, secretError } from "../verify/secrets.ts";
import { type Verification, checksTimeoutSec, verifyHandoff } from "../verify/verify.ts";

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

export const SUMMARY_MAX = 4000;
export const COMMITS_MAX = 50;

/** Structure of a submit request; acceptance coverage is checked against the handoff separately. */
export const SubmitInputSchema = z.object({
  summary: z.string().describe(`What you did (1–${SUMMARY_MAX} chars)`),
  commits: z.array(z.string()).max(COMMITS_MAX).optional().describe(`Commit shas (at most ${COMMITS_MAX})`),
  criteria: z
    .array(
      z.object({
        id: z.string().describe("Acceptance criterion id, e.g. ac1"),
        met: z.boolean(),
        note: z.string().max(2000).optional(),
      }),
    )
    .describe("One self-report per acceptance criterion, each id exactly once"),
});
export type SubmitInput = z.infer<typeof SubmitInputSchema>;

export type ReviewDecision = "accept" | "reject";

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
  /** Event timeline, seq ASC; no tick; [] for unknown ids. */
  history(id: string): HandoffEvent[];
  /** Claimant only: records the result, runs verification, ends verified or changes_requested. */
  submit(id: string, input: unknown): Promise<Result<{ handoff: Handoff; verification: Verification }>>;
  /** Re-runs verification on demand; logs a `verification` event and never changes status. */
  verify(id: string): Promise<Result<{ verification: Verification }>>;
  /** Creator or human, from verified: accept → done, reject → open with the attempt in context.tried. */
  review(id: string, decision: ReviewDecision, reason?: string): Result<Handoff>;
}

/** CLI-only operations (no MCP tool exposes them); `createHandoffService` returns both. */
export interface HandoffAdmin {
  /** Lease/verification expiry (no renewal), then each id's status; not_found for an unknown id. */
  statuses(ids: string[]): Result<Record<string, Status>>;
  /** Deletes old check logs of done/cancelled handoffs (see prune.ts). */
  prune(opts: PruneOptions): Result<PruneReport>;
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
  return { error: "db_busy", message: "the handproof database is busy; retry the call", retryable: true };
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

/** Agent-written text fields of a create request, scanned on the raw input before anything is stored. */
const SCANNED_CREATE_FIELDS = ["title", "goal", "context", "constraints", "acceptance"] as const;

function scanCreateInput(raw: unknown) {
  if (raw === null || typeof raw !== "object") return [];
  const rec = raw as Record<string, unknown>;
  return SCANNED_CREATE_FIELDS.flatMap((f) => scanSecrets(rec[f], [f]));
}

export function createHandoffService(deps: ServiceDeps): HandoffService & HandoffAdmin {
  const { repo, config, paths, agent, git } = deps;
  const leaseMs = config.leaseMinutes * 60_000;

  const nowIso = (): string => deps.now().toISOString();
  const leaseFrom = (iso: string): string => new Date(Date.parse(iso) + leaseMs).toISOString();

  /** Lazy lease expiry, interrupted verifications, then renewal of this agent's live leases (decision 5). */
  const tick = (): string => {
    const at = nowIso();
    repo.expireLeases(at);
    repo.expireVerifications(at, leaseFrom(at));
    repo.renewLeases(agent.name, leaseFrom(at), at);
    return at;
  };

  /** Expiry only: a reader (wait) must not renew its own leases. */
  const expire = (): void => {
    const at = nowIso();
    repo.expireLeases(at);
    repo.expireVerifications(at, leaseFrom(at));
  };

  /** Busy and coded errors become a failed Result; anything else is rethrown. */
  const caught = <T>(err: unknown): Result<T> => {
    if (isBusy(err)) return fail(dbBusy());
    if (isHandoffsError(err)) {
      const extra = err.details !== null && typeof err.details === "object" ? (err.details as Record<string, unknown>) : {};
      return fail({ ...extra, error: err.code, message: err.message });
    }
    throw err;
  };

  /** Runs `fn` after the tick; maps busy and coded errors to a ServiceError. */
  const guarded = <T>(fn: (at: string) => Result<T>): Result<T> => {
    try {
      return fn(tick());
    } catch (err) {
      return caught(err);
    }
  };

  const guardedAsync = async <T>(fn: (at: string) => Promise<Result<T>>): Promise<Result<T>> => {
    try {
      return await fn(tick());
    } catch (err) {
      return caught(err);
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
    inputError: ServiceError | null,
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
      // Input is judged after the tick and the state check, so a lapsed lease reports lease_expired.
      if (inputError !== null) return fail(inputError);
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

  const expectOf = (h: Handoff): { status: Status; claimBy?: string } =>
    h.claim === null ? { status: h.status } : { status: h.status, claimBy: h.claim.by.name };

  const inProgress = (id: string): ServiceError => ({
    error: "verification_in_progress",
    message: `${id} is being verified; wait for the submit to finish`,
    id,
  });

  const runVerification = (h: Handoff): Promise<Verification> =>
    verifyHandoff(h, { paths, now: deps.now, by: agent.name });

  /** Submit input checked against `h`: structure, summary, acceptance coverage, then secrets. */
  const parseSubmit = (h: Handoff, raw: unknown): Result<SubmitInput> => {
    const input = raw ?? {};
    const parsed = SubmitInputSchema.safeParse(input, { reportInput: true });
    const issues: Issue[] = parsed.success ? [] : zodToIssues(parsed.error, input);
    const summary = textIssue("summary", (input as Record<string, unknown>).summary, SUMMARY_MAX);
    if (summary !== null && !issues.some((i) => i.path === "summary")) issues.push(summary);
    if (parsed.success) {
      const ids = new Set(h.acceptance.map((a) => a.id));
      const seen = new Set<string>();
      parsed.data.criteria.forEach((c, i) => {
        if (!ids.has(c.id)) {
          issues.push({
            path: `criteria[${i}].id`,
            problem: `unknown acceptance id '${c.id}'`,
            fix: `use one of: ${[...ids].join(", ")}`,
          });
        } else if (seen.has(c.id)) {
          issues.push({ path: `criteria[${i}].id`, problem: `duplicate acceptance id '${c.id}'`, fix: "report each criterion once" });
        }
        seen.add(c.id);
      });
      const missing = [...ids].filter((a) => !seen.has(a));
      if (missing.length > 0) {
        issues.push({
          path: "criteria",
          problem: `missing criteria for: ${missing.join(", ")}`,
          fix: "report every acceptance criterion exactly once",
        });
      }
    }
    if (issues.length > 0 || !parsed.success) return fail(validationFailed(issues));
    const secrets = secretError([
      ...scanSecrets(parsed.data.summary, ["summary"]),
      ...scanSecrets(parsed.data.criteria, ["criteria"]),
    ]);
    return secrets === null ? ok(parsed.data) : fail(secrets);
  };

  const alreadyClaimed = (id: string, claim: NonNullable<Handoff["claim"]>): ServiceError => ({
    error: "already_claimed",
    message: `${id} is already claimed by ${claim.by.name} until ${claim.leaseUntil}`,
    id,
    by: claim.by.name,
    leaseUntil: claim.leaseUntil,
  });

  return {
    create(raw) {
      return guarded((at) => {
        const secrets = secretError(scanCreateInput(raw));
        if (secrets !== null) return fail(secrets);
        const parsed = parseHandoffInput(raw, { config, repoRoot: paths.worktreeRoot });
        if (!parsed.ok) return fail(validationFailed(parsed.failure.issues));
        const head = git.head();
        if (head === null) {
          return fail({ error: "no_commits", message: "the repository has no commits; commit once before creating a handoff" });
        }
        // Uncommitted work that is already there isn't the implementer's (throws too_many_preexisting_changes).
        const preexisting = snapshotDirty(paths.worktreeRoot);
        const handoff: Handoff = {
          ...parsed.value,
          id: newHandoffId(),
          schemaVersion: 1,
          status: "open",
          from: agent,
          repo: { root: paths.root, branch: git.branch(), baseCommit: head, worktree: paths.worktreeRoot, preexisting },
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
              continue;
            }
            // Lost the race: a same-name process winning is still our claim.
            const now = repo.get(c.id);
            if (now !== null && now.claim?.by.name === agent.name) return ok(now);
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
          return h.claim.by.name === agent.name ? ok(h) : fail(alreadyClaimed(id, h.claim));
        }
        const t = transition(h.status, "claim", roles);
        if (!t.ok) return fail({ error: t.code, message: t.reason, reason: t.reason });

        // A lost tryClaim may be a same-name process winning: that is still our claim (idempotent).
        for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
          if (repo.tryClaim(id, agent, leaseUntil, at)) {
            const won = repo.get(id);
            return won === null ? fail(notFound(id)) : ok(won);
          }
          const now = repo.get(id);
          if (now === null) return fail(notFound(id));
          if ((now.status === "claimed" || now.status === "changes_requested") && now.claim !== null) {
            return now.claim.by.name === agent.name ? ok(now) : fail(alreadyClaimed(id, now.claim));
          }
          if (now.status === "open") continue;
          const after = transition(now.status, "claim", rolesFor(agent, now));
          return fail(after.ok ? dbBusy() : { error: after.code, message: after.reason, reason: after.reason });
        }
        return fail(dbBusy());
      });
    },

    update(id, note) {
      const issue = textIssue("note", note, NOTE_MAX);
      const inputError = issue !== null ? validationFailed([issue]) : secretError(scanSecrets(note, ["note"]));
      return guarded((at) => {
        const leaseUntil = leaseFrom(at);
        return applyTransition(
          id,
          "update",
          at,
          (h) => (h.claim === null ? null : { ...h.claim, leaseUntil }),
          { note, leaseUntil },
          inputError,
        );
      });
    },

    release(id, reason) {
      const issue = textIssue("reason", reason, REASON_MAX);
      return guarded((at) =>
        applyTransition(id, "release", at, () => null, { reason }, issue === null ? null : validationFailed([issue])),
      );
    },

    inbox() {
      return guarded(() => ok(repo.claimCandidates(agent.name)));
    },

    cancel(id, reason) {
      const issue = reason === undefined ? null : textIssue("reason", reason, REASON_MAX);
      return guarded((at) =>
        applyTransition(
          id,
          "cancel",
          at,
          () => null,
          reason === undefined ? {} : { reason },
          issue === null ? null : validationFailed([issue]),
        ),
      );
    },

    history(id) {
      return repo.events(id);
    },

    statuses(ids) {
      try {
        expire();
        const out: Record<string, Status> = {};
        for (const id of ids) {
          const h = repo.get(id);
          if (h === null) return fail(notFound(id));
          out[id] = h.status;
        }
        return ok(out);
      } catch (err) {
        return caught(err);
      }
    },

    prune(opts) {
      try {
        return ok(pruneLogs({ repo, paths, now: deps.now, agent }, opts));
      } catch (err) {
        return caught(err);
      }
    },

    submit(id, raw) {
      return guardedAsync(async (at) => {
        // 1. State, permission and input, then 2. the submitted transaction (CAS, retried on a lost race).
        let submitted: Handoff | null = null;
        for (let attempt = 0; attempt < CAS_ATTEMPTS && submitted === null; attempt++) {
          const h = repo.get(id);
          if (h === null) return fail(notFound(id));
          if (h.status === "submitted") return fail(inProgress(id));
          const t = transition(h.status, "submit", rolesFor(agent, h));
          if (!t.ok) {
            if (lostToExpiry(h)) {
              return fail({
                error: "lease_expired",
                message: `your lease on ${id} expired and the handoff was reopened; claim it again to continue`,
                id,
              });
            }
            return fail({ error: t.code, message: t.reason, reason: t.reason });
          }
          const checked = parseSubmit(h, raw);
          if (!checked.ok) return checked;
          const { summary, criteria } = checked.value;
          const commits = checked.value.commits ?? [];
          // Same on-disk config the verification will load, so the deadline covers its timeouts.
          const timeoutSec = checksTimeoutSec(h, loadConfig(paths));
          const deadline = new Date(Date.parse(at) + (timeoutSec + 60) * 1000).toISOString();
          const next: Handoff = {
            ...h,
            status: t.to,
            claim: h.claim === null ? null : { ...h.claim, leaseUntil: deadline },
            result: { summary, commits, criteria },
            updatedAt: at,
          };
          const ev: NewEvent = { at, actor: agent.name, type: "submitted", data: { summary, commits, deadline } };
          if (repo.transitionState(id, expectOf(h), { status: next.status, claim: next.claim, updatedAt: at, doc: next }, ev)) {
            submitted = next;
          }
        }
        if (submitted === null) return fail(dbBusy());

        // 3. Verification, outside any transaction.
        const me = agent.name;
        let verification: Verification;
        try {
          verification = await runVerification(submitted);
        } catch (err) {
          // Don't leave it stuck until the deadline: hand it back for changes, then report the error.
          const end = nowIso();
          const claim = submitted.claim === null ? null : { ...submitted.claim, leaseUntil: leaseFrom(end) };
          repo.transitionState(
            id,
            { status: "submitted", claimBy: me },
            { status: "changes_requested", claim, updatedAt: end },
            { at: end, actor: "system", type: "verification_interrupted", data: { error: err instanceof Error ? err.message : String(err) } },
          );
          throw err;
        }

        // 4. Outcome transaction, compare-and-set on submitted + this claimant.
        const end = nowIso();
        const outcome = transition("submitted", verification.passed ? "verify_pass" : "verify_fail", new Set(["system"]));
        if (!outcome.ok) throw new Error(outcome.reason);
        const claim = submitted.claim === null ? null : { ...submitted.claim, leaseUntil: leaseFrom(end) };
        const won = repo.transitionState(
          id,
          { status: "submitted", claimBy: me },
          { status: outcome.to, claim, updatedAt: end },
          { at: end, actor: "system", type: verification.passed ? "verified" : "changes_requested", data: { verification } },
        );
        if (!won) {
          return fail({
            error: "verification_interrupted",
            message: `${id} was no longer submitted when verification finished (its deadline passed); submit again`,
            id,
          });
        }
        const after = repo.get(id);
        return after === null ? fail(notFound(id)) : ok({ handoff: after, verification });
      });
    },

    verify(id) {
      return guardedAsync(async (at) => {
        const h = repo.get(id);
        if (h === null) return fail(notFound(id));
        if (h.status === "submitted") return fail(inProgress(id));
        if (h.status !== "claimed" && h.status !== "changes_requested" && h.status !== "verified") {
          const reason = `cannot verify a handoff that is ${h.status}`;
          return fail({ error: "invalid_transition", message: reason, reason });
        }
        const roles = rolesFor(agent, h);
        if (!roles.has("claimant") && !roles.has("creator") && !roles.has("human")) {
          const reason = "only the claimant or creator or human may verify";
          return fail({ error: "not_permitted", message: reason, reason });
        }
        const verification = await runVerification(h);
        repo.appendEvent(id, { at: nowIso(), actor: agent.name, type: "verification", data: { verification, requestedAt: at } });
        return ok({ verification });
      });
    },

    review(id, decision, reason) {
      return guarded((at) => {
        for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
          const h = repo.get(id);
          if (h === null) return fail(notFound(id));
          if (h.status === "submitted") return fail(inProgress(id));
          const t = transition(h.status, decision, rolesFor(agent, h));
          if (!t.ok) return fail({ error: t.code, message: t.reason, reason: t.reason });
          if (reason !== undefined || decision === "reject") {
            const issue = textIssue("reason", reason, REASON_MAX);
            if (issue !== null) return fail(validationFailed([issue]));
            const secrets = secretError(scanSecrets(reason, ["reason"]));
            if (secrets !== null) return fail(secrets);
          }
          let patch: StatePatch;
          let ev: NewEvent;
          if (decision === "accept") {
            patch = { status: t.to, claim: h.claim, updatedAt: at };
            ev = { at, actor: agent.name, type: "accepted", data: reason === undefined ? {} : { reason } };
          } else {
            const why = reason ?? "";
            const doc: Handoff = {
              ...h,
              status: t.to,
              claim: null,
              result: null,
              context: {
                ...h.context,
                tried: [...h.context.tried, { approach: h.result?.summary ?? "", outcome: `rejected: ${why}` }],
              },
              updatedAt: at,
            };
            patch = { status: t.to, claim: null, updatedAt: at, doc };
            ev = { at, actor: agent.name, type: "rejected", data: { reason: why } };
          }
          if (repo.transitionState(id, expectOf(h), patch, ev)) {
            const after = repo.get(id);
            return after === null ? fail(notFound(id)) : ok(after);
          }
        }
        return fail(dbBusy());
      });
    },
  };
}
