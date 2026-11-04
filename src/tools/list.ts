import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { Kind, Status } from "../schema/handoff.ts";
import type { HandoffService } from "../service/handoffs.ts";
import { looseInput, parseArgs } from "./input.ts";
import { fromResult, safely, toolErr } from "./result.ts";

const ListArgs = z.object({
  status: z.array(Status).optional().describe("Statuses to include; default is every status except done and cancelled"),
  kind: Kind.optional(),
  to: z.string().optional().describe('Only handoffs addressed to this agent name (or "any")'),
  mine: z.boolean().optional().describe("Only handoffs you created or currently hold"),
  limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
});

export function registerList(server: McpServer, service: HandoffService): void {
  server.registerTool(
    "handoff_list",
    {
      description: "List handoffs as summaries, oldest first, filtered by status, kind, recipient or your involvement.",
      inputSchema: looseInput(ListArgs),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (raw) =>
      safely("handoff_list", () => {
        const args = parseArgs(ListArgs, raw);
        if (!args.ok) return toolErr(args.error);
        return fromResult(service.list(args.value), (handoffs) => ({ handoffs }));
      }),
  );
}
