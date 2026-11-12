import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config";
import type { AgentRef } from "../src/schema/handoff";
import { createServer } from "../src/server";
import { openService } from "../src/service/open";
import validFixture from "./fixtures/handoffs/valid.json";
import { initRepoHandoffs } from "./helpers/serviceSetup";
import { VALID_PAYLOADS } from "./helpers/taskFixtures";
import { type TmpRepo, tmpRepo } from "./helpers/tmpRepo";

const LEAD: AgentRef = { name: "lead", harness: "other" };
const GOAL = "Add rate limiting to POST /login";

let repo: TmpRepo;
let cleanup: (() => Promise<void>)[];

async function client(agent: AgentRef): Promise<Client> {
  const paths = initRepoHandoffs(repo);
  const handle = openService({ paths, config: loadConfig(paths), agent });
  const server = createServer({ paths, config: loadConfig(paths), agent, service: handle.service, tasks: handle.tasks });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0.0.1" });
  await server.connect(st);
  await c.connect(ct);
  cleanup.push(async () => {
    await c.close();
    await server.close();
    handle.close();
  });
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  return { isError: r.isError === true, body: r.structuredContent as Record<string, unknown> };
}

beforeEach(() => {
  repo = tmpRepo();
  cleanup = [];
  fs.mkdirSync(path.join(repo.dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, "notes/RESEARCH.md"), "# r\n");
  fs.writeFileSync(path.join(repo.dir, "notes/PLAN.md"), "# p\n");
});

afterEach(async () => {
  for (const c of cleanup) await c();
  repo.cleanup();
});

describe("task MCP tools", () => {
  test("lists the four task tools and describes each move's payload fields", async () => {
    const c = await client(LEAD);
    const tools = (await c.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const n of ["task_create", "task_transition", "task_get", "task_list"]) expect(names).toContain(n);
    expect(names.some((n) => /approve|reject|cancel/.test(n) && n.startsWith("task_"))).toBe(false);
    const desc = tools.find((t) => t.name === "task_transition")?.description ?? "";
    expect(desc).toContain("building → verifying: summary, commits, diff_lines");
    expect(desc).toContain("handproof approve");
  });

  test("drive a task to the plan gate; the gate refuses the lead", async () => {
    const c = await client(LEAD);
    const created = await call(c, "task_create", { goal: GOAL });
    expect(created.isError).toBe(false);
    const id = (created.body.task as { id: string }).id;
    for (const [to, move] of [
      ["researching", "new>researching"],
      ["planning", "researching>planning"],
      ["awaiting_plan_approval", "planning>awaiting_plan_approval"],
    ] as const) {
      const r = await call(c, "task_transition", { id, to, payload: VALID_PAYLOADS[move] });
      expect(r.isError).toBe(false);
      expect((r.body.task as { status: string }).status).toBe(to);
    }
    const gate = await call(c, "task_transition", { id, to: "building", payload: {} });
    expect(gate.isError).toBe(true);
    expect(gate.body.error).toBe("invalid_transition");
    expect(String(gate.body.message)).toContain("handproof approve");
  });

  test("bad payload comes back as field-level issues", async () => {
    const c = await client(LEAD);
    const id = ((await call(c, "task_create", { goal: GOAL })).body.task as { id: string }).id;
    const r = await call(c, "task_transition", { id, to: "researching", payload: { goal: GOAL } });
    expect(r.isError).toBe(true);
    expect(r.body.error).toBe("validation_failed");
    expect(JSON.stringify(r.body.issues)).toContain('"path":"questions"');
  });

  test("task_get and task://{id} show the brief and linked handoffs", async () => {
    const c = await client(LEAD);
    const id = ((await call(c, "task_create", { goal: GOAL })).body.task as { id: string }).id;
    await call(c, "task_transition", { id, to: "researching", payload: VALID_PAYLOADS["new>researching"] });
    await call(c, "task_transition", { id, to: "planning", payload: VALID_PAYLOADS["researching>planning"] });
    await call(c, "task_transition", {
      id,
      to: "awaiting_plan_approval",
      payload: { ...VALID_PAYLOADS["planning>awaiting_plan_approval"], brief: "Task #1\nApproach: token bucket" },
    });
    const h = await call(c, "handoff_create", { ...validFixture, task: id });
    expect(h.isError).toBe(false);
    const hid = (h.body.handoff as { id: string; task: string }).id;
    expect((h.body.handoff as { task: string }).task).toBe(id);

    const got = await call(c, "task_get", { id });
    expect((got.body.handoffs as { id: string }[]).map((x) => x.id)).toEqual([hid]);
    const md = String(got.body.markdown);
    expect(md).toContain("Approach: token bucket");
    expect(md).toContain(hid);

    const res = await c.readResource({ uri: `task://${id}` });
    const text = (res.contents[0] as { text: string }).text;
    expect(text).toContain(`# Task ${id}`);
    expect(text).toContain("**Rounds:** 0/3");
    expect(text).toContain("<handoff-data");

    const listed = await call(c, "task_list", {});
    expect((listed.body.tasks as { id: string }[]).map((t) => t.id)).toEqual([id]);
  });
});
