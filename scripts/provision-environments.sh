#!/usr/bin/env bash
#
# Provision the `production` GitHub Environment's deploy-governance rules for issue #89.
#
# Why this exists: Environment protection rules (required reviewers, deployment branch/tag
# policies) live in repo Settings, NOT in deploy.yml — the workflow only *references* the
# environment by name. Clicking them in the UI is invisible to review and easy to drift. This
# script codifies them so the production approval gate is reproducible and auditable.
#
# It is idempotent w.r.t. the fields this script manages: re-running re-applies the same rules
# and converges the tag policy to exactly one `v*` tag policy (removing any stale policies).
# It does NOT preserve out-of-band UI state such as `wait_timer` unless WAIT_TIMER is passed.
# If the script aborts mid-run, simply re-run — each step is idempotent individually.
#
# What it configures on the `production` environment:
#   1. Required reviewers (+ prevent self-review) — a human must click "Review deployments"
#      before a prod deploy reaches a runner (so before Cloudflare auth ever runs).
#   2. A deployment TAG policy `v*` — GitHub itself refuses to deploy `production` unless the ref
#      is a release tag, even if deploy.yml's `detect` logic were wrong (defense in depth).
#
# Prerequisites:
#   - gh CLI authenticated with admin rights on the repo (`gh auth status`).
#   - REPO env var set to owner/name, OR the command must run inside the git checkout so that
#     `gh repo view` can derive it automatically. If neither is available the script errors out.
#   - Reviewers passed as env vars (at least one required):
#       REVIEWER_USERS="alice,bob"             # GitHub logins (≥2 individuals for four-eyes)
#       REVIEWER_TEAMS="midt-bg/maintainers"   # org/team-slug (optional; team must have ≥2 members)
#   - WAIT_TIMER (optional, integer minutes): if set, the environment's wait_timer is configured
#       to this value. Omit to reset it to 0 (the GitHub default).
#
# ⚠ Four-eyes note: `prevent_self_review` only prevents the *deploy initiator* from approving
#   their own deployment — it does NOT enforce genuine four-eyes by itself. For true four-eyes
#   configure at least two individual reviewers (or a team with ≥2 members), so no single person
#   can both initiate and approve a production deploy.
#
# Usage:
#   REVIEWER_USERS="alice,bob" ./scripts/provision-environments.sh
#   REVIEWER_TEAMS="midt-bg/maintainers" ./scripts/provision-environments.sh
#   WAIT_TIMER=10 REVIEWER_USERS="alice,bob" ./scripts/provision-environments.sh
#   REPO=other-org/other-repo REVIEWER_USERS="alice" ./scripts/provision-environments.sh
#
set -euo pipefail

# Resolve REPO: use explicit env var, otherwise derive from gh; fail loud if neither works.
if [ -n "${REPO:-}" ]; then
  : # already set by caller
else
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" || {
    echo "❌ Could not determine repository. Set REPO=owner/name explicitly." >&2
    echo "   Example: REPO=midt-bg/sigma REVIEWER_USERS=\"alice\" $0" >&2
    exit 1
  }
  if [ -z "$REPO" ]; then
    echo "❌ Could not determine repository. Set REPO=owner/name explicitly." >&2
    echo "   Example: REPO=midt-bg/sigma REVIEWER_USERS=\"alice\" $0" >&2
    exit 1
  fi
fi

ENVIRONMENT="production"
REVIEWER_USERS="${REVIEWER_USERS:-}"
REVIEWER_TEAMS="${REVIEWER_TEAMS:-}"
WAIT_TIMER="${WAIT_TIMER:-}"
if [ -n "$WAIT_TIMER" ] && ! [[ "$WAIT_TIMER" =~ ^[0-9]+$ ]]; then
  echo "❌ WAIT_TIMER must be a non-negative integer (minutes), got '$WAIT_TIMER'." >&2
  exit 1
fi

