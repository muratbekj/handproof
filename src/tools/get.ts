import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { renderBrief } from "../render/markdown.ts";
import type { HandoffService } from "../service/handoffs.ts";
import { HandoffId, looseInput, parseArgs } from "./input.ts";
import { fromResult, safely, toolErr } from "./result.ts";

const GetArgs = z.object({ id: HandoffId });

export function registerGet(server: McpServer, service: HandoffService): void {
  server.registerTool(
    "handoff_get",
    {
      description: "Get one handoff with its event timeline and a markdown brief.",
      inputSchema: looseInput(GetArgs),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (raw) =>
      safely("handoff_get", () => {
        const args = parseArgs(GetArgs, raw);
        if (!args.ok) return toolErr(args.error);
        return fromResult(service.get(args.value.id), (v) => ({
          handoff: v.handoff,
          events: v.events,
          markdown: renderBrief(v.handoff, v.events),
        }));
      }),
  );
}
