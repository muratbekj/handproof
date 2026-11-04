import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type HandoffService, toSummary } from "../service/handoffs.ts";
import { HandoffId, looseInput, parseArgs } from "./input.ts";
import { fromResult, safely, toolErr } from "./result.ts";

const CancelArgs = z.object({
  id: HandoffId,
  reason: z.string().min(1).max(500).optional().describe("Why it is cancelled (1–500 chars)"),
});

export function registerCancel(server: McpServer, service: HandoffService): void {
  server.registerTool(
    "handoff_cancel",
    {
      description: "Cancel an open handoff you created (humans may cancel any open handoff); this is final.",
      inputSchema: looseInput(CancelArgs),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (raw) =>
      safely("handoff_cancel", () => {
        const args = parseArgs(CancelArgs, raw);
        if (!args.ok) return toolErr(args.error);
        return fromResult(service.cancel(args.value.id, args.value.reason), (h) => ({ handoff: toSummary(h) }));
      }),
  );
}
