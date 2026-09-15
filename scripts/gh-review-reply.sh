#!/usr/bin/env bash
# Post a reply to a GitHub pull-request review thread, reading the body from a FILE (or stdin).
#
# Why a file and never an inline argument: review replies in this repo are Bulgarian prose
# containing „typographic quotes", parentheses, backticks and em-dashes. Inlining that text into a
# double-quoted shell argument terminates the string on the first ASCII " and the remainder is
# parsed as shell — a real headless run lost its clean transcript to exactly that
# (syntax error near unexpected token `)').
#
# Usage:
#   scripts/gh-review-reply.sh <thread-id> <body-file>
#   scripts/gh-review-reply.sh <thread-id> -        # body on stdin
#   scripts/gh-review-reply.sh --resolve <thread-id>
set -euo pipefail

usage() {
  echo "usage: $0 <thread-id> <body-file|->" >&2
  echo "       $0 --resolve <thread-id>" >&2
  exit 2
}

[ $# -ge 1 ] || usage

if [ "$1" = "--resolve" ]; then
  [ $# -eq 2 ] || usage
  gh api graphql \
    -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' \
    -F id="$2"
  echo "RESOLVED $2"
  exit 0
fi

[ $# -eq 2 ] || usage
thread_id="$1"
body_file="$2"

if [ "$body_file" = "-" ]; then
  body_file="$(mktemp)"
  trap 'rm -f "$body_file"' EXIT
  cat > "$body_file"
elif [ ! -r "$body_file" ]; then
  echo "HALT: body file not readable: $body_file" >&2
  exit 1
fi

if [ ! -s "$body_file" ]; then
  echo "HALT: body file is empty: $body_file" >&2
  exit 1
fi

gh api graphql \
  -f query='mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body}){comment{id}}}' \
  -F id="$thread_id" \
  -F body=@"$body_file"
echo "REPLIED $thread_id"
