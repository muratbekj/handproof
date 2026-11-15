import { createInstructions } from "./render/create.ts";

/**
 * Cursor custom commands written by `init`. The Cursor Agent CLI lists Markdown files in
 * `.cursor/commands/` as `/` commands, but shows MCP prompts only under `/mcp`, so these give Cursor users
 * `/handproof-create`, `/handproof-pickup` and `/handproof-review`. The file name is the command name and the
 * first heading is its description. Text typed after the command is appended to the end of the message.
 */
export const CURSOR_COMMANDS_DIR = ".cursor/commands";

const TYPED_AFTER = "Text the user typed after the command, if any, appears at the end of this message.";

const create = [
  "# Hand off the task in this chat with handproof",
  "",
  `${TYPED_AFTER} Treat it as part of the task description.`,
  "",
  createInstructions(null, ""),
].join("\n");

const pickup = [
  "# Claim a handproof handoff and work on it",
  "",
  TYPED_AFTER,
  "",
  "Call the handproof `handoff_claim` tool. If the text after the command contains a handoff id (it starts with `h_`), pass it as `id`; otherwise call it with no arguments to take the next open handoff addressed to you.",
  "",
  "The reply is the handoff's brief, the working rules and the exact `handoff_submit` call to make when you're done. Follow them: change only the files the scope allows, then make that submit call.",
  "",
  "If the call fails (nothing to claim, already claimed, not addressed to you), tell the user what it said and stop.",
].join("\n");

const review = [
  "# Review a verified handproof handoff",
  "",
  TYPED_AFTER,
  "",
  "1. Find the handoff. If the text after the command contains a handoff id (it starts with `h_`), use it. Otherwise call the handproof `handoff_list` tool with `status: [\"verified\"]` and `mine: true`; if there are several, list them and ask the user which one.",
  "2. Call `handoff_get` with that id. Only a `verified` handoff can be reviewed; if it's in another state, tell the user and stop.",
  "3. Check the Result summary and the Verification section against the Goal and every Acceptance item, and tell the user what you found.",
  "4. If the text after the command says `accept` or `reject`, that is the user's decision; otherwise ask the user.",
  "   - Accept: call `handoff_review` with `{ \"id\": \"<id>\", \"decision\": \"accept\" }`.",
  "   - Reject: call `handoff_review` with `{ \"id\": \"<id>\", \"decision\": \"reject\", \"reason\": \"<reason>\" }`. The reason comes from the user; if they haven't given one, ask. Never invent a reason.",
].join("\n");

/** File name → content, for each command under `.cursor/commands/`. */
export const CURSOR_COMMANDS: Readonly<Record<string, string>> = {
  "handproof-create.md": `${create}\n`,
  "handproof-pickup.md": `${pickup}\n`,
  "handproof-review.md": `${review}\n`,
};
