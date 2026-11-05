import { HandoffsError } from "../errors.ts";
import type { Status } from "../schema/handoff.ts";
import type { Result } from "./handoffs.ts";

export interface StatusReader {
  /** Runs the lazy lease tick, then reads the statuses; not_found for an unknown id. */
  statuses(ids: string[]): Result<Record<string, Status>>;
}

export interface WaitOptions {
  /** Return when any status is in this set; omitted → when any status differs from its start. */
  until?: readonly Status[];
  /** Give up after this many ms (measured with `now`); omitted → wait forever. */
  timeoutMs?: number;
  /** Poll interval; default 1000. */
  intervalMs?: number;
}

export interface WaitDeps {
  service: StatusReader;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export interface WaitHit {
  id: string;
  status: Status;
  /** Only on a timeout: every id is returned with its last status. */
  timedOut?: true;
}

export const POLL_INTERVAL_MS = 1000;

/** `<N>s|m|h` with N ≥ 1 → ms; anything else → null. */
export function parseTimeout(text: string): number | null {
  const m = /^([1-9][0-9]*)(s|m|h)$/.exec(text);
  if (m === null || m[1] === undefined) return null;
  const n = Number(m[1]);
  const unit = m[2] === "s" ? 1000 : m[2] === "m" ? 60_000 : 3_600_000;
  return Number.isSafeInteger(n * unit) ? n * unit : null;
}

/**
 * Polls `service.statuses` until a handoff meets the condition (or the timeout passes). `db_busy`
 * is transient and retried on the next poll; any other error is thrown as a HandoffsError.
 */
export async function waitForStatus(ids: readonly string[], opts: WaitOptions, deps: WaitDeps): Promise<WaitHit[]> {
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
  const start = deps.now().getTime();
  const timedOut = (): boolean => opts.timeoutMs !== undefined && deps.now().getTime() - start >= opts.timeoutMs;
  const list = [...new Set(ids)];

  /** null = busy this time. */
  const read = (): Record<string, Status> | null => {
    const r = deps.service.statuses(list);
    if (r.ok) return r.value;
    if (r.error.error === "db_busy") return null;
    const { error, message, ...details } = r.error;
    throw new HandoffsError(error, message, details);
  };

  let initial = read();
  while (initial === null) {
    if (timedOut()) throw new HandoffsError("db_busy", "the handproof database stayed busy until the timeout");
    await deps.sleep(interval);
    initial = read();
  }
  const startStatus = initial;
  const until = opts.until === undefined ? null : new Set<Status>(opts.until);
  const hits = (now: Record<string, Status>): WaitHit[] =>
    list.flatMap((id) => {
      const s = now[id];
      if (s === undefined) return [];
      const met = until === null ? s !== startStatus[id] : until.has(s);
      return met ? [{ id, status: s }] : [];
    });

  let last = startStatus;
  if (until !== null) {
    const now = hits(last);
    if (now.length > 0) return now;
  }
  for (;;) {
    if (timedOut()) return list.map((id) => ({ id, status: last[id] ?? startStatus[id] ?? "open", timedOut: true }));
    await deps.sleep(interval);
    const cur = read();
    if (cur === null) continue;
    last = cur;
    const now = hits(cur);
    if (now.length > 0) return now;
  }
}
