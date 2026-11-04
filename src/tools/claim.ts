import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { renderBrief } from "../render/markdown.ts";
import type { HandoffService } from "../service/handoffs.ts";
import { HandoffId, looseInput, parseArgs } from "./input.ts";
import { fromResult, safely, toolErr } from "./result.ts";

const ClaimArgs = z.object({
  id: HandoffId.optional().describe(
    'Handoff id to claim; omit to claim the highest-priority open handoff addressed to you or "any"',
  ),
});

export function registerClaim(server: McpServer, service: HandoffService): void {
  server.registerTool(
    "handoff_claim",
    {
      description: "Claim an open handoff, taking a lease on it, and return its markdown brief.",
      inputSchema: looseInput(ClaimArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (raw) =>
      safely("handoff_claim", () => {
        const args = parseArgs(ClaimArgs, raw);
        if (!args.ok) return toolErr(args.error);
        return fromResult(service.claim(args.value.id), (handoff) => {
          const full = service.get(handoff.id);
          const events = full.ok ? full.value.events : [];
          return { handoff, markdown: renderBrief(handoff, events) };
        });
      }),
  );
}
