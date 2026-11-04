import { McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import type { Config, RepoPaths } from "./config.ts";
import { renderBrief, renderInbox } from "./render/markdown.ts";
import type { AgentRef } from "./schema/handoff.ts";
import type { HandoffService } from "./service/handoffs.ts";
import { registerCancel } from "./tools/cancel.ts";
import { registerClaim } from "./tools/claim.ts";
import { registerCreate } from "./tools/create.ts";
import { registerGet } from "./tools/get.ts";
import { registerList } from "./tools/list.ts";
import { registerRelease } from "./tools/release.ts";
import { registerUpdate } from "./tools/update.ts";
import { VERSION } from "./version.ts";

export interface ServerDeps {
  paths: RepoPaths;
  config: Config;
  agent: AgentRef;
  service: HandoffService;
}

const MARKDOWN = "text/markdown";
const NON_TERMINAL = ["open", "claimed", "submitted", "changes_requested", "verified"] as const;

/**
 * Builds the MCP server: seven handoff tools, the inbox resource and one resource per handoff.
 * Never write to stdout from server code: it carries the JSON-RPC stream. Log with console.error.
 */
export function createServer(deps: ServerDeps): McpServer {
  const { service, agent } = deps;
  const server = new McpServer({ name: "handoffs-mcp", version: VERSION });

  registerCreate(server, service);
  registerList(server, service);
  registerGet(server, service);
  registerClaim(server, service);
  registerUpdate(server, service);
  registerRelease(server, service);
  registerCancel(server, service);

  server.registerResource(
    "handoff",
    new ResourceTemplate("handoff://{id}", {
      list: () => {
        const r = service.list({ status: [...NON_TERMINAL], limit: 200 });
        if (!r.ok) throw new Error(r.error.message);
        return {
          resources: r.value.map((h) => ({ uri: `handoff://${h.id}`, name: h.title, mimeType: MARKDOWN })),
        };
      },
    }),
    { description: "Markdown brief for one handoff", mimeType: MARKDOWN },
    (uri, { id }) => {
      const r = service.get(String(id));
      if (!r.ok) {
        if (r.error.error === "not_found") throw new ResourceNotFoundError(uri.href);
        throw new Error(r.error.message);
      }
      return { contents: [{ uri: uri.href, mimeType: MARKDOWN, text: renderBrief(r.value.handoff, r.value.events) }] };
    },
  );

  server.registerResource(
    "inbox",
    "handoff://inbox",
    { description: `Open handoffs addressed to ${agent.name} or any`, mimeType: MARKDOWN },
    (uri) => {
      const r = service.inbox();
      if (!r.ok) throw new Error(r.error.message);
      return { contents: [{ uri: uri.href, mimeType: MARKDOWN, text: renderInbox(agent.name, r.value) }] };
    },
  );

  return server;
}
