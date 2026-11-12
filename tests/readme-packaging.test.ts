import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigSchema } from "../src/config";
import cursorExample from "../examples/cursor.mcp.json";

const PROJECT_ROOT = path.join(import.meta.dir, "..");
const README_PATH = path.join(PROJECT_ROOT, "README.md");
const CLAUDE_EXAMPLE = path.join(PROJECT_ROOT, "examples", "claude-code.md");

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
  "task_create",
  "task_transition",
  "task_get",
  "task_list",
];

const PROMPT_NAMES = ["create", "pickup", "review"];

function configKeys(): string[] {
  const shape = ConfigSchema.shape;
  return Object.keys(shape);
}

function quickstartCommandCount(readme: string): number {
  const match = readme.match(/## Quickstart[\s\S]*?```(?:bash|sh)?\n([\s\S]*?)```/i);
  if (!match?.[1]) return Infinity;
  return match[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#")).length;
}

describe("README and examples (PLAN Step 4)", () => {
  test("README mentions every tool, prompt, and ConfigSchema top-level key", () => {
    const readme = fs.readFileSync(README_PATH, "utf8");
    for (const tool of TOOL_NAMES) {
      expect(readme).toContain(tool);
    }
    for (const prompt of PROMPT_NAMES) {
      expect(readme).toContain(prompt);
    }
    for (const key of configKeys()) {
      expect(readme).toContain(key);
    }
  });

  test("README quickstart block has at most six commands", () => {
    const readme = fs.readFileSync(README_PATH, "utf8");
    expect(quickstartCommandCount(readme)).toBeLessThanOrEqual(6);
  });

  test("examples match README server name and agent env", () => {
    const readme = fs.readFileSync(README_PATH, "utf8");
    const claude = fs.readFileSync(CLAUDE_EXAMPLE, "utf8");
    const cursor = cursorExample as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };

    expect(readme).toContain("handoffs");
    expect(claude).toContain("claude mcp add handproof");
    expect(claude).toContain("HANDPROOF_AGENT=planner");
    expect(claude).toContain("HANDPROOF_HARNESS=claude-code");

    expect(cursor.mcpServers.handproof?.env?.HANDPROOF_AGENT).toBe("cursor-impl");
    expect(cursor.mcpServers.handproof?.env?.HANDPROOF_HARNESS).toBe("cursor");
    expect(readme).toContain("cursor.mcp.json");
  });
});
