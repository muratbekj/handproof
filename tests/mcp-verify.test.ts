import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config";
import { main } from "../src/bin";
import type { AgentRef } from "../src/schema/handoff";
import { createServer } from "../src/server";
import { openService } from "../src/service/open";
import { AGENTS, initRepoHandoffs } from "./helpers/serviceSetup";
import {
  DEMO_CONFIG,
  criteriaFor,
  implementHandoffInput,
  initPhase2Repo,
} from "./helpers/phase2Setup";
import { testEnv } from "./helpers/env";
import { tmpRepo } from "./helpers/tmpRepo";

const SUBMIT_SUMMARY =
  "Implemented auth ok marker file under src/auth and kept edits inside the allowed scope.";

/** Matches DEMO_CONFIG (single check name `test`). */
function demoHandoffInput() {
  return implementHandoffInput([
    {
      id: "ac1",
      description: "Auth ok file exists and scope is respected.",
      check: "test",
    },
  ]);
}

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

async function withClients(
  repo: ReturnType<typeof tmpRepo>,
  fn: (clients: { planner: Client; cursor: Client }) => Promise<void>,
): Promise<void> {
  const paths = initPhase2Repo(repo, DEMO_CONFIG);
  const config = loadConfig(paths);
  const openFor = (agent: AgentRef) => {
    const handle = openService({ paths, config, agent });
    const server = createServer({ paths, config, agent, service: handle.service });
    return { handle, server };
  };
  const plannerCtx = openFor(AGENTS.planner);
  const cursorCtx = openFor(AGENTS.cursorImpl);
  const [pTransport, pServerTransport] = InMemoryTransport.createLinkedPair();
  const [cTransport, cServerTransport] = InMemoryTransport.createLinkedPair();
  const planner = new Client({ name: "planner-mcp", version: "0.0.1" });
  const cursor = new Client({ name: "cursor-mcp", version: "0.0.1" });
  await plannerCtx.server.connect(pServerTransport);
  await cursorCtx.server.connect(cServerTransport);
  await planner.connect(pTransport);
  await cursor.connect(cTransport);
  try {
    await fn({ planner, cursor });
  } finally {
    await planner.close();
    await cursor.close();
    await plannerCtx.server.close();
    await cursorCtx.server.close();
    plannerCtx.handle.close();
    cursorCtx.handle.close();
  }
}

function structured(call: { content: unknown[]; structuredContent?: unknown; isError?: boolean }) {
  const textBlock = call.content.find(
    (c) => typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  const text = textBlock?.text;
  if (text === undefined) throw new Error("missing text block");
  expect(JSON.parse(text)).toEqual(call.structuredContent);
  return call.structuredContent as Record<string, unknown>;
}

describe("MCP verify tools and CLI review (PLAN Step 6)", () => {
  test("listTools exposes ten handoff tools including submit, verify, review", async () => {
    const repo = tmpRepo();
    try {
      initRepoHandoffs(repo);
      await withClients(repo, async ({ planner }) => {
        const listed = await planner.listTools();
        const names = listed.tools.map((t) => t.name).sort();
        expect(names).toEqual([...TOOL_NAMES].sort());
      });
    } finally {
      repo.cleanup();
    }
  });

  test("handoff_submit without criteria → validation_failed on criteria path", async () => {
    const repo = tmpRepo();
    try {
      await withClients(repo, async ({ planner, cursor }) => {
        const created = await planner.callTool({
          name: "handoff_create",
          arguments: demoHandoffInput(),
        });
        const id = (structured(created).handoff as { id: string }).id;
        await cursor.callTool({ name: "handoff_claim", arguments: { id } });
        const submit = await cursor.callTool({
          name: "handoff_submit",
          arguments: { id, summary: SUBMIT_SUMMARY },
        });
        expect(submit.isError).toBe(true);
        const body = structured(submit);
        expect(body.error).toBe("validation_failed");
        const issues = body.issues as { path: string }[];
        expect(issues.some((i) => i.path === "criteria")).toBe(true);
      });
    } finally {
      repo.cleanup();
    }
  });

  test("changes_requested brief shows Verification after handoff-data with violation line", async () => {
    const repo = tmpRepo();
    try {
      await withClients(repo, async ({ planner, cursor }) => {
        const created = await planner.callTool({
          name: "handoff_create",
          arguments: demoHandoffInput(),
        });
        const id = (structured(created).handoff as { id: string }).id;
        await cursor.callTool({ name: "handoff_claim", arguments: { id } });
        fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");
        fs.writeFileSync(path.join(repo.dir, "package.json"), '{"bad":true}\n');
        await cursor.callTool({
          name: "handoff_submit",
          arguments: { id, summary: SUBMIT_SUMMARY, criteria: criteriaFor(["ac1"]) },
        });
        const got = await planner.callTool({ name: "handoff_get", arguments: { id } });
        const md = (got.content[0] as { text?: string }).text ?? "";
        const dataClose = md.indexOf("</handoff-data>");
        const verification = md.indexOf("## Verification");
        const resultHeading = md.indexOf("## Result");
        expect(resultHeading).toBeGreaterThan(0);
        expect(dataClose).toBeGreaterThan(resultHeading);
        expect(verification).toBeGreaterThan(dataClose);
        expect(md).toContain("**Passed:** no");
        expect(md).toContain("- `package.json` — outside src/auth/**");
      });
    } finally {
      repo.cleanup();
    }
  });

  test("CLI review accept on verified handoff succeeds; open handoff exits 1", async () => {
    const repo = tmpRepo();
    try {
      const paths = initPhase2Repo(repo);
      const config = loadConfig(paths);
      const planner = openService({ paths, config, agent: AGENTS.planner });
      const created = planner.service.create(implementHandoffInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = created.value.handoff.id;
      planner.close();

      const worker = openService({ paths, config, agent: AGENTS.cursorImpl });
      expect(worker.service.claim(id).ok).toBe(true);
      fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");
      const sub = await worker.service.submit(id, {
        summary: SUBMIT_SUMMARY,
        criteria: criteriaFor(["ac1"]),
      });
      expect(sub.ok).toBe(true);
      worker.close();

      const env = testEnv({ HANDOFFS_REPO: repo.dir, HANDOFFS_AGENT: "human-cli" });
      expect(await main(["review", id, "accept"], env, repo.dir)).toBe(0);

      const plannerAgain = openService({ paths, config, agent: AGENTS.planner });
      const openOnly = plannerAgain.service.create({
        ...implementHandoffInput(),
        title: "Another open handoff for review test",
      });
      expect(openOnly.ok).toBe(true);
      if (!openOnly.ok) return;
      expect(await main(["review", openOnly.value.handoff.id, "accept"], env, repo.dir)).toBe(1);
      plannerAgain.close();
    } finally {
      repo.cleanup();
    }
  });
});
