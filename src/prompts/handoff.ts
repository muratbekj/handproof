import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type RepoPaths, loadConfig } from "../config.ts";
import { Kind } from "../schema/handoff.ts";
import { promptResult, promptSafely } from "./args.ts";

const KIND_MEANING: Record<Kind, string> = {
  implement: "build new behavior; changes stay inside scope.allowed",
  fix: "fix a bug; changes stay inside scope.allowed",
  test: "add or repair tests; changes stay inside scope.allowed",
  review: "read and report findings; any file change fails the scope check",
  investigate: "find out and report; any file change fails the scope check",
};

const ArgsSchema = z.object({
  request: z
    .string()
    .optional()
    .describe("task summary; in Claude Code type the task in chat first, only one word fits here"),
});

function checksLine(names: string[]): string {
  if (names.length === 0) return "No checks are configured; acceptance items will be self-reported, so leave out `check`.";
  return `\`acceptance[].check\`, when set, must be one of the configured checks: ${names.map((n) => `\`${n}\``).join(", ")}.`;
}

/** `/handoff`: no side effect; tells the agent how to package this session into one handoff_create call. */
export function registerHandoffPrompt(server: McpServer, paths: RepoPaths): void {
  server.registerPrompt(
    "handoff",
    {
      title: "Hand off",
      description: "Package the task from this conversation into one handoff_create call for another agent",
      argsSchema: ArgsSchema,
    },
    ({ request }) =>
      promptSafely("handoff prompt", () => {
        const checks = Object.keys(loadConfig(paths).checks).sort();
        const hint = request?.trim().replace(/\s+/g, " ") ?? "";
        const lines = [
          "Hand the task off to another coding agent with exactly one `handoff_create` call.",
          "",
          "Use the task the user described in this conversation. If it isn't clear what the task is, ask the user before calling `handoff_create`.",
        ];
        if (hint !== "") {
          lines.push(
            "",
            `Request hint: ${hint}`,
            "",
            "That hint was typed after the command. Slash clients may pass only its first word, so when the conversation says more, the conversation wins.",
          );
        }
        lines.push(
          "",
          "## Field rules",
          "- `goal`: at least 40 characters, saying what done looks like.",
          "- `scope.allowed`: repo-relative globs the implementer may change (e.g. `src/auth/**`); `scope.forbidden` for globs it must not touch.",
          `- ${checksLine(checks)}`,
          "- A handoff never carries shell commands: checks run only from the committed config.",
          "- No secrets (tokens, keys, passwords) anywhere in the handoff.",
          "- What was already tried goes in `context.tried`; decisions that are fixed go in `context.decisions`.",
          "",
          "## Kinds",
          ...Kind.options.map((k) => `- \`${k}\`: ${KIND_MEANING[k]}`),
          "",
          "## After the call",
          "On `validation_failed`, fix each issue using its `fix` and call `handoff_create` again. When it succeeds, tell the user the returned handoff id.",
        );
        return promptResult("Create a handoff from this conversation", lines.join("\n"));
      }),
  );
}
