import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { main } from "../src/bin";
import { renderBrief } from "../src/render/markdown";
import validFixture from "./fixtures/handoffs/valid.json";
import { AGENTS, openTestService } from "./helpers/serviceSetup";
import { testEnv } from "./helpers/env";
import { tmpRepo } from "./helpers/tmpRepo";

const CURSOR_EXAMPLE = path.join(import.meta.dir, "..", "examples", "cursor.mcp.json");

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  try {
    const code = await fn();
    return { code, out: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}

describe("CLI ls and show", () => {
  test("ls prints both handoff ids after create", async () => {
    const repo = tmpRepo();
    try {
      const planner = openTestService(repo, AGENTS.planner);
      const a = planner.service.create(validFixture);
      const b = planner.service.create({
        ...validFixture,
        title: "Second valid handoff title",
      });
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      const idA = a.value.handoff.id;
      const idB = b.value.handoff.id;
      planner.close();

      const env = testEnv({ HANDPROOF_REPO: repo.dir });
      const { code, out } = await captureStdout(() => main(["ls"], env, repo.dir));
      expect(code).toBe(0);
      expect(out).toContain(idA);
      expect(out).toContain(idB);
    } finally {
      repo.cleanup();
    }
  });

  test('ls with --status cancelled prints "no handoffs" when none exist', async () => {
    const repo = tmpRepo();
    try {
      openTestService(repo, AGENTS.planner).close();
      const env = testEnv({ HANDPROOF_REPO: repo.dir });
      const { code, out } = await captureStdout(() =>
        main(["ls", "--status", "cancelled"], env, repo.dir),
      );
      expect(code).toBe(0);
      expect(out.trim()).toBe("no handoffs");
    } finally {
      repo.cleanup();
    }
  });

  test("show prints renderBrief plus trailing newline", async () => {
    const repo = tmpRepo();
    try {
      const planner = openTestService(repo, AGENTS.planner);
      const created = planner.service.create(validFixture);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = created.value.handoff.id;
      const events = planner.repo.events(id);
      const expected = `${renderBrief(created.value.handoff, events)}\n`;
      planner.close();

      const env = testEnv({ HANDPROOF_REPO: repo.dir });
      const { code, out } = await captureStdout(() => main(["show", id], env, repo.dir));
      expect(code).toBe(0);
      expect(out).toBe(expected);
    } finally {
      repo.cleanup();
    }
  });

  test("show unknown id exits 1", async () => {
    const repo = tmpRepo();
    try {
      openTestService(repo, AGENTS.planner).close();
      const env = testEnv({ HANDPROOF_REPO: repo.dir });
      const code = await main(["show", "h_nope"], env, repo.dir);
      expect(code).toBe(1);
    } finally {
      repo.cleanup();
    }
  });

  test("examples/cursor.mcp.json matches the documented MCP server shape", () => {
    const raw = fs.readFileSync(CURSOR_EXAMPLE, "utf8");
    const json = JSON.parse(raw) as {
      mcpServers: {
        handproof: {
          command: string;
          args: string[];
          env: Record<string, string>;
        };
      };
    };
    expect(json.mcpServers.handproof.command).toBe("bunx");
    expect(json.mcpServers.handproof.args).toEqual(["handproof", "serve"]);
    expect(json.mcpServers.handproof.env.HANDPROOF_AGENT).toBe("cursor-impl");
    expect(json.mcpServers.handproof.env.HANDPROOF_HARNESS).toBe("cursor");
  });
});
