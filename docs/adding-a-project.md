# Adding a project

A project is a folder with `project.json`, `mcp.json`, `connect.sh`,
`CLAUDE.md` and, with the default database server,
`postgres-mcp-overrides.txt`. It holds private connection details, so it never
goes into version control:

- inside this repository as `projects/<name>/`, which `.gitignore` excludes,
  or
- in any other folder, by pointing `BRIDGE_PROJECTS_DIR` at it (in the
  Claude Desktop config and in your shell when you test). Use this to keep
  addons in a private repository or a synced folder.

This page is written so that Claude Code can do the whole job from one prompt.

## 1. Gather the inputs

| Input | Example | Notes |
|-------|---------|-------|
| Name | `shop` | `^[a-z0-9][a-z0-9_-]{0,63}$`. Becomes the folder name and the `project` argument of `ask`. |
| Description | `Order and customer statistics (production, read-only)` | One line; shown by `list_projects`. |
| Repository path | `/path/to/shop-repo` | Where the schema and domain docs live. |
| Database URL | "run `/path/to/shop-repo/scripts/db.sh prod run -- <cmd>`", or "`DATABASE_URL` from a secret manager" | How a connection is obtained today. An existing connect script is ideal. |
| Read-only mechanism | `PGOPTIONS="-c default_transaction_read_only=on"`, a read-only role, a replica | At least one is required. |
| Optional | `timeoutMs`, `maxTurns`, `allowedTools` | Only if the defaults (300000 ms, 30 turns, all tools of the servers in `mcp.json`) do not fit. |

## 2. Prompt for Claude Code

Open Claude Code in this repository and paste, after filling the brackets:

```text
Add a project addon to cowork-data-bridge following docs/adding-a-project.md
and README.md.

- Name: <name>
- Description: <one line>
- Repository: <absolute path to the project repository>
- Addon location: projects/<name>/ in this repo   (or: $BRIDGE_PROJECTS_DIR/<name>/ = <path>)
- How to get a database connection: <existing connect script and its usage, or where DATABASE_URL comes from>
- Read-only mechanism: <PGOPTIONS default_transaction_read_only / read-only role / replica>
- Optional settings: <timeoutMs / maxTurns / allowedTools, or "defaults">

Copy projects/_example/ to the addon location and adapt the files as
described in section 3 of docs/adding-a-project.md. Read the project
repository (schema files, domain docs) to write the "where to start" and
"main tables" parts of CLAUDE.md, and list the columns that hold secrets or
message content so CLAUDE.md forbids them. Do not commit or stage anything in
the addon, do not print secrets, and do not connect to the database or run
`ask` until I approve. Then run the checks in section 4 and show me the
results.
```

## 3. Files to create

Start from a copy of `projects/_example/`.

### `project.json`

```json
{
  "description": "<one line>",
  "repo": "/path/to/the/project/repository"
}
```

Optional keys: `"timeoutMs"` (positive integer, overrides
`BRIDGE_TIMEOUT_MS`), `"maxTurns"` (positive integer, default 30),
`"allowedTools"` (array of tool names such as `"mcp__db__execute_sql"`; replaces
the default `mcp__<server>__*` for each server in `mcp.json`).

### `mcp.json` and `postgres-mcp-overrides.txt`

Keep both from the template unless the database is not Postgres:

```json
{
  "mcpServers": {
    "db": {
      "command": "uvx",
      "args": [
        "--python", "3.12",
        "--overrides", "postgres-mcp-overrides.txt",
        "postgres-mcp==0.3.0",
        "--access-mode=restricted"
      ],
      "env": { "DATABASE_URI": "${DATABASE_URI}" }
    }
  }
}
```

```text
pglast>=7.20,<8
mcp[cli]>=1.5,<2
```

