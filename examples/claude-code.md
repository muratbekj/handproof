# Claude Code setup

Run inside the repository you want to share handoffs in:

```bash
claude mcp add handoffs -e HANDOFFS_AGENT=planner -e HANDOFFS_HARNESS=claude-code -- bunx handoffs-mcp serve
```

From a local checkout of handoffs-mcp instead of the published package:

```bash
claude mcp add handoffs -e HANDOFFS_AGENT=planner -e HANDOFFS_HARNESS=claude-code -- bun /abs/path/to/handoffs-mcp/src/bin.ts serve
```

The server finds the repository from its working directory. Set `-e HANDOFFS_REPO=/abs/path/to/repo` if Claude Code starts it elsewhere.

Then describe the task in chat and run `/mcp__handoffs__handoff`. Claude Code passes only one word per prompt argument, so the task goes in the chat, not after the command. Review a verified result with `/mcp__handoffs__review`.
