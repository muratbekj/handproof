import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  Action,
  TRANSITIONS,
  allowedActions,
  transition,
  type Role,
} from "../src/service/lifecycle";

const STATUSES = [
  "open",
  "claimed",
  "submitted",
  "changes_requested",
  "verified",
  "done",
  "cancelled",
] as const;

type TestStatus = (typeof STATUSES)[number];
type TestAction = (typeof Action.options)[number];

interface ExpectedTransition {
  from: TestStatus;
  action: TestAction;
  to: TestStatus;
  who: readonly Role[];
}

const TABLE: readonly ExpectedTransition[] = [
  { from: "open", action: "claim", to: "claimed", who: ["any"] },
  { from: "open", action: "cancel", to: "cancelled", who: ["creator", "human"] },
  { from: "claimed", action: "update", to: "claimed", who: ["claimant"] },
  { from: "claimed", action: "release", to: "open", who: ["claimant"] },
  { from: "claimed", action: "submit", to: "submitted", who: ["claimant"] },
  { from: "claimed", action: "expire", to: "open", who: ["system"] },
  {
    from: "changes_requested",
    action: "update",
    to: "changes_requested",
    who: ["claimant"],
  },
  {
    from: "changes_requested",
    action: "release",
    to: "open",
    who: ["claimant"],
  },
  {
    from: "changes_requested",
    action: "submit",
    to: "submitted",
    who: ["claimant"],
  },
  {
    from: "changes_requested",
    action: "expire",
    to: "open",
    who: ["system"],
  },
  {
    from: "submitted",
    action: "verify_pass",
    to: "verified",
    who: ["system"],
  },
  {
    from: "submitted",
    action: "verify_fail",
    to: "changes_requested",
    who: ["system"],
  },
  { from: "verified", action: "accept", to: "done", who: ["creator", "human"] },
  { from: "verified", action: "reject", to: "open", who: ["creator", "human"] },
];

function roles(...values: Role[]): ReadonlySet<Role> {
  return new Set(values);
}

const ALL_ROLES = roles("any", "creator", "claimant", "human", "system");

describe("transition", () => {
  test("every table row succeeds for each role listed for it", () => {
    for (const row of TABLE) {
      for (const role of row.who) {
        expect(transition(row.from, row.action, roles(role))).toEqual({
          ok: true,
          to: row.to,
        });
      }
    }
  });

  test("a row with who any accepts every caller", () => {
    for (const row of TABLE) {
      if (!row.who.includes("any")) continue;
      for (const role of ALL_ROLES) {
        expect(transition(row.from, row.action, roles(role))).toEqual({
          ok: true,
          to: row.to,
        });
      }
    }
  });

  test("every pair not in the table is invalid_transition with the exact reason", () => {
    const known = new Set(
      TABLE.map((row) => `${row.from}:${row.action}`),
    );

    for (const from of STATUSES) {
      for (const action of Action.options) {
        if (known.has(`${from}:${action}`)) continue;

        expect(transition(from, action, ALL_ROLES)).toEqual({
          ok: false,
          code: "invalid_transition",
          reason: `cannot ${action} a handoff that is ${from}`,
        });
      }
    }
  });

  test("a known transition rejects an unpermitted role", () => {
    expect(transition("verified", "accept", roles("claimant"))).toEqual({
      ok: false,
      code: "not_permitted",
      reason: "only the creator or human may accept",
    });

    expect(transition("claimed", "expire", roles("claimant"))).toEqual({
      ok: false,
      code: "not_permitted",
      reason: "only the system may expire",
    });
  });

  test("open can be claimed", () => {
    expect(transition("open", "claim", roles("any"))).toEqual({
      ok: true,
      to: "claimed",
    });
  });

  test("only verified can reach done", () => {
    const doneRows = TRANSITIONS.filter((row) => row.to === "done");
    expect(doneRows.length).toBeGreaterThan(0);
    for (const row of doneRows) {
      expect(row.from).toBe("verified");
    }
  });

  test("TRANSITIONS matches the lifecycle table", () => {
    expect(TRANSITIONS).toHaveLength(TABLE.length);

    for (const expected of TABLE) {
      const actual = TRANSITIONS.find(
        (row) => row.from === expected.from && row.action === expected.action,
      );
      expect(actual).toEqual(expected);
    }
  });
});

describe("allowedActions", () => {
  test("returns the actions for a status in table order", () => {
    expect(allowedActions("claimed", roles("claimant"))).toEqual([
      "update",
      "release",
      "submit",
    ]);
  });

  test("returns no actions for a terminal status", () => {
    expect(allowedActions("done", ALL_ROLES)).toEqual([]);
    expect(allowedActions("cancelled", ALL_ROLES)).toEqual([]);
  });
});

describe("purity", () => {
  test("lifecycle.ts imports nothing from store/ or Node built-ins", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "..", "src", "service", "lifecycle.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["'][^"']*store(?:\/|["'])/);
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/import\s*\(\s*["']node:/);
    expect(source).not.toMatch(/\brequire\s*\(\s*["']node:/);
  });
});
