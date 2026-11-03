import { McpServer } from "@modelcontextprotocol/server";
import type { Config, RepoPaths } from "./config.ts";
import type { AgentRef } from "./schema/handoff.ts";
import { VERSION } from "./version.ts";

export interface ServerDeps {
  paths: RepoPaths;
  config: Config;
  agent: AgentRef;
}

/**
 * Builds the MCP server. Phase 0: no tools yet.
 * Never write to stdout from server code: it carries the JSON-RPC stream. Log with console.error.
 */
export function createServer(_deps: ServerDeps): McpServer {
  return new McpServer({ name: "handoffs-mcp", version: VERSION });
}