if [ -z "$REVIEWER_USERS" ] && [ -z "$REVIEWER_TEAMS" ]; then
  echo "❌ No reviewers given. Set REVIEWER_USERS and/or REVIEWER_TEAMS." >&2
  echo "   Example: REVIEWER_USERS=\"lyubomir-bozhinov\" $0" >&2
  exit 1
fi

command -v gh >/dev/null 2>&1 || { echo "❌ gh CLI not found. Install it or run from a machine with it." >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "❌ jq not found. Install it (used to resolve reviewer ids)." >&2; exit 1; }

# Trim leading/trailing whitespace from a variable — pure bash, no subprocess.
# Usage: _trim varname  (modifies the variable in-place)
_trim() {
  local _var="$1"
  local _val="${!_var}"
  # trim leading whitespace
  _val="${_val#"${_val%%[![:space:]]*}"}"
  # trim trailing whitespace
  _val="${_val%"${_val##*[![:space:]]}"}"
  printf -v "$_var" '%s' "$_val"
}

# Build the reviewers[] array as JSON: resolve each login/team-slug to its numeric id, which the
# environments API requires (it rejects names).
reviewers_json="[]"

add_reviewer() {  # $1=type (User|Team)  $2=id
  reviewers_json="$(jq -c --arg t "$1" --argjson id "$2" '. += [{"type":$t,"id":$id}]' <<<"$reviewers_json")"
}

if [ -n "$REVIEWER_USERS" ]; then
  IFS=',' read -ra users <<<"$REVIEWER_USERS"
  for u in "${users[@]}"; do
    _trim u
    [ -z "$u" ] && continue
    # Validate before interpolating into the gh api path: a login containing '/' or '.' could
    # otherwise traverse to a different endpoint. GitHub logins are letters/digits/hyphens only.
    [[ "$u" =~ ^[A-Za-z0-9-]+$ ]] || { echo "❌ Invalid GitHub username '$u' (allowed: letters, digits, hyphens)." >&2; exit 1; }
    id="$(gh api "users/$u" --jq .id)" || { echo "❌ Could not resolve user '$u'." >&2; exit 1; }
    [[ "$id" =~ ^[0-9]+$ ]] || { echo "❌ Could not resolve user '$u' to a numeric id (got: '$id')." >&2; exit 1; }
    echo "  reviewer (user):  $u → $id"
    add_reviewer "User" "$id"
  done
fi

if [ -n "$REVIEWER_TEAMS" ]; then
  IFS=',' read -ra teams <<<"$REVIEWER_TEAMS"
  for t in "${teams[@]}"; do
    _trim t
    [ -z "$t" ] && continue
    if [[ "$t" != */* ]]; then
      echo "❌ Team '$t' must be in org/team-slug form (e.g. midt-bg/maintainers)." >&2
      exit 1
    fi
    org="${t%%/*}"; slug="${t##*/}"
    # Same path-traversal guard as for users, applied to both segments before interpolation.
    if ! [[ "$org" =~ ^[A-Za-z0-9-]+$ ]] || ! [[ "$slug" =~ ^[A-Za-z0-9_-]+$ ]]; then
      echo "❌ Invalid team ref '$t' (org: letters/digits/hyphens; slug: letters/digits/hyphens/underscores)." >&2
      exit 1
    fi
    id="$(gh api "orgs/$org/teams/$slug" --jq .id)" || { echo "❌ Could not resolve team '$t'." >&2; exit 1; }
    [[ "$id" =~ ^[0-9]+$ ]] || { echo "❌ Could not resolve team '$t' to a numeric id (got: '$id')." >&2; exit 1; }
    echo "  reviewer (team):  $t → $id"
    add_reviewer "Team" "$id"
  done
fi

# Guard against malformed input that passes the early non-empty check but resolves to zero
# reviewers (e.g. REVIEWER_USERS="," or whitespace-only entries). Sending an empty reviewers[]
# would silently disable the approval gate while the PUT below still reports success — exactly
# the failure this script exists to prevent. Fail loud instead.
reviewer_count="$(jq 'length' <<<"$reviewers_json")"
if [ "$reviewer_count" -eq 0 ]; then
  echo "❌ No valid reviewers resolved — every entry in REVIEWER_USERS/REVIEWER_TEAMS was empty." >&2
  echo "   Refusing to apply an environment with no required reviewers (gate would not exist)." >&2
  exit 1
fi

# GitHub caps required reviewers at 6 per environment. Catch it here so the user gets a clear
# message instead of a raw 422 from the PUT below.
if [ "$reviewer_count" -gt 6 ]; then
  echo "❌ $reviewer_count reviewers resolved, but GitHub allows at most 6 required reviewers per environment." >&2
  echo "   Reduce REVIEWER_USERS/REVIEWER_TEAMS to 6 or fewer entries." >&2
  exit 1
fi

echo "→ Applying required reviewers + tag policy to '$ENVIRONMENT' on $REPO …"

# 1. Required reviewers, prevent self-review, and enable custom branch/tag policies in one PUT.
#    Note: PUT /environments replaces the *full* protection-rule set. Re-running this script
#    re-applies these exact rules. Any `wait_timer` set via the GitHub UI will be reset to 0
#    unless WAIT_TIMER is passed as an env var.
wait_timer_json="0"
if [ -n "$WAIT_TIMER" ]; then
  wait_timer_json="$WAIT_TIMER"
fi

gh api -X PUT "repos/$REPO/environments/$ENVIRONMENT" --input - >/dev/null <<JSON
{
  "wait_timer": $wait_timer_json,
  "prevent_self_review": true,
  "reviewers": $reviewers_json,
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
JSON
echo "  ✅ required reviewers set (prevent_self_review=true, wait_timer=${wait_timer_json}min)"

# 2. Enforce the v* TAG policy as the ONLY deployment branch/tag policy.
#    Strategy: enumerate all existing policies, delete any that are NOT {type=tag, name=v*},
#    then ensure exactly one v* tag policy exists. A LIST failure is fatal (a non-zero exit
#    is the only way to distinguish a transient error from a genuinely empty policy set),
#    and pagination is handled so policies beyond page 1 are not missed.
if ! existing_policies="$(gh api --paginate \
  "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
  --jq '.branch_policies[]?')"; then
  echo "❌ Could not list deployment branch policies — aborting before converging tag policy." >&2
  exit 1
fi

# Delete any policy that is not the intended v* tag policy.
while IFS= read -r policy_json; do
  [ -z "$policy_json" ] && continue
  pid="$(jq -r '.id' <<<"$policy_json")"
  pname="$(jq -r '.name' <<<"$policy_json")"
  ptype="$(jq -r '.type' <<<"$policy_json")"
  if [ "$ptype" = "tag" ] && [ "$pname" = "v*" ]; then
    : # this is the one we want — keep it
  else
    echo "  🗑  removing stale policy: id=$pid name='$pname' type=$ptype"
    gh api -X DELETE "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies/$pid" >/dev/null
  fi
done <<<"$existing_policies"

# Now ensure the v* tag policy exists (idempotent: only add if missing).
#    A re-list failure is fatal for the same reason as above.
if ! remaining="$(gh api --paginate \
  "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
  --jq '.branch_policies[]? | select(.type == "tag" and .name == "v*") | .name')"; then
  echo "❌ Could not re-list deployment branch policies — aborting before ensuring v* policy." >&2
  exit 1
fi
if [ -n "$remaining" ]; then
  echo "  ✅ tag policy 'v*' already present"
else
  gh api -X POST "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
    -f "name=v*" -f "type=tag" >/dev/null
  echo "  ✅ tag policy 'v*' added (only release tags may deploy to production)"
fi

echo "✅ Done. Environment converged: exactly one tag policy 'v*', required reviewers set."
echo "   Verify in: Settings → Environments → $ENVIRONMENT"
echo "   Note: if this run was interrupted earlier, simply re-run — it is idempotent."
