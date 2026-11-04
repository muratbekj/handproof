import type { McpServer } from "@modelcontextprotocol/server";
import { HandoffInput } from "../schema/handoff.ts";
import { type HandoffService, toSummary } from "../service/handoffs.ts";
import { looseInput } from "./input.ts";
import { fromResult, safely } from "./result.ts";

export function registerCreate(server: McpServer, service: HandoffService): void {
  server.registerTool(
    "handoff_create",
    {
      description:
        "Create a structured handoff (goal, context, scope, acceptance criteria) for another agent to claim.",
      inputSchema: looseInput(HandoffInput),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    // The service validates schema and business rules together, so raw args go straight through.
    (raw) =>
      safely("handoff_create", () =>
        fromResult(service.create(raw), (v) => ({ handoff: toSummary(v.handoff), warnings: v.warnings })),
      ),
  );
}
