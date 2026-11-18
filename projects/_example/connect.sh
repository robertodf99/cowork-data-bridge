#!/usr/bin/env bash
# Runs the command given as arguments with a read-only database connection.
# Replace the DATABASE_URL lookup with however this project obtains its URL
# (a secret manager, a VPN, a tunnel, an existing connect script...).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is not set}"
export DATABASE_URI="$DATABASE_URL"
export PGOPTIONS="-c default_transaction_read_only=on"
exec "$@"
