# handsoff-mcp

Structured handoffs between coding agents over MCP. Agents in different harnesses (Claude Code, Cursor, …) create, claim, update, release and cancel handoffs through MCP tools backed by one SQLite file per repository (`.handoffs/handoffs.db`).

## Setup

```bash
bunx handoffs-mcp init   # writes .handoffs/config.json and .gitignore lines
```

- Claude Code: see [`examples/claude-code.md`](examples/claude-code.md).
- Cursor: copy [`examples/cursor.mcp.json`](examples/cursor.mcp.json) to `.cursor/mcp.json`.

Each harness sets its own `HANDOFFS_AGENT` name; agents with the same name are the same agent.

## CLI

```bash
handoffs ls [--all] [--status open,claimed]   # table of handoffs
handoffs show <id>                            # markdown brief
```

The CLI acts as `human-cli` unless `HANDOFFS_AGENT` is set.

## Manual cross-harness check

Run by a human; not automated.

1. Configure both harnesses in the same repo: Claude Code as `planner` and Cursor as `cursor-impl` (see `examples/`).
2. In Claude Code, ask the agent to call `handoff_create` with a small task. Note the returned id.
3. In Cursor, call `handoff_list`; the same id appears.
4. In Cursor, call `handoff_claim` with that id; it returns `claimed` and the markdown brief.
5. In a terminal, run `handoffs show <id>`; it shows the handoff claimed by `cursor-impl`.