`postgres-mcp==0.3.0` no longer installs on its own (it pins a `pglast`
version that was removed from PyPI and breaks with `mcp` 2.x); the overrides
file fixes that. Its path is relative because Claude Code starts MCP servers
in the addon folder. `${DATABASE_URI}` is expanded by Claude Code from the
environment that `connect.sh` sets up. Never write a real URL in this file.

Check that the server starts, without a database, from the addon folder:

```sh
cd projects/<name>
uvx --python 3.12 --overrides postgres-mcp-overrides.txt postgres-mcp==0.3.0 --access-mode=restricted --help
```

### `connect.sh`

Executable (`chmod +x`). It receives the full `claude ...` command as
arguments and must:

1. obtain the connection (call the existing connect script, fetch the URL
   from a secret manager, open a tunnel...);
2. guarantee read-only access and **exit non-zero if it cannot**;
3. `export DATABASE_URI=<url>`;
4. run `"$@"` (use `exec "$@"` when nothing needs cleaning up afterwards);
5. write nothing but the command's output to stdout: send its own messages
   to stderr (the bridge reads the answer from stdout);
6. close what it opened on exit, including on `SIGTERM` (a `trap`). It gets 30
   seconds before `SIGKILL`;
7. if it opens temporary access (a firewall rule, a tunnel), reclaim anything
   a previous interrupted run left behind instead of reusing it, and print a
   line starting with `WARNING` to stderr when cleanup fails (the bridge
   appends those lines to the answer);
8. never print the URL or credentials.

If the project already has a connect script with a "run a command" mode, wrap
it and redirect its own stdout to stderr while keeping the command's stdout:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec 3>&1
exec /path/to/existing-connect.sh prod run -- bash -c '
  set -euo pipefail
  exec 1>&3 3>&-
  case "${PGOPTIONS:-}" in
    *default_transaction_read_only=on*) ;;
    *) echo "refusing to run without a read-only session" >&2; exit 1 ;;
  esac
  export DATABASE_URI="$DATABASE_URL"
  exec "$@"
' connect "$@" >&2
```

### `CLAUDE.md`

Required: the bridge passes it to Claude Code with
`--append-system-prompt-file` (with `--restricted`, `CLAUDE.md` files are not
loaded automatically). Start from the template and add:

- **Where to start**: the files in the repository that explain the domain and
  the schema (for example `docs/INDEX.md`, `src/db/schema/`).
- **Main tables** for the questions you expect, with their useful columns.
- **Never select or return** the specific columns that hold secrets (tokens,
  password or one-time-code hashes, API keys) and message or document
  content.
- Project conventions: timezone for day/week/month boundaries, how to
  recognise internal or test accounts (always stated as an assumption).

The analyst can read every file in the addon folder and the repository except
`.env*`, `*.pem` and `*.key`, which the bridge denies. Keep other secrets out
of both folders.

## 4. Verify

```sh
# syntax, permissions and required files
bash -n projects/<name>/connect.sh && test -x projects/<name>/connect.sh
ls projects/<name>/{project.json,mcp.json,connect.sh,CLAUDE.md,postgres-mcp-overrides.txt}

# the addon is listed
node server.mjs list

# nothing in the addon can be committed (no output from git status, one
# "ignored" line per file from check-ignore)
git status --short projects/
git check-ignore -v projects/<name>/*

# with BRIDGE_PROJECTS_DIR instead:
BRIDGE_PROJECTS_DIR=/path/to/addons node server.mjs list
```

Then, with the owner's approval because it opens a real connection, ask one
cheap question and read the answer and its "How this was computed" section:

```sh
node server.mjs ask <name> "How many rows does the largest table have? Do not return any row data."
```

Do not run CLI asks for a project while Claude Desktop may be asking about
the same project: the one-question-at-a-time queue is per bridge process.

`list_projects` reads the folder on every call, so a running server sees the
new project without a restart (a restart is needed only after changing the
Claude Desktop config, for example `BRIDGE_PROJECTS_DIR`).
