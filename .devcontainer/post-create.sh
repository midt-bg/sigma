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

# Codex CLI. Installed here rather than in the Dockerfile because /home/node/.pnpm-store
# is a named volume: a build-time install lands in the image layer and the volume then
# mounts over it, leaving the shim pointing at whatever stale version the volume holds.
#
# The global-bin-dir pin is what keeps `codex update` working afterwards. PATH lists both
# $PNPM_HOME/bin and $PNPM_HOME (bin first), and the two pnpm majors disagree about which
# is the global bin dir -- corepack serves pnpm 10 inside this repo (packageManager) and
# pnpm 11 outside it. So an update run from the repo wrote the shim PATH never resolved,
# and codex silently stayed pinned at an old version. Pinning the dir makes both majors
# write the same shim, whatever the cwd.
echo "==> Installing/updating Codex CLI"
pnpm config set global-bin-dir "${PNPM_HOME:-$HOME/.local/share/pnpm}/bin"
rm -f "${PNPM_HOME:-$HOME/.local/share/pnpm}/codex"   # drop a pre-pin duplicate, if any
pnpm add -g @openai/codex@latest

# Recreate only the desired global Codex defaults on each new container. Codex auth,
# history, trust decisions, and other state intentionally remain container-local.
echo "==> Applying Codex defaults"
install -d -m 700 "$HOME/.codex"
install -m 600 /workspaces/sigma/.devcontainer/codex-defaults.toml "$HOME/.codex/config.toml"

if [ ! -f .dev.vars ] && [ -f .dev.vars.example ]; then
  cp .dev.vars.example .dev.vars
  echo "==> Copied .dev.vars.example → .dev.vars (fill in real keys before pnpm dev)"
fi

echo "==> Done. Next: pnpm run setup, then pnpm dev"
