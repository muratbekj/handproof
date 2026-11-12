# Codex CLI setup

Codex documents MCP tools, not prompts, so a Codex session uses the tools directly: ask it to *"call the handproof `handoff_claim` tool"* (implementer) or *"call the handproof `handoff_create` tool"* (planner). The `handoff_claim` reply includes the working rules and the exact `handoff_submit` call to make.

## One Codex session

```bash
codex mcp add handproof --env HANDPROOF_AGENT=codex-impl --env HANDPROOF_HARNESS=codex -- bunx handproof serve
```

This writes the server to `~/.codex/config.toml`, so every Codex session on this machine uses the agent name `codex-impl`.

## Several Codex sessions (planner + implementer)

Each session needs its own agent name. Give each one its own git worktree and put a project config in it. Codex reads `.codex/config.toml` in trusted projects.

```bash
git worktree add ../myrepo-impl
```

`.codex/config.toml` in the main checkout (planner):

```toml
[mcp_servers.handproof]
command = "bunx"
args = ["handproof", "serve"]

[mcp_servers.handproof.env]
HANDPROOF_AGENT = "codex-planner"
HANDPROOF_HARNESS = "codex"
```

`.codex/config.toml` in `../myrepo-impl` (implementer): the same, with `HANDPROOF_AGENT = "codex-impl"`.

Add `.codex/` to `.gitignore`: the scope check counts untracked files that aren't ignored, so a per-worktree config that isn't ignored would fail a submit. Both worktrees share one handproof database, and each submit is checked in the implementer's own worktree.

Review from the planner's session (ask it to call `handoff_review`) or from a terminal:

```bash
bunx handproof review <id> accept
```

## Tool approvals

Codex can ask before each MCP tool call. Its per-server setting `default_tools_approval_mode` (`auto`, `prompt`, `writes`, `approve`) controls that; `writes` asks only for tools not marked read-only.

Not verified by us yet: running these exact configs in Codex end to end. If you can run Codex, [issue #9](https://github.com/muratbekj/handproof/issues/9) lists the steps to check and what to report.
