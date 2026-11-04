import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import type { Config, RepoPaths } from "./config.ts";
import { renderBrief, renderInbox } from "./render/markdown.ts";
import type { AgentRef } from "./schema/handoff.ts";
import type { HandoffService, ServiceError } from "./service/handoffs.ts";
import { registerCancel } from "./tools/cancel.ts";
import { registerClaim } from "./tools/claim.ts";
import { registerCreate } from "./tools/create.ts";
import { registerGet } from "./tools/get.ts";
import { registerList } from "./tools/list.ts";
import { registerRelease } from "./tools/release.ts";
import { registerReview } from "./tools/review.ts";
import { registerSubmit } from "./tools/submit.ts";
import { registerUpdate } from "./tools/update.ts";
import { registerVerify } from "./tools/verify.ts";
import { VERSION } from "./version.ts";

export interface ServerDeps {
  paths: RepoPaths;
  config: Config;
  agent: AgentRef;
  service: HandoffService;
}

const MARKDOWN = "text/markdown";
const NON_TERMINAL = ["open", "claimed", "submitted", "changes_requested", "verified"] as const;

/** Resource callbacks reject with a JSON-RPC error that carries the service error code in `data`. */
function resourceError(err: ServiceError, uri: string): Error {
  if (err.error === "not_found") return new ResourceNotFoundError(uri);
  const data: Record<string, unknown> = { error: err.error };
  if (err.error === "db_busy") data.retryable = true;
  return new ProtocolError(ProtocolErrorCode.InternalError, err.message, data);
}

/**
 * Builds the MCP server: ten handoff tools, the inbox resource and one resource per handoff.
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
  registerSubmit(server, service);
  registerVerify(server, service);
  registerReview(server, service);

  server.registerResource(
    "handoff",
    new ResourceTemplate("handoff://{id}", {
      list: () => {
        const r = service.list({ status: [...NON_TERMINAL], limit: 200 });
        if (!r.ok) throw resourceError(r.error, "handoff://");
        return {
          resources: r.value.map((h) => ({ uri: `handoff://${h.id}`, name: h.title, mimeType: MARKDOWN })),
        };
      },
    }),
    { description: "Markdown brief for one handoff", mimeType: MARKDOWN },
    (uri, { id }) => {
      const r = service.get(String(id));
      if (!r.ok) throw resourceError(r.error, uri.href);
      return { contents: [{ uri: uri.href, mimeType: MARKDOWN, text: renderBrief(r.value.handoff, r.value.events) }] };
    },
  );

  server.registerResource(
    "inbox",
    "handoff://inbox",
    { description: `Open handoffs addressed to ${agent.name} or any`, mimeType: MARKDOWN },
    (uri) => {
      const r = service.inbox();
      if (!r.ok) throw resourceError(r.error, uri.href);
      return { contents: [{ uri: uri.href, mimeType: MARKDOWN, text: renderInbox(agent.name, r.value) }] };
    },
  );

  return server;
}
