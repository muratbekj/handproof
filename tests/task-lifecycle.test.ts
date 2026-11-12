import { describe, expect, test } from "bun:test";
import { TaskStatus } from "../src/schema/task";
import { TASK_MOVES, humanMove, isGate, leadMove, leadTargets } from "../src/service/task-lifecycle";

const LEAD_ROWS: [string, string][] = [
  ["new", "researching"],
  ["new", "planning"],
  ["researching", "planning"],
  ["planning", "researching"],
  ["planning", "awaiting_plan_approval"],
  ["building", "verifying"],
  ["verifying", "building"],
  ["verifying", "blocked"],
  ["verifying", "awaiting_human_review"],
  ["verifying", "done"],
];

const NON_TERMINAL = TaskStatus.options.filter((s) => s !== "done" && s !== "cancelled");

describe("task move table", () => {
  test("every lead row is allowed and names its move", () => {
    for (const [from, to] of LEAD_ROWS) {
      const r = leadMove(from as TaskStatus, to as TaskStatus);
      expect(r).toEqual({ ok: true, move: `${from}>${to}` as never });
    }
  });

  test("every other lead pair is refused with the allowed targets", () => {
    const allowed = new Set(LEAD_ROWS.map(([f, t]) => `${f}>${t}`));
    for (const from of TaskStatus.options) {
      for (const to of TaskStatus.options) {
        if (allowed.has(`${from}>${to}`)) continue;
        const r = leadMove(from, to);
        expect(r.ok).toBe(false);
        if (r.ok) continue;
        expect(r.code).toBe("invalid_transition");
        expect(r.allowed).toEqual(leadTargets(from));
      }
    }
  });

  test("gate states have no lead targets and say they wait on a human", () => {
    for (const gate of ["awaiting_plan_approval", "blocked", "awaiting_human_review"] as const) {
      expect(isGate(gate)).toBe(true);
      expect(leadTargets(gate)).toEqual([]);
      const r = leadMove(gate, "building");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("handproof approve");
    }
    expect(isGate("verifying")).toBe(false);
  });

  test("approve and reject map per gate", () => {
    expect(humanMove("awaiting_plan_approval", "approve")).toEqual({ ok: true, to: "building" });
    expect(humanMove("awaiting_plan_approval", "reject")).toEqual({ ok: true, to: "planning" });
    expect(humanMove("blocked", "approve")).toEqual({ ok: true, to: "building" });
    expect(humanMove("blocked", "reject")).toEqual({ ok: true, to: "planning" });
    expect(humanMove("awaiting_human_review", "approve")).toEqual({ ok: true, to: "done" });
    expect(humanMove("awaiting_human_review", "reject")).toEqual({ ok: true, to: "building" });
  });

  test("approve and reject outside a gate are refused", () => {
    for (const s of TaskStatus.options) {
      if (isGate(s)) continue;
      expect(humanMove(s, "approve").ok).toBe(false);
      expect(humanMove(s, "reject").ok).toBe(false);
    }
  });

  test("cancel from every non-terminal state, never from done or cancelled", () => {
    for (const s of NON_TERMINAL) expect(humanMove(s, "cancel")).toEqual({ ok: true, to: "cancelled" });
    expect(humanMove("done", "cancel").ok).toBe(false);
    expect(humanMove("cancelled", "cancel").ok).toBe(false);
  });

  test("table is frozen", () => {
    expect(Object.isFrozen(TASK_MOVES)).toBe(true);
  });
});
