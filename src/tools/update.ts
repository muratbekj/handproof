import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type HandoffService, toSummary } from "../service/handoffs.ts";
import { HandoffId, looseInput, parseArgs } from "./input.ts";
import { fromResult, safely, toolErr } from "./result.ts";

const UpdateArgs = z.object({
  id: HandoffId,
  note: z.string().min(1).max(2000).describe("Progress note (1–2000 chars)"),
});

export function registerUpdate(server: McpServer, service: HandoffService): void {
  server.registerTool(
    "handoff_update",
    {
      description: "Add a progress note to a handoff you hold; this also renews your lease.",
      inputSchema: looseInput(UpdateArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (raw) =>
      safely("handoff_update", () => {
        const args = parseArgs(UpdateArgs, raw);
        if (!args.ok) return toolErr(args.error);
        return fromResult(service.update(args.value.id, args.value.note), (h) => ({ handoff: toSummary(h) }));
      }),
  );
}
