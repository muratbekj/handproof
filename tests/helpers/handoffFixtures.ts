import type { AgentRef, Handoff, Priority, Status } from "../../src/schema/handoff";
import { newHandoffId } from "../../src/ids";
import fullHandoffFixture from "../fixtures/handoffs/full-handoff.json";

const BASE_TIME = "2026-11-03T12:00:00.000Z";

export function fixtureHandoff(overrides: Partial<Handoff> = {}): Handoff {
  const id = overrides.id ?? newHandoffId();
  const createdAt = overrides.createdAt ?? BASE_TIME;
  return {
    ...(fullHandoffFixture as Handoff),
    id,
    status: overrides.status ?? "open",
    claim: overrides.claim ?? null,
    result: overrides.result ?? null,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    ...overrides,
  };
}

export function openHandoffRow(
  opts: {
    to?: string;
    priority?: Priority;
    createdAt?: string;
    from?: AgentRef;
    title?: string;
  } = {},
): Handoff {
  const createdAt = opts.createdAt ?? BASE_TIME;
  return fixtureHandoff({
    to: opts.to ?? "any",
    priority: opts.priority ?? "normal",
    createdAt,
    updatedAt: createdAt,
    from: opts.from ?? { name: "planner", harness: "claude-code" },
    title: opts.title ?? "Fixture handoff title here",
  });
}

export function claimedHandoff(
  by: AgentRef,
  leaseUntil: string,
  status: Status = "claimed",
): Partial<Handoff> {
  return {
    status,
    claim: { by, leaseUntil },
  };
}
