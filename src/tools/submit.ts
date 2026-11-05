import type { McpServer } from "@modelcontextprotocol/server";
import { type HandoffService, SubmitInputSchema, toSummary } from "../service/handoffs.ts";
import { HandoffId, looseInput, parseArgs } from "./input.ts";
import { fromResult, safelyAsync, toolErr } from "./result.ts";

const SubmitArgs = SubmitInputSchema.extend({ id: HandoffId });

export function registerSubmit(server: McpServer, service: HandoffService): void {
  server.registerTool(
    "handoff_submit",
    {
      description:
        "Submit your work on a handoff you hold. This runs the configured checks and a scope diff against the repo " +
        "and may take minutes; the handoff ends verified or changes_requested with the verification details.",
      inputSchema: looseInput(SubmitArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (raw) =>
      safelyAsync("handoff_submit", async () => {
        const args = parseArgs(SubmitArgs, raw);
        if (!args.ok) return toolErr(args.error);
        const { id, ...input } = args.value;
        return fromResult(await service.submit(id, input), (v) => ({
          handoff: toSummary(v.handoff),
          verification: v.verification,
        }));
      }),
  );
}
