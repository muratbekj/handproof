import type { Task } from "../schema/task.ts";
import type { HandoffSummary } from "../service/handoffs.ts";
import type { TaskEvent } from "../store/task-repo.ts";
import { wrapUntrusted } from "./markdown.ts";

const NONE = "_none_";

function indent(text: string, by: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => (l === "" ? "" : `${by}${l}`))
    .join("\n");
}

/** One payload field as a nested list item; multi-line text and objects go on indented lines below. */
function field(key: string, value: unknown): string {
  if (typeof value === "string") {
    return value.includes("\n") ? `  - **${key}:**\n${indent(value, "    ")}` : `  - **${key}:** ${value}`;
  }
  if (typeof value === "number" || typeof value === "boolean") return `  - **${key}:** ${String(value)}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `  - **${key}:** ${NONE}`;
    const items = value.map((v) => `    - ${typeof v === "string" ? v.replace(/\r?\n/g, " ") : JSON.stringify(v)}`);
    return `  - **${key}:**\n${items.join("\n")}`;
  }
  return `  - **${key}:** ${JSON.stringify(value)}`;
}

function eventItem(e: TaskEvent): string {
  const d = e.data;
  const head = `- ${e.at} **${e.actor}** ${e.type}`;
  switch (e.type) {
    case "moved": {
      const payload = (d.payload ?? {}) as Record<string, unknown>;
      const fields = Object.entries(payload).map(([k, v]) => field(k, v));
      return [`${head}: ${String(d.from)} → ${String(d.to)}`, ...fields].join("\n");
    }
    case "approved":
    case "rejected": {
      const extra = [
        typeof d.comment === "string" ? field("comment", d.comment) : null,
        typeof d.rounds === "number" ? field("rounds granted", d.rounds) : null,
        typeof d.planCommit === "string" ? field("plan commit", d.planCommit) : null,
      ].filter((x): x is string => x !== null);
      return [`${head}: ${String(d.from)} → ${String(d.to)}`, ...extra].join("\n");
    }
    case "cancelled":
      return [`${head}: ${String(d.from)} → cancelled`, field("reason", d.reason)].join("\n");
    case "handoff_linked":
      return `${head}: \`${String(d.handoff)}\` (${String(d.kind)}) ${String(d.title)}`;
    default:
      return head;
  }
}

function handoffTable(hs: HandoffSummary[]): string {
  if (hs.length === 0) return NONE;
  const cell = (t: string): string => t.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  return [
    "| id | status | kind | to | title |",
    "| --- | --- | --- | --- | --- |",
    ...hs.map((h) => `| \`${h.id}\` | ${h.status} | ${h.kind} | ${cell(h.to)} | ${cell(h.title)} |`),
  ].join("\n");
}

/** The task as markdown: server-set header, then goal, timeline and handoffs inside the untrusted-data block. */
export function renderTask(t: Task, events: TaskEvent[], handoffs: HandoffSummary[]): string {
  const meta =
    `\`${t.id}\` · **Status:** ${t.status} · **Risk:** ${t.risk} · **Rounds:** ${t.rounds.used}/${t.rounds.limit}` +
    ` · **From:** ${t.from.name} (${t.from.harness})`;
  const plan = t.planCommit === null ? "_plan not approved yet_" : `plan approved at ${t.planCommit.slice(0, 12)}`;
  const repoLine = `**Repo:** ${t.repo.branch} · ${plan}`;
  const body = [
    `## Goal\n${t.goal}`,
    `## Timeline\n${events.length === 0 ? NONE : events.map(eventItem).join("\n")}`,
    `## Handoffs\n${handoffTable(handoffs)}`,
  ].join("\n\n");
  return [`# Task ${t.id}`, `${meta}\n${repoLine}`, wrapUntrusted(t.id, body)].join("\n\n");
}
