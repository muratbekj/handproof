import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { renderBrief } from "../src/render/markdown";
import type { AgentRef } from "../src/schema/handoff";
import { openService } from "../src/service/open";
import validFixture from "./fixtures/handoffs/valid.json";
import { initRepoHandoffs } from "./helpers/serviceSetup";
import { type TmpRepo, tmpRepo } from "./helpers/tmpRepo";

const LEAD: AgentRef = { name: "lead", harness: "other" };
const HUMAN: AgentRef = { name: "human-cli", harness: "other" };
const GOAL = "Add rate limiting to POST /login";

let repo: TmpRepo;
let closers: (() => void)[];

function open(agent: AgentRef) {
  const paths = initRepoHandoffs(repo);
  const handle = openService({ paths, config: loadConfig(paths), agent });
  closers.push(() => {
    handle.close();
  });
  return handle;
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: { error: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.error}: ${r.error.message}`);
  return r.value;
}

beforeEach(() => {
  repo = tmpRepo();
  closers = [];
});

afterEach(() => {
  for (const c of closers) c();
  repo.cleanup();
});

describe("handoffs linked to a task", () => {
  test("create with a task links it; summary, list filter, brief and task.get show it", () => {
    const lead = open(LEAD);
    const t = must(lead.tasks.create({ goal: GOAL }));
    const a = must(lead.service.create({ ...validFixture, task: t.id })).handoff;
    const b = must(lead.service.create({ ...validFixture, title: "Second linked handoff", task: t.id })).handoff;
    const loose = must(lead.service.create(validFixture)).handoff;

    expect(a.task).toBe(t.id);
    const listed = must(lead.service.list({ task: t.id }));
    expect(listed.map((h) => h.id)).toEqual([a.id, b.id]);
    expect(listed[0]?.task).toBe(t.id);
    expect(must(lead.service.list({})).find((h) => h.id === loose.id)?.task).toBeNull();

    const got = must(lead.service.get(a.id));
    expect(renderBrief(got.handoff, got.events)).toContain(`**Task:** \`${t.id}\``);
    expect(renderBrief(must(lead.service.get(loose.id)).handoff, [])).not.toContain("**Task:**");

    const view = must(lead.tasks.get(t.id));
    expect(view.handoffs.map((h) => h.id)).toEqual([a.id, b.id]);
    expect(view.events.filter((e) => e.type === "handoff_linked").map((e) => e.data.handoff)).toEqual([a.id, b.id]);
  });

  test("unknown task is not_found and nothing is stored", () => {
    const lead = open(LEAD);
    const r = lead.service.create({ ...validFixture, task: "t_01JC3Z0000000000000000000A" });
    expect(!r.ok && r.error.error).toBe("not_found");
    expect(!r.ok && r.error.message).toContain("no task");
    expect(must(lead.service.list({}))).toEqual([]);
  });

  test("malformed task id is a field-level validation error", () => {
    const r = open(LEAD).service.create({ ...validFixture, task: "nope" });
    expect(!r.ok && r.error.error).toBe("validation_failed");
    expect(!r.ok && JSON.stringify(r.error.issues)).toContain('"path":"task"');
  });

  test("a done or cancelled task can't take new handoffs", () => {
    const lead = open(LEAD);
    const human = open(HUMAN);
    const t = must(lead.tasks.create({ goal: GOAL }));
    must(human.tasks.cancel(t.id, { reason: "dropped" }));
    const r = lead.service.create({ ...validFixture, task: t.id });
    expect(!r.ok && r.error.error).toBe("invalid_transition");
    expect(!r.ok && r.error.message).toContain("cancelled");
  });
});
