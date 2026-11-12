import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadConfig } from "../src/config";
import type { AgentRef } from "../src/schema/handoff";
import { createServer } from "../src/server";
import { openService } from "../src/service/open";
import { UNTRUSTED_NOTICE, renderBrief } from "../src/render/markdown";
import validFixture from "./fixtures/handoffs/valid.json";
import { AGENTS, initRepoHandoffs } from "./helpers/serviceSetup";
import { testEnv } from "./helpers/env";
import { tmpRepo } from "./helpers/tmpRepo";

const PROJECT_ROOT = path.join(import.meta.dir, "..");
const BIN = path.join(PROJECT_ROOT, "src/bin.ts");

const TOOL_NAMES = [
  "handoff_create",
  "handoff_list",
  "handoff_get",
  "handoff_claim",
  "handoff_update",
  "handoff_release",
  "handoff_cancel",
  "handoff_submit",
  "handoff_verify",
  "handoff_review",
] as const;

async function withLinkedClients(
  repo: ReturnType<typeof tmpRepo>,
  agents: [AgentRef, AgentRef],
  fn: (clients: { planner: Client; cursor: Client }) => Promise<void>,
): Promise<void> {
  const paths = initRepoHandoffs(repo);
  const config = loadConfig(paths);

  const openFor = (agent: AgentRef) => {
    const handle = openService({ paths, config, agent });
    const server = createServer({ paths, config, agent, service: handle.service });
    return { ...handle, server };
  };

  const plannerCtx = openFor(agents[0]);
  const cursorCtx = openFor(agents[1]);

  const [plannerTransport, plannerServerTransport] = InMemoryTransport.createLinkedPair();
  const [cursorTransport, cursorServerTransport] = InMemoryTransport.createLinkedPair();

  const plannerClient = new Client({ name: "planner-test", version: "0.0.1" });
  const cursorClient = new Client({ name: "cursor-test", version: "0.0.1" });

  await plannerCtx.server.connect(plannerServerTransport);
  await cursorCtx.server.connect(cursorServerTransport);
  await plannerClient.connect(plannerTransport);
  await cursorClient.connect(cursorTransport);

  try {
    await fn({ planner: plannerClient, cursor: cursorClient });
  } finally {
    await plannerClient.close();
    await cursorClient.close();
    await plannerCtx.server.close();
    await cursorCtx.server.close();
    plannerCtx.close();
    cursorCtx.close();
  }
}

