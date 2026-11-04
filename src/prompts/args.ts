import type { GetPromptResult } from "@modelcontextprotocol/server";
import { thrownProtocolError } from "../rpc-error.ts";

export interface ParsedTokens {
  id?: string;
  decision?: "accept" | "reject";
  rest: string;
}

/**
 * Order-lenient parse of prompt arguments. Claude Code zips slash-line tokens onto the declared
 * arguments positionally, so `/review accept` arrives as `{ id: "accept" }`: every value is split on
 * whitespace, the first `h_…` token is the id, the first accept/reject (any case) is the decision.
 */
export function parseTokens(values: (string | undefined)[]): ParsedTokens {
  const tokens = values
    .filter((v): v is string => v !== undefined)
    .join(" ")
    .split(/\s+/)
    .filter((t) => t !== "");
  const out: ParsedTokens = { rest: "" };
  const rest: string[] = [];
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (out.id === undefined && t.startsWith("h_")) out.id = t;
    else if (out.decision === undefined && (lower === "accept" || lower === "reject")) out.decision = lower;
    else rest.push(t);
  }
  out.rest = rest.join(" ");
  return out;
}

/** One user message holding `text`. */
export function promptResult(description: string, text: string): GetPromptResult {
  return { description, messages: [{ role: "user", content: { type: "text", text } }] };
}

/** A tool call the agent should make, as the fenced block it copies: `name {json}`. */
export { toolCallBlock } from "../render/work.ts";

/** Runs a prompt callback; anything thrown reaches the client as a JSON-RPC error (see rpc-error.ts). */
export function promptSafely(name: string, fn: () => GetPromptResult): GetPromptResult {
  try {
    return fn();
  } catch (err) {
    throw thrownProtocolError(name, err);
  }
}
