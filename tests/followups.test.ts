import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig, type RepoPaths } from "../src/config";
import type { AgentRef } from "../src/schema/handoff";
import { createServer } from "../src/server";
import { openService } from "../src/service/open";
import validFixture from "./fixtures/handoffs/valid.json";
import { AGENTS, initRepoHandoffs } from "./helpers/serviceSetup";
import { tmpRepo } from "./helpers/tmpRepo";

/** Text of the first text content block of a tool result or prompt message. */
function textOf(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  for (const b of blocks) {
    if (b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text") {
      const t = (b as { text?: unknown }).text;
      return typeof t === "string" ? t : "";
    }
  }
  return "";
}

function lastFence(text: string): string {
  const fences = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)];
  return fences.at(-1)?.[1] ?? "";
}

async function withClient<T>(paths: RepoPaths, agent: AgentRef, fn: (client: Client) => Promise<T>): Promise<T> {
  const handle = openService({ paths, config: loadConfig(paths), agent });
  const server = createServer({ paths, config: loadConfig(paths), agent, service: handle.service });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "followups-test", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
    handle.close();
  }
}

function createOne(paths: RepoPaths): string {
  const planner = openService({ paths, config: loadConfig(paths), agent: AGENTS.planner });
  try {
    const created = planner.service.create(validFixture);
    if (!created.ok) throw new Error(`create failed: ${created.error.error}`);
    return created.value.handoff.id;
  } finally {
    planner.close();
  }
}

describe("handoff_claim reply for clients without prompt support", () => {
  test("ends with the working rules and the exact handoff_submit call", async () => {
    const repo = tmpRepo();
    try {
      const paths = initRepoHandoffs(repo);
      const id = createOne(paths);
      await withClient(paths, AGENTS.cursorImpl, async (client) => {
        const claim = await client.callTool({ name: "handoff_claim", arguments: {} });
        expect(claim.isError).not.toBe(true);
        const parsed = JSON.parse(textOf(claim.content)) as { markdown?: unknown };
        const markdown = typeof parsed.markdown === "string" ? parsed.markdown : "";
        expect(markdown).toContain("<handoff-data");
        expect(markdown).toContain("## How to work");
        expect(markdown.indexOf("</handoff-data>")).toBeLessThan(markdown.indexOf("## How to work"));
        expect(markdown.trimEnd().endsWith("```")).toBe(true);
        const call = lastFence(markdown);
        expect(call.startsWith("handoff_submit ")).toBe(true);
        const args = JSON.parse(call.slice("handoff_submit ".length)) as { id: string; criteria: { id: string }[] };
        expect(args.id).toBe(id);
        expect(args.criteria.map((c) => c.id)).toEqual(validFixture.acceptance.map((a) => a.id));
      });
    } finally {
      repo.cleanup();
    }
  });

  test("a broken config fails the call before claiming", async () => {
    const repo = tmpRepo();
    try {
      const paths = initRepoHandoffs(repo);
      const id = createOne(paths);
      await withClient(paths, AGENTS.cursorImpl, async (client) => {
        fs.writeFileSync(paths.configPath, "{ not json");
        const claim = await client.callTool({ name: "handoff_claim", arguments: { id } });
        expect(claim.isError).toBe(true);
        expect(textOf(claim.content)).toContain("config_invalid");
      });
      fs.writeFileSync(paths.configPath, `${JSON.stringify({ leaseMinutes: 30, checks: { test: { run: "true" } } })}\n`);
      const reader = openService({ paths, config: loadConfig(paths), agent: AGENTS.planner });
      try {
        const got = reader.service.get(id);
        expect(got.ok && got.value.handoff.status).toBe("open");
      } finally {
        reader.close();
      }
    } finally {
      repo.cleanup();
    }
  });
});

describe("handoff prompt keeps the planner from doing the task", () => {
  test("says not to edit files and how to handle changes already made", async () => {
    const repo = tmpRepo();
    try {
      const paths = initRepoHandoffs(repo);
      await withClient(paths, AGENTS.planner, async (client) => {
        const p = await client.getPrompt({ name: "handoff", arguments: {} });
        const text = textOf(p.messages[0]?.content);
        expect(text).toContain("## Don't do the task yourself");
        expect(text).toMatch(/Don't edit, create or delete files for this task/);
        expect(text).toMatch(/`review` handoff of those changes/);
        expect(text).toMatch(/revert your changes first/);
        expect(text.indexOf("## Don't do the task yourself")).toBeLessThan(text.indexOf("## Field rules"));
      });
    } finally {
      repo.cleanup();
    }
  });
});

describe("README covers clients without prompt support", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  test("tells Cursor Agent CLI users to call handoff_claim", () => {
    expect(readme).toMatch(/Cursor Agent CLI[^\n]*handoff_claim/);
  });
  test("quickstart tells the planner not to write code", () => {
    expect(readme).toMatch(/Don't write any code, I'm handing this off/);
  });
});
