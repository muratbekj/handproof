import { McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import type { Config, RepoPaths } from "./config.ts";
import { registerCreatePrompt } from "./prompts/create.ts";
import { registerPickupPrompt } from "./prompts/pickup.ts";
import { registerReviewPrompt } from "./prompts/review.ts";
import { renderBrief, renderInbox } from "./render/markdown.ts";
import { renderTask } from "./render/task.ts";
import { serviceProtocolError } from "./rpc-error.ts";
import type { AgentRef } from "./schema/handoff.ts";
import type { HandoffService, ServiceError } from "./service/handoffs.ts";
import type { TaskService } from "./service/tasks.ts";
import { registerCancel } from "./tools/cancel.ts";
import { registerClaim } from "./tools/claim.ts";
import { registerCreate } from "./tools/create.ts";
import { registerGet } from "./tools/get.ts";
import { registerList } from "./tools/list.ts";
import { registerRelease } from "./tools/release.ts";
import { registerReview } from "./tools/review.ts";
import { registerSubmit } from "./tools/submit.ts";
import { registerTaskTools } from "./tools/tasks.ts";
import { registerUpdate } from "./tools/update.ts";
import { registerVerify } from "./tools/verify.ts";
import { VERSION } from "./version.ts";

export interface ServerDeps {
  paths: RepoPaths;
  config: Config;
  agent: AgentRef;
  service: HandoffService;
  /** Task tools and the task:// resource; omitted only by tests that predate tasks. */
  tasks?: TaskService;
}

const MARKDOWN = "text/markdown";
const NON_TERMINAL = ["open", "claimed", "submitted", "changes_requested", "verified"] as const;

/** Resource callbacks reject with a JSON-RPC error that carries the service error code in `data`. */
function resourceError(err: ServiceError, uri: string): Error {
  return err.error === "not_found" ? new ResourceNotFoundError(uri) : serviceProtocolError(err);
}

/**
 * Builds the MCP server: ten handoff tools, the inbox resource, one resource per handoff and the
 * handoff, pickup and review prompts.
 * Never write to stdout from server code: it carries the JSON-RPC stream. Log with console.error.
 */
export function createServer(deps: ServerDeps): McpServer {
  const { service, agent } = deps;
  const server = new McpServer({ name: "handproof", version: VERSION });

  registerCreate(server, service);
  registerList(server, service);
  registerGet(server, service);
  registerClaim(server, service, deps.paths);
  registerUpdate(server, service);
  registerRelease(server, service);
  registerCancel(server, service);
  registerSubmit(server, service);
  registerVerify(server, service);
  registerReview(server, service);

  registerCreatePrompt(server, deps.paths);
  registerPickupPrompt(server, { paths: deps.paths, agent, service });
  registerReviewPrompt(server, { agent, service });

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

  if (deps.tasks !== undefined) registerTasks(server, deps.tasks);

  return server;
}

function registerTasks(server: McpServer, tasks: TaskService): void {
  registerTaskTools(server, tasks);
  server.registerResource(
    "task",
    new ResourceTemplate("task://{id}", {
      list: () => {
        const r = tasks.list({ limit: 200 });
        if (!r.ok) throw resourceError(r.error, "task://");
        return { resources: r.value.map((t) => ({ uri: `task://${t.id}`, name: t.goal.slice(0, 120), mimeType: MARKDOWN })) };
      },
    }),
    { description: "One task as markdown: status, rounds, timeline with every payload, linked handoffs", mimeType: MARKDOWN },
    (uri, { id }) => {
      const r = tasks.get(String(id));
      if (!r.ok) throw resourceError(r.error, uri.href);
      const { task, events, handoffs } = r.value;
      return { contents: [{ uri: uri.href, mimeType: MARKDOWN, text: renderTask(task, events, handoffs) }] };
    },
  );
}
