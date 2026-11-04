import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Result, ServiceError } from "../service/handoffs.ts";

function textResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

export function toolOk(value: Record<string, unknown>): CallToolResult {
  return textResult(value);
}

export function toolErr(error: ServiceError): CallToolResult {
  return { ...textResult(error), isError: true };
}

export function fromResult<T>(r: Result<T>, wrap: (v: T) => Record<string, unknown>): CallToolResult {
  return r.ok ? toolOk(wrap(r.value)) : toolErr(r.error);
}

/** Runs a handler; an unexpected throw becomes an isError result and the server keeps running. */
export function safely(name: string, fn: () => CallToolResult): CallToolResult {
  try {
    return fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`handoffs: ${name} failed: ${err instanceof Error ? (err.stack ?? message) : message}`);
    return toolErr({ error: "internal_error", message: `${name} failed unexpectedly: ${message}` });
  }
}
