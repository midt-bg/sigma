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

echo "==> Done. Next: pnpm run setup, then pnpm dev"
