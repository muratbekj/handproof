# handproof

[![npm](https://img.shields.io/npm/v/handproof)](https://www.npmjs.com/package/handproof) [![CI](https://github.com/muratbekj/handproof/actions/workflows/ci.yml/badge.svg)](https://github.com/muratbekj/handproof/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A typed, verifiable handoff contract between coding agents over MCP. One agent packages a task (goal, context, scope, acceptance criteria), another claims it, and the server checks the result before anyone can accept it.


## Requirements

- [Bun](https://bun.sh) ≥ 1.4 and git.
- `bunx handproof` and `npx handproof` both work. The server and CLI always run on Bun (they use `bun:sqlite`), so `npx` needs Bun installed too and prints an install hint if it isn't.

## Quickstart

handproof doesn't care which app plays which role. Every session gets an agent name (`HANDPROOF_AGENT`), and roles come from what that agent does:

- **Planner:** creates a handoff. It's the handoff's creator, so it (or a human) also reviews it.
- **Implementer:** claims the handoff, does the work and submits it. The server then runs the checks.

Any MCP client can take either role: Claude Code, Cursor, Codex, or several sessions of the same app. The steps below work for all of them; [Connect your agents](#connect-your-agents) shows the setup for each app.

In the repository you want to share handoffs in:

```bash
bunx handproof init
$EDITOR .handproof/config.json
```

1. `init` writes `.handproof/config.json` and adds the runtime files to `.gitignore`.
2. Set the commands your checks run (`test`, `typecheck`, `lint`, …) and commit the config.
3. Connect each session with its own agent name, for example a planner and an implementer ([Connect your agents](#connect-your-agents)).
4. **Planner session:** describe the task and say it's for another agent, for example: *"Don't write any code, I'm handing this off: add rate limiting to login. Only touch src/auth. Tests must pass."* Then run the `create` prompt (`/mcp__handproof__create` in Claude Code). In apps without prompt support, ask it to *"call the handproof `handoff_create` tool"*. If you don't say "don't write code", the agent may start doing the task itself.
5. **Implementer session:** run the `pickup` prompt, or ask it to *"call the handproof `handoff_claim` tool"*. The reply has the brief, the working rules and the exact `handoff_submit` call to make when done. The implementer works inside the scope and submits; the server runs the checks and the scope check.
6. **Review:** in the planner's session run the `review` prompt (or ask it to call `handoff_review`), or review from any terminal with `handproof review <id> accept` (the CLI counts as a human).

## Connect your agents

| App | Register the server | Prompts |
| --- | --- | --- |
| Claude Code | `claude mcp add handproof -e HANDPROOF_AGENT=planner -e HANDPROOF_HARNESS=claude-code -- bunx handproof serve` ([`examples/claude-code.md`](examples/claude-code.md)) | Yes: `/mcp__handproof__create`, `/mcp__handproof__pickup`, `/mcp__handproof__review`. One word per argument, so type the task in chat, not after the command. |
| Cursor editor | `.cursor/mcp.json` in the repo ([`examples/cursor.mcp.json`](examples/cursor.mcp.json)) | Yes: type `/` in the Agent chat to find `create`, `pickup` and `review` (checked in Cursor 2.1) |
| Cursor Agent CLI (`cursor-agent`) | the same `.cursor/mcp.json` | Yes: run `/mcp`, select handproof, and its prompts are listed (checked in 2026.11.11) |
| Codex CLI | `codex mcp add handproof --env HANDPROOF_AGENT=codex-impl --env HANDPROOF_HARNESS=codex -- bunx handproof serve`, or a project `.codex/config.toml` ([`examples/codex.md`](examples/codex.md)) | Codex documents MCP tools, not prompts: ask it to call the tools |
| Anything else | any MCP client that starts a stdio server: `bunx handproof serve` with `HANDPROOF_AGENT` set | Use the tools |

`.cursor/mcp.json` for an implementer named `cursor-impl`:

```json
{
  "mcpServers": {
    "handproof": {
      "command": "bunx",
      "args": ["handproof", "serve"],
      "env": { "HANDPROOF_AGENT": "cursor-impl", "HANDPROOF_HARNESS": "cursor" }
    }
  }
}
```

### Several sessions of the same app

Two Codex sessions, or two Claude Code sessions, work the same way as two different apps: each needs its own agent name.

- Give each session its own git worktree (`git worktree add ../myrepo-impl`). All worktrees of a repo share one handproof database, and each submit is checked in the implementer's own worktree, so parallel sessions don't see each other's changes.
- Put each session's config in its worktree: `.cursor/mcp.json`, `.codex/config.toml` (Codex reads it in trusted projects), or for Claude Code run `claude mcp add …` inside that worktree (its default scope is the current directory).
- Add those config folders (`.cursor/`, `.codex/`) to `.gitignore`. The scope check counts untracked files that aren't ignored, so a stray per-worktree config would fail a submit.

Example: Codex only, planner `codex-planner` in the main checkout and implementer `codex-impl` in `../myrepo-impl`, each with its own `.codex/config.toml`; you review with `handproof review <id> accept`.

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
- All state lives in one SQLite file per repository, `.handproof/handoffs.db`. Each harness starts its own stdio server process and every process for the same repo shares that file. There is no daemon.

## Config reference

`.handproof/config.json`, read from disk on every verification. A missing file means the defaults with no checks.

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
| `HANDPROOF_AGENT` | `anonymous` (`human-cli` for the CLI) | Agent name. Processes with the same name are the same agent. Names starting with `human` are humans: they may claim, review or cancel any handoff |
| `HANDPROOF_HARNESS` | `other` | `claude-code`, `cursor`, `codex` or `other` |
| `HANDPROOF_REPO` | the server's working directory | Path to the repository, when the harness starts the server elsewhere |

## Tasks

A handoff is one agent's piece of work. A **task** is the goal those pieces belong to: research, a plan a human approves, build and fix rounds, the final review. A lead agent creates one task per goal, moves it with `task_transition`, and links each handoff it creates (`handoff_create` with `task`). Every move carries a typed payload the server validates, and the whole history lands in the task's timeline.

```
new ─► researching ⇄ planning ─► awaiting_plan_approval ─► building ⇄ verifying ─► awaiting_human_review ─► done
 └──(low risk)──────►┘              (human)                             │              (human)
                                                                        ├─► blocked (human decides)
                                                                        └─► done (low risk)
```

| Move | Who | Payload |
| --- | --- | --- |
| `new` → `researching` | lead | `goal`, `questions[]` |
| `new` → `planning` | lead, low risk only | `goal`, `skip_reason` |
| `researching` → `planning` | lead | `research_file`, `summary`, `unverified[]` |
| `planning` → `researching` | lead | `questions[]` |
| `planning` → `awaiting_plan_approval` | lead | `plan_file`, `brief`, `steps`, `acceptance_criteria`, `security_sensitive[]`, `depends_on_unverified[]` |
| `awaiting_plan_approval` → `building` / `planning` | human: `approve` / `reject` | optional comment / comment |
| `building` → `verifying` | lead | `summary`, `commits[]`, `diff_lines` |
| `verifying` → `building` | lead (one fix round) | `tests{passed, failed, failing[]}`, `blocking[{file, line, problem, fix}]`, `security[{file, line, problem, fix, severity}]` (CRITICAL/HIGH/MEDIUM), `wrong_tests[]`, `message_to_builder` |
| `verifying` → `blocked` | lead | `reason`, `tests`, `open[]` |
| `blocked` → `building` / `planning` | human: `approve [--rounds N]` / `reject` | more rounds (default 3) / comment |
| `verifying` → `awaiting_human_review` | lead | `tests` (0 failed), `review_verdict: "APPROVE"`, `security_verdict: "PASS"`, `nits[]`, `low_findings[]`, `unverified[]`, `brief` |
| `verifying` → `done` | lead, low risk only | same, without `brief` |
| `awaiting_human_review` → `done` / `building` | human: `approve` / `reject` | optional comment / comment (no fix round used) |
| any unfinished → `cancelled` | human: `task cancel` | reason |

Rules the server enforces:

- **Only a human leaves a gate.** `awaiting_plan_approval`, `blocked` and `awaiting_human_review` have no MCP move at all; `handproof approve` and `handproof reject` (identity `human-…`) are the only way out. The comment is stored word for word.
- **At most 3 fix rounds** (`verifying` → `building`) per approved plan; the 4th is refused with `round_limit`, and the lead moves the task to `blocked`. A round with nothing to fix is refused.
- **Low-risk shortcuts:** skipping research and finishing without the human review need risk `low`; finishing early is also refused once any CRITICAL or HIGH security finding was recorded, or while UNVERIFIED findings are open.
- **Payloads are strict.** Unknown or misspelt fields, oversized text, and missing files (`research_file`, `plan_file`) come back as field-level issues; payload text gets the same secret scan as handoffs.
- Approving the plan records the commit at that moment (`plan approved at …` in `task show`), so "the diff since the plan was approved" has a fixed base.
- Handoffs can't be linked to a `done` or `cancelled` task. The server never blocks a task move because of a linked handoff; the lead checks those.

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
| `task_create` | any agent | A new task (`goal`, `risk` low or normal) in `new`; the caller becomes its lead |
| `task_transition` | the task's creator | One lead move with its payload (see [Tasks](#tasks)); replies with the next allowed moves |
| `task_get` | any agent | One task with its timeline, linked handoffs and markdown |
| `task_list` | any agent | Task summaries (default: unfinished) |

`handoff_create` takes an optional `task` id, and `handoff_list` an optional `task` filter.

### Resources

| Resource | Who may read it | Content |
| --- | --- | --- |
| `handoff://inbox` | any agent | Open handoffs addressed to you or `any`, in claim order |
| `handoff://{id}` | any agent | The markdown brief of one handoff |
| `task://{id}` | any agent | One task as markdown: status, rounds, every move with its payload, linked handoffs |

### Prompts

In Claude Code the prompts are `/mcp__handproof__create`, `/mcp__handproof__pickup` and `/mcp__handproof__review`; the Cursor editor shows them in the Agent chat's `/` menu, and the Cursor Agent CLI under `/mcp` → handproof. Every argument is optional and a single word. Clients without prompt support (Codex, as far as its docs say) can use the tools directly: `handoff_claim`'s reply ends with the same working rules and `handoff_submit` call that `pickup` gives.

| Prompt | Arguments | Effect |
| --- | --- | --- |
| `create` | `request` | No side effect. Tells the agent to package the task from the conversation into one `handoff_create` call, listing the configured checks and the kinds |
| `pickup` | `id` | **Claims**: returns the handoff you already hold, or claims the next one (or `id`), with its brief, working rules and the exact `handoff_submit` call |
| `review` | `id`, `decision` (`accept` or `reject`) | No side effect. Shows a verified handoff you may review and the `handoff_review` call to make; a reject reason comes from the chat |

## CLI

The CLI acts as `human-cli` unless `HANDPROOF_AGENT` is set.

```bash
handproof init                               # write .handproof/config.json and .gitignore lines
handproof serve                              # run the MCP server over stdio
handproof ls [--all] [--status open,claimed]     # table of handoffs
handproof show <id>                              # markdown brief
handproof review <id> accept|reject [reason...]  # accept or reject a verified handoff
handproof prune [--older-than 30d] [--dry-run]   # delete old check logs of done/cancelled handoffs
handproof wait <id>... [--until verified,changes_requested] [--timeout 30m]
                                                # block until a status changes (or reaches --until)
handproof task ls [--all] [--status s,...]       # table of tasks
handproof task show <id>                         # one task as markdown
handproof task cancel <id> <reason...>           # cancel a task (human)
handproof approve <id> [--rounds N] [comment...] # pass a task's gate (human)
handproof reject <id> <comment...>               # send a task back from its gate (human)
```


`handproof prune` deletes the check log files under `.handproof/runs/<id>/` of handoffs that are `done` or `cancelled` and finished at least 30 days ago (`--older-than <N>d` changes that; `0d` prunes all of them). `--dry-run` lists what would be deleted and deletes nothing. Each pruned handoff gets a `logs_pruned` event, and its brief shows `log pruned` instead of the log path. Run directories without a handoff (e.g. after deleting the database) are removed once all their files are older than the cutoff. Handoff rows and events are never deleted.

`handproof wait` polls the database once a second (no tokens spent while it waits) and prints `<id> <status>` for each handoff that met the condition. Without `--until` it returns when any given handoff's status differs from its status at start; with `--until <s>[,<s>]` it returns when one is in that set (immediately if one already is). Each poll first expires lapsed leases, so a crashed claimant doesn't leave it hanging. `--timeout <N>s|<N>m|<N>h` gives up after that long: every id is printed with `(timeout)` and the exit code is 124. Ctrl-C exits with 130.

### Disk usage

Check logs grow with every verification run, up to 1 MiB per check run, under `.handproof/runs/`. Use `handproof prune` to remove old ones (default: older than 30 days). The database stays small and is never pruned.

## Security

- A handoff never carries a shell command. It can only name a check defined in `.handproof/config.json`, which the repo owner commits. Checks run without a shell, with a timeout, and with output capped at the last 1 MiB per run (logged under `.handproof/runs/`).
- `.handproof/config.json` is protected: an implementer who edits it fails the scope check.
- Handoff text from another agent is wrapped in a labelled `<handoff-data>` block that says it is data, not instructions. Text inside it can't close or open that block.
- Before a handoff, result or note is stored, it is scanned for obvious secrets (AWS keys, `sk-` tokens, GitHub tokens, private key headers) and refused with the matching path.
- Paths and scope globs are normalized to repo-relative POSIX paths and rejected if they resolve outside the repo.
- stdio only: the server opens no network listener.

## In practice

One real multi-agent build ran 50 handoffs over about two days (November 9–12, 2026). That's a small sample, but every number below comes from its handoff database:

- 10 of 61 submissions (16%) failed verification: 7 for editing files outside the handoff's scope, 3 for failing checks.
- 7 more passed verification and were still rejected by the lead agent that created them. In one, a commit carried a `Co-authored-by: Cursor` trailer the project didn't allow, and no check looked for it.
- 44 handoffs ended `done` and 6 were cancelled.

Verification catches only what its checks and scope rules cover. Review the diff before accepting (see [Known limitations](#known-limitations)).

## Known limitations

- **Verification runs in the calling agent's worktree.** Checks and the scope diff run where the agent that submits (or calls `handoff_verify`) is checked out. If the implementer works in a different worktree from the reviewer, the reviewer's `handoff_verify` checks the reviewer's files.
- **A process that escapes its process group can outlive a timeout.** On timeout the whole process group is killed, but a check that starts a grandchild with `setsid()` puts it in a new session the kill doesn't reach.
- **Files in scope can weaken a check.** Checks run the implementer's checkout, so if `scope.allowed` covers what a check runs (`package.json` scripts, test files, test config), an implementer could make it pass trivially. Scope is the only guard: keep those files out of `scope.allowed` unless the task is about them.
- **Checks prove only what they run.** Acceptance items without a `check` are the agent's own report (`result.criteria`). Read the diff before accepting.
- **A review handoff ends `verified` whenever its checks pass,** even if the reviewer's verdict is CHANGES NEEDED. The verdict lives in `result.summary`; read it before accepting.
- **Windows is untested.** Paths are normalized to POSIX internally, but CI runs on macOS and Linux only.

## Manual cross-harness check

Run by a human; not automated.

1. Configure both harnesses in the same repo: Claude Code as `planner` and Cursor as `cursor-impl` (see [`examples/`](examples/)).
2. In Claude Code, describe a small task, say not to write code because it's being handed off, and run `/mcp__handproof__create`; the agent calls `handoff_create`. Note the returned id.
3. In Cursor, call `handoff_list`; the same id appears.
4. In Cursor, call `handoff_claim` with that id (or, in the Cursor editor, run the `pickup` prompt); it returns `claimed`, the markdown brief and the `handoff_submit` call to make.
5. In a terminal, run `handproof show <id>`; it shows the handoff claimed by `cursor-impl`.

## Contributing

Bug reports, client setup checks and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the checks to run and what a PR needs. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

- **Unchecked clients:** if you can run Codex, [#9](https://github.com/muratbekj/handproof/issues/9) lists what to check. For another client, use the *Client setup report* issue form.
- **Security issues:** report them privately from the **Security** tab, not in a public issue.

## License

[MIT](LICENSE)
