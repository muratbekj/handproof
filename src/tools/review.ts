import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type HandoffService, REASON_MAX, toSummary } from "../service/handoffs.ts";
import { HandoffId, looseInput, parseArgs } from "./input.ts";
import { fromResult, safely, toolErr } from "./result.ts";

const ReviewArgs = z.object({
  id: HandoffId,
  decision: z.enum(["accept", "reject"]).describe("accept → done; reject → reopened for another attempt"),
  reason: z.string().max(REASON_MAX).optional().describe(`Why (1–${REASON_MAX} chars); required to reject`),
});

export function registerReview(server: McpServer, service: HandoffService): void {
  server.registerTool(
    "handoff_review",
    {
      description:
        "Accept or reject a verified handoff you created (humans may review any). Accept marks it done; reject " +
        "reopens it and records the attempt in context.tried.",
      inputSchema: looseInput(ReviewArgs),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (raw) =>
      safely("handoff_review", () => {
        const args = parseArgs(ReviewArgs, raw);
        if (!args.ok) return toolErr(args.error);
        const { id, decision, reason } = args.value;
        return fromResult(service.review(id, decision, reason), (h) => ({ handoff: toSummary(h) }));
      }),
  );
}
