#!/usr/bin/env bash
set -euo pipefail
trap 'echo cleaned > "${FIXTURE_MARKER:-/dev/null}"' EXIT
if [[ -n "${FIXTURE_IGNORE_TERM:-}" ]]; then trap '' TERM; else trap 'exit 143' TERM; fi
if [[ -n "${FIXTURE_STRAGGLER_PIDFILE:-}" ]]; then
  sleep 20 &
  echo $! > "$FIXTURE_STRAGGLER_PIDFILE"
fi
if [[ -n "${FIXTURE_ESCAPED_PIDFILE:-}" ]]; then
  node -e 'const c = require("child_process").spawn("sleep", ["20"], { detached: true, stdio: "inherit" }); require("fs").writeFileSync(process.argv[1], String(c.pid)); c.unref();' "$FIXTURE_ESCAPED_PIDFILE"
fi
echo "connect: opening postgres://reader:pa55@db.example:5432/app" >&2
export DATABASE_URI="fixture-uri"
"$@"
