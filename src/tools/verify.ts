import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { HandoffService } from "../service/handoffs.ts";
import { HandoffId, looseInput, parseArgs } from "./input.ts";
import { fromResult, safelyAsync, toolErr } from "./result.ts";

const VerifyArgs = z.object({ id: HandoffId });

export function registerVerify(server: McpServer, service: HandoffService): void {
  server.registerTool(
    "handoff_verify",
    {
      description:
        "Re-run a handoff's checks and scope diff on demand without changing its status (claimant, creator or human). " +
        "Runs the checks, so it may take minutes.",
      inputSchema: looseInput(VerifyArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (raw) =>
      safelyAsync("handoff_verify", async () => {
        const args = parseArgs(VerifyArgs, raw);
        if (!args.ok) return toolErr(args.error);
        return fromResult(await service.verify(args.value.id), (v) => ({ verification: v.verification }));
      }),
  );
}
