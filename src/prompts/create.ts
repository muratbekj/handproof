import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type RepoPaths, loadConfig } from "../config.ts";
import { createInstructions } from "../render/create.ts";
import { promptResult, promptSafely } from "./args.ts";

const ArgsSchema = z.object({
  request: z
    .string()
    .optional()
    .describe("task summary; in Claude Code type the task in chat first, only one word fits here"),
});

/** `create`: no side effect; tells the agent how to package this session into one handoff_create call. */
export function registerCreatePrompt(server: McpServer, paths: RepoPaths): void {
  server.registerPrompt(
    "create",
    {
      title: "Hand off",
      description: "Package the task from this conversation into one handoff_create call for another agent",
      argsSchema: ArgsSchema,
    },
    ({ request }) =>
      promptSafely("handoff prompt", () => {
        const checks = Object.keys(loadConfig(paths).checks).sort();
        const hint = request?.trim().replace(/\s+/g, " ") ?? "";
        return promptResult("Create a handoff from this conversation", createInstructions(checks, hint));
      }),
  );
}
