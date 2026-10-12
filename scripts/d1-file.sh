#!/usr/bin/env bash
# Apply one SQL file to the D1 database a deploy targets:
#
#   bash scripts/d1-file.sh <database> <file, relative to apps/web>
#
# `wrangler d1 execute --file` goes through D1's import route, and its status polling sometimes reports
# „Not currently importing anything" for an import that has already finished — that failed a staging deploy
# on 30.09.2026 — and D1 has short faults of its own. The files a deploy applies converge (IF NOT EXISTS,
# DELETE + INSERT, a one-time ALTER behind a schema check), so a repeat is the safe answer: up to three
# attempts, and the deploy fails only when all of them do.
set -euo pipefail
db="${1:?usage: d1-file.sh <database> <file>}"
file="${2:?usage: d1-file.sh <database> <file>}"
attempts="${D1_FILE_ATTEMPTS:-3}"
wait_step="${D1_FILE_WAIT_SECONDS:-15}"
for ((attempt = 1; ; attempt++)); do
  if pnpm --filter @sigma/web exec wrangler d1 execute "$db" \
    --config wrangler.deploy.jsonc --remote --yes --file "$file"; then
    exit 0
  fi
  if ((attempt >= attempts)); then
    echo "::error::d1 execute --file $file failed $attempts times" >&2
    exit 1
  fi
  wait=$((attempt * wait_step))
  echo "::warning::d1 execute --file $file failed (attempt $attempt/$attempts); retrying in ${wait}s" >&2
  sleep "$wait"
done
