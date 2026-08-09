#!/usr/bin/env bash
set -euo pipefail

echo "==> Devcontainer post-create"

sudo chown -R node:node /workspaces/sigma/node_modules /home/node/.pnpm-store 2>/dev/null || true

echo "==> Enabling corepack + pnpm"
corepack enable

if [ -f pnpm-lock.yaml ]; then
  echo "==> pnpm install (frozen lockfile)"
  pnpm install --frozen-lockfile
else
  echo "==> pnpm install (no lockfile yet)"
  pnpm install
fi

if [ ! -f .dev.vars ] && [ -f .dev.vars.example ]; then
  cp .dev.vars.example .dev.vars
  echo "==> Copied .dev.vars.example → .dev.vars (fill in real keys before pnpm dev)"
fi

# A placeholder git identity does not stay local: GitHub's squash merge turns every distinct commit
# author in a PR into a `Co-authored-by:` line on `main`, so `t <t@e.com>` and
# `you@Your-MacBook.local` end up permanently in the public history. Both have already happened here.
# Warn rather than set anything — the right identity is the developer's, not this script's.
git_email="$(git config user.email || true)"
case "$git_email" in
  '' | *@e.com | *.local | *@localhost | *localdomain*)
    echo "==> WARNING: git user.email is '${git_email:-unset}', which looks like a placeholder."
    echo "    Commits made with it land in the public history as a stray Co-authored-by line."
    echo "    Set it before committing:  git config user.email you@example.com"
    ;;
esac

echo "==> Done. Next: pnpm run setup, then pnpm dev"
