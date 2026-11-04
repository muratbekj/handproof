import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type HandoffService, toSummary } from "../service/handoffs.ts";
import { HandoffId, looseInput, parseArgs } from "./input.ts";
import { fromResult, safely, toolErr } from "./result.ts";

const ReleaseArgs = z.object({
  id: HandoffId,
  reason: z.string().min(1).max(500).describe("Why you are releasing it (1–500 chars)"),
});

export function registerRelease(server: McpServer, service: HandoffService): void {
  server.registerTool(
    "handoff_release",
    {
      description: "Give a claimed handoff back to the queue so another agent can claim it.",
      inputSchema: looseInput(ReleaseArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (raw) =>
      safely("handoff_release", () => {
        const args = parseArgs(ReleaseArgs, raw);
        if (!args.ok) return toolErr(args.error);
        return fromResult(service.release(args.value.id, args.value.reason), (h) => ({ handoff: toSummary(h) }));
      }),
  );
}
