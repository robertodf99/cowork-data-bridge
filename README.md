# cowork-data-bridge

An MCP server that lets Claude Cowork (or any MCP client) ask natural-language
questions about a project's data. Each question is answered by Claude Code
running headless (`claude -p`) with the project's repository as context
(schema, domain docs) and a read-only database connection.

Why: a database connector alone does not know what the tables mean. The
project's code and docs do. This bridge gives the answering agent both, and
keeps each project's connection details out of version control.

## How it works

```
server.mjs              MCP server (stdio) and a small CLI
lib.mjs                 project discovery, argument building, runner
projects/_example/      template for a project addon (committed)
projects/<name>/        your project addons (gitignored)
docs/adding-a-project.md
```

A project addon is a folder with four files:

| File | Purpose |
|------|---------|
| `project.json` | `{ "description", "repo", "maxTurns"?, "timeoutMs"?, "allowedTools"? }`. `repo` is the repository Claude Code reads (absolute path, or relative to the addon folder). |
| `mcp.json` | Database MCP server for Claude Code. Default: [Postgres MCP Pro](https://github.com/crystaldba/postgres-mcp) in restricted mode, with `DATABASE_URI` taken from the environment via `${DATABASE_URI}`. |
| `connect.sh` | Executable. Opens a read-only connection, exports `DATABASE_URI`, runs the command it receives (`"$@"`), and cleans up when it exits. |
| `CLAUDE.md` | Instructions for the analyst agent: read-only rules, where the schema lives, how to answer. |

Tools exposed over MCP:

- `list_projects`: name and description of every addon folder that has a
  `project.json` (folders starting with `_` or `.` are skipped).
- `ask(project, question)`: runs, with the addon folder as working directory
  (so its `CLAUDE.md` loads):

  ```
  <addon>/connect.sh claude -p <question> --output-format json
    --mcp-config <addon>/mcp.json --strict-mcp-config --add-dir <repo>
    --allowedTools Read,Grep,Glob,<db tools> --tools Read,Grep,Glob,<db tools>
    --disallowedTools Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Agent
    --permission-mode dontAsk --no-session-persistence --max-turns <n>
  ```

  and returns the answer text. `<db tools>` is `allowedTools` from
  `project.json`, or `mcp__<server>__*` for every server in `mcp.json`.
  Failures (connect script error, non-zero exit, error result, unparsable
  output, timeout) come back as MCP tool errors with the last 2 KB of stderr,
  with `postgres://` URLs redacted. Questions for the same project run one at
  a time. When the client sends a progress token, a progress notification is
  sent every 15 seconds.

## Setup

Requirements: Node.js 20 or later, [Claude Code](https://docs.claude.com/en/docs/claude-code)
installed and logged in (`claude` on the `PATH`), and
[uv](https://docs.astral.sh/uv/) for `uvx` if you use the default Postgres MCP
server. Plus whatever your `connect.sh` needs (a cloud CLI, `curl`, a VPN...).

```sh
git clone <this repo> /path/to/cowork-data-bridge
cd /path/to/cowork-data-bridge
npm install
npm test
```

Add a project (see [docs/adding-a-project.md](docs/adding-a-project.md)), then
check it from a terminal:

```sh
node server.mjs list
node server.mjs ask <project> "How many active users last week?"
```

### Register in Claude Desktop / Cowork

Edit `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`) and restart
Claude Desktop:

```json
{
  "mcpServers": {
    "data-bridge": {
      "command": "/path/to/node",
      "args": ["/path/to/cowork-data-bridge/server.mjs"],
      "env": {
        "PATH": "/path/to/node-bin-dir:/path/to/claude-bin-dir:/path/to/uvx-bin-dir:/path/to/cloud-cli-bin-dir:/usr/bin:/bin"
      }
    }
  }
}
```

Use absolute paths. Apps started from the macOS Dock do not get your shell's
`PATH`, so `PATH` must list every directory that holds a program the chain
needs: `node`, `claude`, `uvx`, and anything `connect.sh` calls (a cloud CLI,
`curl`, `psql`...). Find them with `which node claude uvx curl`.

Optional environment variables:

| Variable | Default | Meaning |
|----------|---------|---------|
| `BRIDGE_PROJECTS_DIR` | `<repo>/projects` | Folder that holds the project addons. Use it to keep addons outside this repository. |
| `BRIDGE_CLAUDE_BIN` | `claude` | Claude Code executable. |
| `BRIDGE_TIMEOUT_MS` | `300000` | Time limit per question. `timeoutMs` in `project.json` overrides it. |

When a question times out or the server shuts down, the whole process group
of that run gets `SIGTERM`, then `SIGKILL` 30 seconds later if anything is
still running. A `trap` in `connect.sh` has that time to close the
connection.

## Security notes

Read-only is enforced in layers, none of them perfect on its own:

1. `connect.sh` should open a read-only session (for example
   `PGOPTIONS="-c default_transaction_read_only=on"`, a read-only database
   role, or a replica) and refuse to run if it cannot.
2. The database MCP server runs in restricted mode (`--access-mode=restricted`
   for Postgres MCP Pro).
3. Claude Code only gets `Read`, `Grep`, `Glob` and the database tools;
   shell, file editing, web and subagents are disallowed, and `dontAsk` denies
   anything not pre-approved.
4. The addon's `CLAUDE.md` tells the analyst to run only `SELECT`.

Limits to be aware of:

- Rules about personal data, secrets and message content are prompt
  instructions only. There is no column masking and no audit log. The analyst
  can read whatever the database user can read and any file in the project
  repository, and its answers go to the MCP client.
- The only output filtering is the redaction of `postgres://` URLs.
- The analyst runs with your user-level Claude Code configuration (settings,
  hooks, plugins, `~/.claude/CLAUDE.md`) and inherits the server's
  environment. `CLAUDE.md` files in parent folders of the addon also load,
  which is why this repository has no root `CLAUDE.md`.
- Questions use your Claude Code account and count towards its usage.

## Known limits

- Whether Claude Cowork can reach a local stdio MCP server registered in Claude
  Desktop is not confirmed. The server works with any MCP client that runs
  local stdio servers.
- MCP clients have their own tool-call timeouts. A long question may be cut
  off by the client even though progress notifications are sent.
- One question at a time per project; no memory between `ask` calls.
- If the server is killed outright (`SIGKILL`), runs in progress are not
  stopped: they continue in their own process group until Claude Code
  finishes (bounded by `--max-turns`), and `connect.sh` cleans up then.
- `--max-turns` is accepted by Claude Code but not listed in `claude --help`.

## License

[MIT](LICENSE)
