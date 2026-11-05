# Claude Code setup

Run inside the repository you want to share handoffs in:

```bash
claude mcp add handproof -e HANDPROOF_AGENT=planner -e HANDPROOF_HARNESS=claude-code -- bunx handproof serve
```

From a local checkout of handproof instead of the published package:

```bash
claude mcp add handproof -e HANDPROOF_AGENT=planner -e HANDPROOF_HARNESS=claude-code -- bun /abs/path/to/handproof/src/bin.ts serve
```

The server finds the repository from its working directory. Set `-e HANDPROOF_REPO=/abs/path/to/repo` if Claude Code starts it elsewhere.

Then describe the task in chat and run `/mcp__handproof__create`. Claude Code passes only one word per prompt argument, so the task goes in the chat, not after the command. Review a verified result with `/mcp__handproof__review`.
