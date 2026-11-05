import type { Handoff } from "../schema/handoff.ts";

/** A fenced block with the exact tool call to make: `tool {json args}`. */
export function toolCallBlock(tool: string, args: Record<string, unknown>): string {
  return `\`\`\`json\n${tool} ${JSON.stringify(args)}\n\`\`\``;
}

/** The `handoff_submit` call for `h`, filled with its id and one criteria entry per acceptance item. */
export function submitBlock(h: Handoff): string {
  return toolCallBlock("handoff_submit", {
    id: h.id,
    summary: "<what you changed and why>",
    commits: ["<sha>"],
    criteria: h.acceptance.map((a) => ({ id: a.id, met: true, note: "<how you know>" })),
  });
}

/**
 * Working rules for the claimant, ending with the exact submit call (nothing follows its fence).
 * Shared by the `pickup` prompt and the `handoff_claim` tool, so clients without prompt support
 * (e.g. the Cursor Agent CLI) get the same instructions.
 */
export function workRules(h: Handoff, leaseMinutes: number): string {
  const every = Math.max(1, Math.floor(leaseMinutes / 2));
  const checks = [...new Set(h.acceptance.flatMap((a) => (a.check === undefined ? [] : [a.check])))];
  const checkRule =
    checks.length === 0
      ? "- No acceptance item names a check; report each criterion honestly in the submit call."
      : `- Before submitting, run the named checks locally (${checks.map((c) => `\`${c}\``).join(", ")}; commands are in \`.handproof/config.json\`).`;
  return [
    "## How to work",
    "- Stay inside `scope.allowed`; never touch `scope.forbidden`. Files outside scope fail verification.",
    `- Call \`handoff_update\` with a short progress note at least every ${every} minutes, or the lease (${leaseMinutes} min) lapses and the handoff reopens.`,
    checkRule,
    "- If verification returns `changes_requested`, fix what it reports and submit again.",
    "- When done, commit your work and make this call with real values, one `criteria` entry per acceptance item:",
    "",
    submitBlock(h),
  ].join("\n");
}
