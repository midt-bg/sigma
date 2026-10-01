#!/usr/bin/env bash
# Make sure the declarations bucket expires what the run leaves behind:
#
#   bash scripts/ensure-r2-lifecycle.sh <bucket>
#
# The resumable declarations run writes checkpoints (60–70 MB a run) and its crawl writes fetch events;
# nothing reads either once the run is over, and the corpus proxy deliberately deletes nothing but the
# corpus stamp (ADR-0049). Without these two rules both stay in the bucket for good. A rule already there
# is left alone. Housekeeping: a token without the R2 permission gets a warning, never a failed deploy.
set -uo pipefail
bucket="${1:?usage: ensure-r2-lifecycle.sh <bucket>}"
if ! rules="$(pnpm --filter @sigma/etl exec wrangler r2 bucket lifecycle list "$bucket" 2>&1)"; then
  echo "::warning::Could not read the lifecycle rules of $bucket; leaving them as they are."
  exit 0
fi
ensure_rule() {
  if grep -Eq "^name:[[:space:]]+$1\$" <<<"$rules"; then
    echo "$bucket: lifecycle rule $1 already present"
    return
  fi
  if pnpm --filter @sigma/etl exec wrangler r2 bucket lifecycle add "$bucket" \
    --name "$1" --prefix "$2" --expire-days "$3" -y; then
    echo "$bucket: lifecycle rule $1 added"
  else
    echo "::warning::Could not add the lifecycle rule $1 to $bucket."
  fi
}
ensure_rule checkpoints declarations/corpus-v2/checkpoints/ 7
ensure_rule fetch-events declarations/corpus-v2/fetch-events/ 30
