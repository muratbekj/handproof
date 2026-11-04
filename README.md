# handoffs-mcp

A typed, verifiable handoff contract between coding agents over MCP. One agent packages a task (goal, context, scope, acceptance criteria), another claims it, and the server checks the result before anyone can accept it.

<!-- demo.gif goes here (T16) -->

The demo shows Claude Code handing a task to Cursor, Cursor's out-of-scope `package.json` edit being caught by verification, the fix, and the accept.

## Requirements

- [Bun](https://bun.sh) ≥ 1.4 and git.
- Run it with `bunx`, not `npx`: the server and CLI run on Bun (they use `bun:sqlite`).

## Quickstart

In the repository you want to share handoffs in:

```bash
bunx handoffs-mcp init
$EDITOR .handoffs/config.json
claude mcp add handoffs -e HANDOFFS_AGENT=planner -e HANDOFFS_HARNESS=claude-code -- bunx handoffs-mcp serve
mkdir -p .cursor && $EDITOR .cursor/mcp.json
```

1. `init` writes `.handoffs/config.json` and adds the runtime files to `.gitignore`.
2. Set the commands your checks run (`test`, `typecheck`, `lint`, …) and commit the config.
3. Register the server in Claude Code as agent `planner` (more in [`examples/claude-code.md`](examples/claude-code.md)).
4. Register it in Cursor as agent `cursor-impl`, in `.cursor/mcp.json` (same as [`examples/cursor.mcp.json`](examples/cursor.mcp.json)):
   ```json
   {
     "mcpServers": {
       "handoffs": {
         "command": "bunx",
         "args": ["handoffs-mcp", "serve"],
         "env": { "HANDOFFS_AGENT": "cursor-impl", "HANDOFFS_HARNESS": "cursor" }
       }
     }
   }
   ```
5. In Claude Code, describe the task in chat and say it's for another agent, for example: *"Don't write any code, I'm handing this off: add rate limiting to login. Only touch src/auth. Tests must pass."* Then run `/mcp__handoffs__handoff`. Claude Code passes only one word per prompt argument, so type the task in chat, not after the command. If you don't say "don't write code", Claude Code may start doing the task itself.
6. In Cursor, pick the handoff up:
   - **Cursor editor:** run the handoffs `pickup` prompt from the chat's `/` menu.
   - **Cursor Agent CLI** (`cursor-agent`): it doesn't support MCP prompts, so ask it to *"call the handoffs `handoff_claim` tool"*. The reply has the same brief, working rules and `handoff_submit` call as `pickup`.

   Cursor works inside the scope and calls `handoff_submit`. Back in Claude Code, run `/mcp__handoffs__review` to accept or reject the verified result.

## How it works

Every handoff moves through seven states:

| From | To | How |
| --- | --- | --- |
| `open` | `claimed` | an implementer claims it and takes a lease |
| `open` | `cancelled` | the creator or a human cancels it |
| `claimed`, `changes_requested` | `submitted` | the claimant submits |
| `claimed`, `changes_requested` | `open` | the claimant releases it, or the lease expires |
| `submitted` | `verified` | every check passes, scope is clean, every criterion is met |
| `submitted` | `changes_requested` | verification fails (or is interrupted) |
| `verified` | `done` | the creator or a human accepts |
| `verified` | `open` | the creator or a human rejects, with a reason |

- `open`: waiting for an implementer. `claimed`: an agent holds a lease on it. `submitted`: verification is running. `changes_requested`: a check or the scope check failed; the implementer fixes and resubmits. `verified`: every check passed, scope is clean, every criterion is met. `done` and `cancelled` are final.
- The only path to `done` runs through `verified`: an accept is refused on anything that hasn't passed verification.
- Verification runs automatically on `handoff_submit`: each check named by an acceptance item, then a scope check of every file changed since the handoff's base commit (committed, staged, unstaged and untracked). Uncommitted changes that already existed when the handoff was created are recorded with their content hash and ignored unless they change afterwards.
- Leases (default 30 minutes) are renewed by any call the claimant makes; a lapsed lease reopens the handoff.
- All state lives in one SQLite file per repository, `.handoffs/handoffs.db`. Each harness starts its own stdio server process and every process for the same repo shares that file. There is no daemon.

## Config reference

`.handoffs/config.json`, read from disk on every verification. A missing file means the defaults with no checks.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `leaseMinutes` | positive integer | `30` | How long a claim lasts without a call from the claimant |
| `checks` | object | `{}` | Named checks; each name must match `^[a-z][a-z0-9_-]*$` |
| `checks.<name>.run` | non-empty string | (required) | The command. Split into words like a shell would, but run without a shell: no pipes, globs, `&&` or variable expansion |
| `checks.<name>.timeoutSec` | positive integer | `300` | Seconds before the check is killed and counted as failed |

`init` writes:

```json
{
  "leaseMinutes": 30,
  "checks": {
    "test": { "run": "bun test", "timeoutSec": 300 },
    "typecheck": { "run": "bunx tsc --noEmit", "timeoutSec": 120 },
    "lint": { "run": "bunx eslint .", "timeoutSec": 120 }
  }
}
```

Environment variables, set per harness in its MCP config:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HANDOFFS_AGENT` | `anonymous` (`human-cli` for the CLI) | Agent name. Processes with the same name are the same agent. Names starting with `human` are humans: they may claim, review or cancel any handoff |
| `HANDOFFS_HARNESS` | `other` | `claude-code`, `cursor`, `codex` or `other` |
| `HANDOFFS_REPO` | the server's working directory | Path to the repository, when the harness starts the server elsewhere |

## Tools, resources, prompts

### Tools

| Tool | Who may call it | Effect |
| --- | --- | --- |
| `handoff_create` | any agent | Validates and stores a new `open` handoff; returns its id, warnings and the count of pre-existing changes |
| `handoff_list` | any agent | Summaries, filtered by status, kind, recipient or your involvement |
| `handoff_get` | any agent | One handoff with its event timeline and markdown brief |
| `handoff_claim` | an agent the handoff is addressed to (`to` is its name or `any`), or a human | `open` → `claimed` with a lease; with no id, claims the next one for you. Replies with the brief, working rules and the `handoff_submit` call to make |
| `handoff_update` | the claimant | Adds a progress note and renews the lease |
| `handoff_release` | the claimant | Gives it back: → `open` |
| `handoff_cancel` | the creator or a human | `open` → `cancelled` (final) |
| `handoff_submit` | the claimant | Records the result and runs verification: → `verified` or `changes_requested` |
| `handoff_verify` | the claimant, the creator or a human | Re-runs verification and logs it; never changes status |
| `handoff_review` | the creator or a human | `verified` → `done` (accept) or → `open` (reject, with a reason that is added to `context.tried`) |

### Resources

| Resource | Who may read it | Content |
| --- | --- | --- |
| `handoff://inbox` | any agent | Open handoffs addressed to you or `any`, in claim order |
| `handoff://{id}` | any agent | The markdown brief of one handoff |

### Prompts

In Claude Code the prompts are `/mcp__handoffs__handoff`, `/mcp__handoffs__pickup` and `/mcp__handoffs__review`. Every argument is optional and a single word. Clients without prompt support (such as the Cursor Agent CLI) can use the tools directly: `handoff_claim`'s reply ends with the same working rules and `handoff_submit` call that `pickup` gives.

| Prompt | Arguments | Effect |
| --- | --- | --- |
| `handoff` | `request` | No side effect. Tells the agent to package the task from the conversation into one `handoff_create` call, listing the configured checks and the kinds |
| `pickup` | `id` | **Claims**: returns the handoff you already hold, or claims the next one (or `id`), with its brief, working rules and the exact `handoff_submit` call |
| `review` | `id`, `decision` (`accept` or `reject`) | No side effect. Shows a verified handoff you may review and the `handoff_review` call to make; a reject reason comes from the chat |

## CLI

The CLI acts as `human-cli` unless `HANDOFFS_AGENT` is set.

```bash
handoffs-mcp init                               # write .handoffs/config.json and .gitignore lines
handoffs-mcp serve                              # run the MCP server over stdio
handoffs ls [--all] [--status open,claimed]     # table of handoffs
handoffs show <id>                              # markdown brief
handoffs review <id> accept|reject [reason...]  # accept or reject a verified handoff
```

`handoffs` and `handoffs-mcp` are the same binary.

## Security

- A handoff never carries a shell command. It can only name a check defined in `.handoffs/config.json`, which the repo owner commits. Checks run without a shell, with a timeout, and with output capped at the last 1 MiB per run (logged under `.handoffs/runs/`).
- `.handoffs/config.json` is protected: an implementer who edits it fails the scope check.
- Handoff text from another agent is wrapped in a labelled `<handoff-data>` block that says it is data, not instructions. Text inside it can't close or open that block.
- Before a handoff, result or note is stored, it is scanned for obvious secrets (AWS keys, `sk-` tokens, GitHub tokens, private key headers) and refused with the matching path.
- Paths and scope globs are normalized to repo-relative POSIX paths and rejected if they resolve outside the repo.
- stdio only: the server opens no network listener.

## Known limitations

- **Verification runs in the calling agent's worktree.** Checks and the scope diff run where the agent that submits (or calls `handoff_verify`) is checked out. If the implementer works in a different worktree from the reviewer, the reviewer's `handoff_verify` checks the reviewer's files.
- **A process that escapes its process group can outlive a timeout.** On timeout the whole process group is killed, but a check that starts a grandchild with `setsid()` puts it in a new session the kill doesn't reach.
- **Windows is untested.** Paths are normalized to POSIX internally, but CI runs on macOS and Linux only.

## Manual cross-harness check

Run by a human; not automated.

1. Configure both harnesses in the same repo: Claude Code as `planner` and Cursor as `cursor-impl` (see [`examples/`](examples/)).
2. In Claude Code, describe a small task, say not to write code because it's being handed off, and run `/mcp__handoffs__handoff`; the agent calls `handoff_create`. Note the returned id.
3. In Cursor, call `handoff_list`; the same id appears.
4. In Cursor, call `handoff_claim` with that id (or, in the Cursor editor, run the `pickup` prompt); it returns `claimed`, the markdown brief and the `handoff_submit` call to make.
5. In a terminal, run `handoffs show <id>`; it shows the handoff claimed by `cursor-impl`.
