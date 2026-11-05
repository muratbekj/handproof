import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config";
import type { AgentRef } from "../src/schema/handoff";
import { createServer } from "../src/server";
import { openService } from "../src/service/open";
import { AGENTS } from "./helpers/serviceSetup";
import {
  DEMO_CONFIG,
  criteriaFor,
  implementHandoffInput,
  initPhase2Repo,
} from "./helpers/phase2Setup";
import { tmpRepo } from "./helpers/tmpRepo";

const SUMMARY =
  "Implemented auth ok marker file under src/auth and kept edits inside the allowed scope.";

function structured(call: { content: unknown[]; structuredContent?: unknown; isError?: boolean }) {
  const textBlock = call.content.find(
    (c) => typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  const text = textBlock?.text;
  if (text === undefined) throw new Error("missing text block");
  expect(JSON.parse(text)).toEqual(call.structuredContent);
  return call.structuredContent as Record<string, unknown>;
}

describe("demo script e2e (PLAN Step 7)", () => {
  test("planner and cursor-impl loop: scope violation then verify and accept", async () => {
    const repo = tmpRepo();
    try {
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
      const planner = new Client({ name: "demo-planner", version: "0.0.1" });
      const cursor = new Client({ name: "demo-cursor", version: "0.0.1" });
      await plannerCtx.server.connect(pServerTransport);
      await cursorCtx.server.connect(cServerTransport);
      await planner.connect(pTransport);
      await cursor.connect(cTransport);

      try {
        const createInput = {
          ...implementHandoffInput([{ id: "ac1", description: "Ok file exists.", check: "test" }]),
          scope: { allowed: ["src/auth/**"], forbidden: [] },
        };
        const created = await planner.callTool({ name: "handoff_create", arguments: createInput });
        const id = (structured(created).handoff as { id: string }).id;

        await cursor.callTool({ name: "handoff_claim", arguments: { id } });
        fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");
        fs.writeFileSync(path.join(repo.dir, "package.json"), '{"scope":"violation"}\n');

        const firstSubmit = await cursor.callTool({
          name: "handoff_submit",
          arguments: { id, summary: SUMMARY, criteria: criteriaFor(["ac1"]) },
        });
        expect(firstSubmit.isError).not.toBe(true);
        const firstBody = structured(firstSubmit);
        expect((firstBody.handoff as { status: string }).status).toBe("changes_requested");
        const verification = firstBody.verification as {
          scope: { violations: { path: string; rule: string }[] };
        };
        expect(verification.scope.violations).toContainEqual({
          path: "package.json",
          rule: "outside src/auth/**",
        });

        fs.rmSync(path.join(repo.dir, "package.json"), { force: true });
        const secondSubmit = await cursor.callTool({
          name: "handoff_submit",
          arguments: { id, summary: SUMMARY, criteria: criteriaFor(["ac1"]) },
        });
        expect(secondSubmit.isError).not.toBe(true);
        expect((structured(secondSubmit).handoff as { status: string }).status).toBe("verified");

        const accepted = await planner.callTool({
          name: "handoff_review",
          arguments: { id, decision: "accept" },
        });
        expect(accepted.isError).not.toBe(true);
        expect((structured(accepted).handoff as { status: string }).status).toBe("done");

        const events = plannerCtx.handle.repo.events(id).map((e) => e.type);
        expect(events).toEqual([
          "created",
          "claimed",
          "submitted",
          "changes_requested",
          "submitted",
          "verified",
          "accepted",
        ]);
      } finally {
        await planner.close();
        await cursor.close();
        await plannerCtx.server.close();
        await cursorCtx.server.close();
        plannerCtx.handle.close();
        cursorCtx.handle.close();
      }
    } finally {
      repo.cleanup();
    }
  });
});
