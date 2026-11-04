import { decodeTime, monotonicFactory } from "ulid";
import { HandoffsError } from "./errors.ts";

const nextUlid = monotonicFactory();

export const HANDOFF_ID_RE = /^h_[0-9A-HJKMNP-TV-Z]{26}$/;

/** `h_` + a monotonic ULID; strictly increasing within this process. */
export function newHandoffId(): string {
  return `h_${nextUlid()}`;
}

/** Creation time (ms since epoch) encoded in a handoff id. Throws not_found on a malformed id. */
export function handoffIdTime(id: string): number {
  if (!HANDOFF_ID_RE.test(id)) {
    throw new HandoffsError("not_found", `no handoff with id ${id}`, { id });
  }
  try {
    return decodeTime(id.slice(2));
  } catch {
    throw new HandoffsError("not_found", `no handoff with id ${id}`, { id });
  }
}
