import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type RepoPaths, loadConfig } from "../config.ts";
import { isHandoffsError } from "../errors.ts";
import { renderBrief } from "../render/markdown.ts";
import { workRules } from "../render/work.ts";
import type { HandoffService } from "../service/handoffs.ts";
import { HandoffId, looseInput, parseArgs } from "./input.ts";
import { fromResult, safely, toolErr } from "./result.ts";

const ClaimArgs = z.object({
  id: HandoffId.optional().describe(
    'Handoff id to claim; omit to claim the highest-priority open handoff addressed to you or "any"',
  ),
});

/** The markdown is the brief plus the working rules and the exact submit call, for clients without prompt support. */
export function registerClaim(server: McpServer, service: HandoffService, paths: RepoPaths): void {
  server.registerTool(
    "handoff_claim",
    {
      description: "Claim an open handoff, taking a lease on it. Returns its markdown brief, the working rules and the exact handoff_submit call to make when done.",
      inputSchema: looseInput(ClaimArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (raw) =>
      safely("handoff_claim", () => {
        const args = parseArgs(ClaimArgs, raw);
        if (!args.ok) return toolErr(args.error);
        // Config first: a broken config fails the call before the claim's side effect.
        let leaseMinutes: number;
        try {
          leaseMinutes = loadConfig(paths).leaseMinutes;
        } catch (err) {
          if (isHandoffsError(err)) return toolErr({ error: err.code, message: err.message });
          throw err;
        }
        return fromResult(service.claim(args.value.id), (handoff) => ({
          handoff,
          markdown: `${renderBrief(handoff, service.history(handoff.id))}\n\n${workRules(handoff, leaseMinutes)}`,
        }));
      }),
  );
}
