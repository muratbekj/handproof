import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { renderTask } from "../render/task.ts";
import { PAYLOADS, TaskInput, TaskStatus } from "../schema/task.ts";
import { type TaskService, toTaskSummary } from "../service/tasks.ts";
import { looseInput, parseArgs } from "./input.ts";
import { fromResult, safely, toolErr } from "./result.ts";

const Id = z.string().min(1).describe("Task id, e.g. t_01JC3Z…");

/** "from>to: field, field" per lead move, generated from the payload schemas so it can't drift. */
const MOVE_FIELDS = Object.entries(PAYLOADS)
  .map(([move, schema]) => `${move.replace(">", " → ")}: ${Object.keys(schema.shape).join(", ")}`)
  .join("; ");

const TransitionArgs = z.object({
  id: Id,
  to: TaskStatus.describe("The state to move to"),
  payload: z.record(z.string(), z.unknown()).describe("The fields this move requires (see the tool description)"),
});
const GetArgs = z.object({ id: Id });
const ListArgs = z.object({
  status: z.array(TaskStatus).optional().describe("Statuses to include; default is every status except done and cancelled"),
  limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
});

/** task_create, task_transition, task_get, task_list. Approve, reject and cancel are CLI-only on purpose. */
export function registerTaskTools(server: McpServer, tasks: TaskService): void {
  server.registerTool(
    "task_create",
    {
      description:
        "Create a task: one per goal, tracked from research to done. risk low lets you skip research and, " +
        "if nothing CRITICAL/HIGH or UNVERIFIED came up, the final human review.",
      inputSchema: looseInput(TaskInput),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (raw) => safely("task_create", () => fromResult(tasks.create(raw), (t) => ({ task: toTaskSummary(t) }))),
  );

  server.registerTool(
    "task_transition",
    {
      description:
        "Move a task you created to its next state with the payload that move requires. Moves and payload fields: " +
        `${MOVE_FIELDS}. At awaiting_plan_approval, blocked and awaiting_human_review only a human can move the ` +
        'task (handproof approve <id> / handproof reject <id> "<why>" on the CLI).',
      inputSchema: looseInput(TransitionArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (raw) =>
      safely("task_transition", () => {
        const args = parseArgs(TransitionArgs, raw);
        if (!args.ok) return toolErr(args.error);
        return fromResult(tasks.transition(args.value.id, args.value.to, args.value.payload), (v) => ({
          task: toTaskSummary(v.task),
          next: v.next,
          waitingOnHuman: v.waitingOnHuman,
        }));
      }),
  );

  server.registerTool(
    "task_get",
    {
      description: "Get one task with its event timeline, linked handoffs and a markdown view.",
      inputSchema: looseInput(GetArgs),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (raw) =>
      safely("task_get", () => {
        const args = parseArgs(GetArgs, raw);
        if (!args.ok) return toolErr(args.error);
        return fromResult(tasks.get(args.value.id), (v) => ({
          task: v.task,
          events: v.events,
          handoffs: v.handoffs,
          markdown: renderTask(v.task, v.events, v.handoffs),
        }));
      }),
  );

  server.registerTool(
    "task_list",
    {
      description: "List tasks as summaries, oldest first.",
      inputSchema: looseInput(ListArgs),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (raw) =>
      safely("task_list", () => {
        const args = parseArgs(ListArgs, raw);
        if (!args.ok) return toolErr(args.error);
        return fromResult(tasks.list(args.value), (list) => ({ tasks: list }));
      }),
  );
}
