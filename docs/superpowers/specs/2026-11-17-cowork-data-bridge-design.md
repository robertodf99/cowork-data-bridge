# cowork-data-bridge — design

Date: 2026-11-17 · Status: approved by the owner

## Intent

Let Claude Cowork (or any MCP client) ask natural-language questions about a
project's data, answered by Claude Code running headless with that project's
repository as context (schema, domain docs) and a read-only database
connection. First use: platform-usage statistics for one client project. The
framework is public and reusable; every project's connection details stay
private.

## Goals

- One small MCP server, reusable across projects, published as a public repo.
- Per-project "addons" (a folder of three files) that live outside version
  control: gitignored under `projects/` or in a folder given by
  `BRIDGE_PROJECTS_DIR`.
- Each question opens the project's connection, runs Claude Code, and closes the
  connection.
- Documentation precise enough that a new project can be added with a single
  prompt to Claude Code.

## Non-goals

- No custom SQL tool, semantic layer, PII masking or audit log (owner chose the
  simple option).
- No remote/HTTP deployment, auth, or multi-user hosting.
- No conversation sessions across `ask` calls.

## Anti-goals

- Any client name, host, vault, credential or path in the public repo.
- Writes to a project database.

## Approaches considered

1. Generic bridge with its own enforced read-only SQL tool, masking and limits
   in code. Strongest guardrails; more code. Rejected by owner as
   over-engineering.
2. **Thin wrapper around `claude -p` with per-project folders (chosen).**
   Simple; read-only relies on the prompt, the project's connect script and the
   database MCP server's restricted mode.
3. Database connector directly in Cowork, no Claude Code. Loses repository
   context, which is what makes answers accurate. Rejected.

## Design

```
server.mjs            MCP server (stdio) + tiny CLI for testing
projects/_example/    committed template
  CLAUDE.md           instructions for the analyst agent (read-only, reporting)
  mcp.json            database MCP server config, credentials via ${ENV}
  connect.sh          wraps a command: open connection, set env, exec, close
  project.json        { description, repo (context dir), maxTurns? }
projects/<name>/      private addons, gitignored
docs/adding-a-project.md   step-by-step, written to be executed by Claude Code
```

MCP tools:

- `list_projects` → name + description of each addon folder (folders starting
  with `_` are templates and are skipped).
- `ask(project, question)` → runs
  `projects/<p>/connect.sh claude -p <question> --output-format json
  --mcp-config projects/<p>/mcp.json --strict-mcp-config
  --add-dir <repo> --allowedTools <db MCP tools, Read, Grep, Glob>
  --disallowedTools <Bash, Write, Edit, WebFetch, WebSearch, …>` with cwd = the
  addon folder (so its CLAUDE.md loads), and returns the result text. Errors
  (connect failure, non-zero exit, timeout) come back as MCP tool errors with
  stderr tail.

Read-only layers: the addon's CLAUDE.md, the connect script (e.g. a
`default_transaction_read_only` session option), and the database MCP server's
restricted mode (default: Postgres MCP Pro via `uvx postgres-mcp
--access-mode=restricted`).

Stack: Node ≥ 20 ESM, `@modelcontextprotocol/sdk`, `zod`; no build step. Tests
with `node:test` for project discovery, validation and argument building.
License MIT.

## Left to the builder

- Exact tool-name allowlist for the database MCP server.
- Timeout value and how to surface progress for long questions.
- Whether `--max-turns` is available in the installed CLI; otherwise rely on the
  timeout.
- Claude Desktop / Cowork registration snippet for the README.
