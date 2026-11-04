import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type RepoPaths, loadConfig } from "../config.ts";
import { renderBrief } from "../render/markdown.ts";
import type { AgentRef, Handoff } from "../schema/handoff.ts";
import type { HandoffService, Result, ServiceError } from "../service/handoffs.ts";
import { serviceProtocolError } from "../rpc-error.ts";
import { workRules } from "../render/work.ts";
import { parseTokens, promptResult, promptSafely } from "./args.ts";

const ArgsSchema = z.object({
  id: z.string().optional().describe("handoff id (h_…) to claim; leave empty to take the next one addressed to you"),
});

const HELD: Handoff["status"][] = ["claimed", "changes_requested"];

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw serviceProtocolError(r.error);
  return r.value;
}

/** The handoff this agent already holds (oldest first), or null. A service read, so it renews the lease. */
function heldBy(service: HandoffService, agent: AgentRef): string | null {
  const held = unwrap(service.list({ status: HELD, mine: true, limit: 200 }))
    .filter((h) => h.claimBy === agent.name)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return held[0]?.id ?? null;
}

function workText(h: Handoff, brief: string, leaseMinutes: number, lead: string): string {
  return [lead, "", brief, "", workRules(h, leaseMinutes)].join("\n");
}

function refusal(err: ServiceError, id: string | undefined, agent: AgentRef): string | null {
  switch (err.error) {
    case "nothing_to_claim":
      return `No open handoffs for ${agent.name} right now. Check again later with \`handoff_list\` or read the \`handoff://inbox\` resource.`;
    case "already_claimed": {
      const by = typeof err.by === "string" ? err.by : "another agent";
      const until = typeof err.leaseUntil === "string" ? ` until ${err.leaseUntil}` : "";
      return `${id ?? "That handoff"} is already claimed by ${by}${until}. Run /pickup with no id to take the next one.`;
    }
    case "not_found":
      return `There is no handoff with id ${id ?? "(none)"}. Check the id with \`handoff_list\`.`;
    case "not_addressed_to_you":
    case "not_permitted": {
      const to = typeof err.to === "string" ? err.to : null;
      return `${id ?? "That handoff"} is not yours to claim: its \`to\` field names ${to ?? "another agent"}, and only that agent (or \`any\`, or a human) may claim it. You are ${agent.name}.`;
    }
    case "invalid_transition":
      return `${id ?? "That handoff"} can't be claimed: ${err.message}. Only open handoffs can be claimed.`;
    default:
      return null;
  }
}

/** `/pickup`: claims server-side (rendering has a side effect) and returns the brief plus the submit call. */
export function registerPickupPrompt(server: McpServer, deps: { paths: RepoPaths; agent: AgentRef; service: HandoffService }): void {
  const { paths, agent, service } = deps;
  server.registerPrompt(
    "pickup",
    {
      title: "Pick up",
      description: "Claim the next handoff addressed to you (or the one you already hold) and get its brief",
      argsSchema: ArgsSchema,
    },
    (args) =>
      promptSafely("pickup prompt", () => {
        const { id, rest } = parseTokens([args.id]);
        if (id === undefined && rest !== "") {
          return promptResult("Pick up", `\`${rest}\` is not a handoff id (ids start with \`h_\`). Run /pickup with no id to take the next one.`);
        }
        let h: Handoff;
        let lead: string;
        const held = id === undefined ? heldBy(service, agent) : null;
        if (held !== null) {
          h = unwrap(service.get(held)).handoff;
          lead = `You already hold ${h.id} (${h.status}); finish it before taking another.`;
        } else {
          const r = service.claim(id);
          if (!r.ok) {
            const text = refusal(r.error, id, agent);
            if (text === null) throw serviceProtocolError(r.error);
            return promptResult("Pick up", text);
          }
          h = r.value;
          lead = `You claimed ${h.id}. Your lease runs until ${h.claim?.leaseUntil ?? "(unknown)"}.`;
        }
        const leaseMinutes = loadConfig(paths).leaseMinutes;
        const text = workText(h, renderBrief(h, service.history(h.id)), leaseMinutes, lead);
        return promptResult(`Work on ${h.id}`, text);
      }),
  );
}
