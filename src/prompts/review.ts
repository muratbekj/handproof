import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { isHuman } from "../config.ts";
import { renderBrief } from "../render/markdown.ts";
import type { AgentRef, Handoff } from "../schema/handoff.ts";
import type { HandoffService, HandoffSummary, Result } from "../service/handoffs.ts";
import { rolesFor } from "../service/roles.ts";
import { serviceProtocolError } from "../rpc-error.ts";
import { parseTokens, promptResult, promptSafely, toolCallBlock } from "./args.ts";

const ArgsSchema = z.object({
  id: z.string().optional().describe("handoff id (h_…) to review; leave empty to pick the one waiting for you"),
  decision: z.string().optional().describe("accept or reject; the reject reason comes from the chat, not from here"),
});

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw serviceProtocolError(r.error);
  return r.value;
}

function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

const STATUS_NEXT: Record<Handoff["status"], string> = {
  open: "it is waiting for an implementer to claim it",
  claimed: "an implementer is working on it; it can be reviewed once it is submitted and verified",
  submitted: "verification is running; review it once it is verified",
  changes_requested: "verification failed and it is waiting on the implementer to fix and resubmit",
  verified: "it is ready for review",
  done: "it was accepted and is closed",
  cancelled: "it was cancelled and is closed",
};

function acceptCall(id: string): string {
  return toolCallBlock("handoff_review", { id, decision: "accept" });
}

function rejectCall(id: string): string {
  return toolCallBlock("handoff_review", { id, decision: "reject", reason: "<reason>" });
}

function reviewText(h: Handoff, brief: string, decision: "accept" | "reject" | undefined, ignored: string): string {
  const lines = [
    `Review ${h.id}. Check the Result summary and the Verification section against the Goal and every Acceptance item before deciding.`,
    "",
    brief,
    "",
  ];
  if (ignored !== "") lines.push(`(Ignored unrecognized arguments: ${ignored}.)`, "");
  if (decision === "accept") {
    lines.push("The user chose to accept. If the result matches the goal, make this call:", "", acceptCall(h.id));
  } else if (decision === "reject") {
    lines.push(
      "The user chose to reject. Take the reason from this conversation; if the user hasn't given one, ask for it. Never invent a reason.",
      "Replace `<reason>` with it and make this call:",
      "",
      rejectCall(h.id),
    );
  } else {
    lines.push(
      "Ask the user whether to accept or reject, then make the matching call. A rejection needs the user's reason in place of `<reason>`; never invent one.",
      "",
      "Accept:",
      "",
      acceptCall(h.id),
      "",
      "Reject:",
      "",
      rejectCall(h.id),
    );
  }
  return lines.join("\n");
}

function table(rows: HandoffSummary[], verifiedAt: (id: string) => string): string {
  return [
    `${rows.length} handoffs are waiting for your review. Run /review <id> with one of these ids:`,
    "",
    "| id | title | implementer | verified at |",
    "| --- | --- | --- | --- |",
    ...rows.map((h) => `| \`${h.id}\` | ${cell(h.title)} | ${cell(h.claimBy ?? "—")} | ${verifiedAt(h.id)} |`),
  ].join("\n");
}

/** `/review`: no status change; renders the brief and the handoff_review call(s) for the agent to make. */
export function registerReviewPrompt(server: McpServer, deps: { agent: AgentRef; service: HandoffService }): void {
  const { agent, service } = deps;
  server.registerPrompt(
    "review",
    {
      title: "Review",
      description: "Review a verified handoff you created and get the accept or reject call",
      argsSchema: ArgsSchema,
    },
    (args) =>
      promptSafely("review prompt", () => {
        const { id: given, decision, rest } = parseTokens([args.id, args.decision]);
        let id = given;
        if (id === undefined) {
          const waiting = unwrap(service.list({ status: ["verified"], limit: 200 })).filter(
            (h) => h.from === agent.name || isHuman(agent),
          );
          if (waiting.length === 0) {
            return promptResult("Review", `Nothing is waiting for review by ${agent.name}: no verified handoffs you may review.`);
          }
          if (waiting.length > 1) {
            const at = (hid: string): string => {
              const ev = service.history(hid).findLast((e) => e.type === "verified");
              return ev?.at ?? "—";
            };
            return promptResult("Review", table(waiting, at));
          }
          id = waiting[0]?.id;
        }
        if (id === undefined) return promptResult("Review", "Nothing is waiting for review.");
        const got = service.get(id);
        if (!got.ok) {
          if (got.error.error === "not_found") return promptResult("Review", `There is no handoff with id ${id}.`);
          throw serviceProtocolError(got.error);
        }
        const { handoff: h, events } = got.value;
        if (h.status !== "verified") {
          return promptResult(
            "Review",
            `${h.id} is ${h.status}, so it can't be reviewed now: ${STATUS_NEXT[h.status]}. Only verified handoffs can be accepted or rejected.`,
          );
        }
        const roles = rolesFor(agent, h);
        if (!roles.has("creator") && !roles.has("human")) {
          return promptResult(
            "Review",
            `Only the creator (${h.from.name}) or a human (an agent named human…) may review ${h.id}. You are ${agent.name}.`,
          );
        }
        return promptResult(`Review ${h.id}`, reviewText(h, renderBrief(h, events), decision, rest));
      }),
  );
}