function structured(call: { content: unknown[]; structuredContent?: unknown; isError?: boolean }) {
  const textBlock = call.content.find(
    (c) => typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  expect(textBlock?.text).toBeDefined();
  const text = textBlock?.text;
  if (text === undefined) {
    throw new Error("missing text content block");
  }
  expect(JSON.parse(text)).toEqual(call.structuredContent);
  return call.structuredContent as Record<string, unknown>;
}

function resourceText(contents: { uri: string; text?: string; blob?: string }[]): string {
  const first = contents[0];
  if (first?.text !== undefined) {
    return first.text;
  }
  throw new Error("expected text resource content");
}

describe("MCP tools and resources", () => {
  test("listTools exposes ten handoff tools with create schema constraints", async () => {
    const repo = tmpRepo();
    try {
      await withLinkedClients(repo, [AGENTS.planner, AGENTS.cursorImpl], async ({ planner }) => {
        const listed = await planner.listTools();
        const names = listed.tools.map((t) => t.name).sort();
        expect(names).toEqual([...TOOL_NAMES].sort());

        const create = listed.tools.find((t) => t.name === "handoff_create");
        if (!create) {
          throw new Error("handoff_create tool missing");
        }
        const schema = create.inputSchema as {
          required?: string[];
          properties?: { title?: { minLength?: number } };
        };
        for (const field of ["kind", "title", "goal", "context", "scope", "acceptance"]) {
          expect(schema.required ?? []).toContain(field);
        }
        expect(schema.properties?.title?.minLength).toBe(8);
      });
    } finally {
      repo.cleanup();
    }
  });

  test("validation errors are handler-level structuredContent failures", async () => {
    const repo = tmpRepo();
    try {
      await withLinkedClients(repo, [AGENTS.planner, AGENTS.cursorImpl], async ({ planner }) => {
        const shortTitle = await planner.callTool({
          name: "handoff_create",
          arguments: { ...validFixture, title: "12345" },
        });
        expect(shortTitle.isError).toBe(true);
        const body = structured(shortTitle);
        expect(body.error).toBe("validation_failed");
        const issues = body.issues as { path: string; problem: string; fix: string }[];
        expect(issues).toContainEqual({
          path: "title",
          problem: "too short (5 chars, min 8)",
          fix: "use 8–120 chars",
        });

        const created = await planner.callTool({
          name: "handoff_create",
          arguments: validFixture,
        });
        expect(created.isError).not.toBe(true);
        const id = (structured(created).handoff as { id: string }).id;

        const missingNote = await planner.callTool({
          name: "handoff_update",
          arguments: { id },
        });
        expect(missingNote.isError).toBe(true);
        const updateErr = structured(missingNote);
        expect(updateErr.error).toBe("validation_failed");
        const noteIssue = (updateErr.issues as { path: string }[]).find((i) => i.path === "note");
        expect(noteIssue).toBeDefined();
      });
    } finally {
      repo.cleanup();
    }
  });

  test("full cross-agent loop on one database file", async () => {
    const repo = tmpRepo();
    try {
      await withLinkedClients(repo, [AGENTS.planner, AGENTS.cursorImpl], async ({ planner, cursor }) => {
        const created = await planner.callTool({
          name: "handoff_create",
          arguments: validFixture,
        });
        const createBody = structured(created);
        const id = (createBody.handoff as { id: string }).id;

        const listed = await cursor.callTool({ name: "handoff_list", arguments: {} });
        const listBody = structured(listed);
        expect((listBody.handoffs as { id: string }[]).some((h) => h.id === id)).toBe(true);

        const claimed = await cursor.callTool({ name: "handoff_claim", arguments: { id } });
        const claimBody = structured(claimed);
        expect((claimBody.handoff as { status: string }).status).toBe("claimed");
        expect(String(claimBody.markdown)).toContain(UNTRUSTED_NOTICE);

        const plannerClaim = await planner.callTool({ name: "handoff_claim", arguments: { id } });
        expect(plannerClaim.isError).toBe(true);
        expect((structured(plannerClaim) as { error: string }).error).toBe("already_claimed");

        const updated = await cursor.callTool({
          name: "handoff_update",
          arguments: { id, note: "progress note for update" },
        });
        structured(updated);

        const released = await cursor.callTool({
          name: "handoff_release",
          arguments: { id, reason: "ready for review" },
        });
        structured(released);

        const cancelled = await planner.callTool({
          name: "handoff_cancel",
          arguments: { id, reason: "no longer needed" },
        });
        const cancelBody = structured(cancelled);
        expect((cancelBody.handoff as { status: string }).status).toBe("cancelled");
      });
    } finally {
      repo.cleanup();
    }
  });

  test("resources serve inbox and brief markdown", async () => {
    const repo = tmpRepo();
    try {
      await withLinkedClients(repo, [AGENTS.planner, AGENTS.cursorImpl], async ({ planner, cursor }) => {
        const created = await planner.callTool({
          name: "handoff_create",
          arguments: validFixture,
        });
        const id = (structured(created).handoff as { id: string }).id;

        const inbox = await cursor.readResource({ uri: "handoff://inbox" });
        expect(resourceText(inbox.contents)).toContain(id);

        const got = await planner.callTool({ name: "handoff_get", arguments: { id } });
        const getBody = structured(got);
        const handoff = getBody.handoff as Parameters<typeof renderBrief>[0];
        const events = getBody.events as Parameters<typeof renderBrief>[1];
        expect(getBody.markdown).toBe(renderBrief(handoff, events));

        const brief = await cursor.readResource({ uri: `handoff://${id}` });
        expect(resourceText(brief.contents)).toBe(renderBrief(handoff, events));

        let notFound = false;
        try {
          await cursor.readResource({ uri: "handoff://h_nope" });
        } catch (error) {
          notFound = true;
          expect(String(error)).toMatch(/Resource not found/i);
        }
        expect(notFound).toBe(true);
      });
    } finally {
      repo.cleanup();
    }
  });

  test("stdio serve emits no stderr and advertises the ten handoff tools and four task tools", async () => {
    const repo = tmpRepo();
    try {
      initRepoHandoffs(repo);
      const env = testEnv({
        HANDPROOF_REPO: repo.dir,
        HANDPROOF_AGENT: AGENTS.cursorImpl.name,
        HANDPROOF_HARNESS: AGENTS.cursorImpl.harness,
      });

      const stderrChunks: string[] = [];
      const transport = new StdioClientTransport({
        command: "bun",
        args: [BIN, "serve"],
        env: env as Record<string, string>,
        cwd: PROJECT_ROOT,
        stderr: "pipe",
      });

      if (transport.stderr) {
        transport.stderr.on("data", (chunk: Buffer) => {
          stderrChunks.push(chunk.toString());
        });
      }

      const client = new Client({ name: "stdio-test", version: "0.0.1" });
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(
        [...TOOL_NAMES, "task_create", "task_get", "task_list", "task_transition"].sort(),
      );
      await client.close();

      expect(stderrChunks.join("")).toBe("");
    } finally {
      repo.cleanup();
    }
  });
});
