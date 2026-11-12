# Contributing to handproof

Thanks for helping. Bug reports, client setup checks, docs fixes and code are all welcome.

## Before you start

- **Bugs and features:** open an issue first for anything bigger than a small fix, so we can agree on the approach before you write code.
- **Client setups:** if you can run a client that's marked unverified (see the [`needs verification`](https://github.com/muratbekj/handproof/labels/needs%20verification) label), checking it and reporting back is one of the most useful things you can do.
- **Security issues:** don't open a public issue. Report it privately from the repo's **Security** tab → **Report a vulnerability**.

## Set up

You need [Bun](https://bun.sh) ≥ 1.4 and git. Node isn't needed, except to run the npx launcher's tests, which are skipped without it.

```bash
git clone https://github.com/muratbekj/handproof
cd handproof
bun install
```

The tests create throwaway git repos, so git needs a name and email (`git config --global user.name` / `user.email`).

## Check your change

Run all three before you open a PR. CI runs the same three on macOS and Ubuntu, and a PR can't merge until both pass.

```bash
bun test           # the full suite, about 30 seconds
bun run typecheck
bun run lint
```

To try your change in a real client, point the client at your checkout instead of the npm package:

```bash
bun /abs/path/to/handproof/src/bin.ts serve
```

For example, `.cursor/mcp.json` with `"command": "bun"` and `"args": ["/abs/path/to/handproof/src/bin.ts", "serve"]`.

## Where things live

| Path | What's there |
| --- | --- |
| `src/bin.ts` | CLI entry point (`init`, `serve`, `ls`, `show`, …) |
| `src/server.ts`, `src/tools/`, `src/prompts/` | the MCP server, its tools and prompts |
| `src/service/` | handoff and task lifecycles, roles, leases |
| `src/verify/` | checks, the scope diff and the secret scan |
| `src/store/` | SQLite storage and migrations |
| `src/schema/` | zod schemas for handoffs and tasks |
| `bin/handproof.js` | the npm launcher (plain Node, runs the server with Bun) |
| `tests/` | `bun test` suites; shared setup in `tests/helpers/` |
| `examples/` | client configs for Claude Code, Cursor and Codex |

The server code is Bun-only (`bun:sqlite`, `Bun.spawn`, `Bun.Terminal`). Please don't add Node-only dependencies to it.

## Pull requests

- **One change per PR.** A bug fix and a refactor go in separate PRs.
- **Tests:** a behavior change comes with a test that fails without it. A bug fix comes with a test that reproduces the bug.
- **Docs:** if you change a tool, prompt, CLI command, config field or state, update the README in the same PR.
- **Commit messages:** a short prefix and a plain sentence, like the existing history: `feat: …`, `fix: …`, `docs: …`, `test: …`.
- **Merging:** PRs are merged with a merge commit, so your commits stay as you wrote them. Tidy them up before asking for review.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
