# Digest-pinned to the 22-bookworm multi-arch index resolved on 2026-06-16.
# The tag is kept for readability; the @sha256 is what actually pins the image.
# Re-resolve with: curl -fsSL -D - -o /dev/null \
#   -H 'Accept: application/vnd.oci.image.index.v1+json' \
#   https://mcr.microsoft.com/v2/devcontainers/typescript-node/manifests/22-bookworm \
#   | grep -i docker-content-digest
FROM mcr.microsoft.com/devcontainers/typescript-node:22-bookworm@sha256:59e8c044af4ed4795967188c3d0b9bc677f42d42b0ff41f98c8be5333defeb64

ARG WRANGLER_VERSION=4
# uv installer is fetched from a version-pinned path (astral.sh/uv/<ver>/install.sh),
# not a mutable branch, and the installer verifies the binary checksum itself.
ARG UV_VERSION=0.5.11
# act release tag to install. The installer self-verifies the binary's SHA256
# against the upstream checksums file for this tag (see install.sh execute()).
ARG ACT_VERSION=v0.2.89
# Claude Code CLI version. Pinned instead of the default "stable" channel so the
# build is reproducible; claude.ai/install.sh verifies the binary checksum against
# the per-version manifest.json it downloads.
ARG CLAUDE_VERSION=2.1.153
# Pin pnpm's major to avoid `@latest` drift silently changing build behavior
# (e.g. the global-bin-dir convention). Bump deliberately.
ARG PNPM_VERSION=10

# ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        locales \
        pandoc \
        sqlite3 \
        python3 \
        python3-venv \
        python3-pip \
        jq \
        ripgrep \
        zsh \
        wget \
        vim \
        less \
        htop \
        # Sandboxing engine for Codex's `bwrap` agent isolation. The relaxed
        # seccomp/apparmor in devcontainer.json runArgs is what lets its user
        # namespace be created; this just puts bwrap on PATH.
        bubblewrap \
        # Playwright Chromium runtime deps — enable headless-browser
        # inspection of UI prototypes via the @playwright/mcp MCP server.
        libnspr4 libnss3 libatk1.0-0 libdbus-1-3 \
        libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libxkbcommon0 libasound2 libatspi2.0-0 \
        libcups2 libdrm2 libpango-1.0-0 libcairo2 \
    && sed -i -e 's/# bg_BG.UTF-8 UTF-8/bg_BG.UTF-8 UTF-8/' /etc/locale.gen \
    && sed -i -e 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

# Install act (run GitHub Actions locally) — use -b to install directly into /usr/local/bin
# instead of the installer's default ./bin (which would otherwise need cleanup and is risky
# at this point in the build because WORKDIR is still /).
# The install script is pinned to the commit that ${ACT_VERSION} points to (was `master`),
# and the trailing tag arg pins the act binary. The script downloads the upstream
# checksums file and verifies the binary's SHA256 before installing.
RUN curl -fsSL https://raw.githubusercontent.com/nektos/act/4f411281417e88660bea1c1a1749aa71ae0bd60f/install.sh \
    | bash -s -- -b /usr/local/bin "${ACT_VERSION}"

# Make zsh node's default login shell
RUN usermod -s /usr/bin/zsh node

RUN su node -c "curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh"

RUN corepack enable \
    && printf 'export PNPM_HOME=/home/node/.local/share/pnpm\nexport PATH=$PNPM_HOME/bin:$PNPM_HOME:$PATH\n' \
       > /etc/profile.d/pnpm-home.sh

USER node
WORKDIR /workspaces/sigma

ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=/home/node/.local/bin:${PNPM_HOME}/bin:${PNPM_HOME}:${PATH}

RUN corepack prepare pnpm@${PNPM_VERSION} --activate \
    && pnpm config set store-dir /home/node/.pnpm-store

RUN pnpm add -g wrangler@${WRANGLER_VERSION}

# AI coding agents
# Pass ${CLAUDE_VERSION} so the build pins an exact release instead of the moving
# "stable" channel. The installer (claude.ai/install.sh) downloads that version's
# manifest.json and verifies the binary's SHA256 against it before installing.
# Note: the installer *script* URL is not version-addressable upstream, so it
# remains an unavoidable trust anchor (same as the Astral uv bootstrap above).
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_VERSION}"
RUN pnpm add -g @openai/codex

# Playwright MCP server + pre-fetched Chromium so the agent can inspect UI in a
# real headless browser. System libs are installed above (apt section).
RUN pnpm add -g @playwright/mcp playwright \
    && npx playwright install chromium

# Headline theme — oh-my-zsh is pre-installed in the typescript-node base image,
# so we only drop the theme in and switch ZSH_THEME.
# Pinned to a specific commit (was the moving `main` ref); upstream ships no tags
# or checksums, so we verify the downloaded file against a known-good SHA256.
RUN curl -fsSL https://raw.githubusercontent.com/moarram/headline/eabc85636f4dbf23927d2f2f6890af715c7e94a2/headline.zsh-theme \
        -o /home/node/.oh-my-zsh/themes/headline.zsh-theme \
    && echo '9719cb7a2ef38b5b04aef3d7b5300e6ef70952c5eda55c5565641d65832715c5  /home/node/.oh-my-zsh/themes/headline.zsh-theme' | sha256sum -c - \
    && sed -i "s/'echo \$USER'/'whoami'/g" /home/node/.oh-my-zsh/themes/headline.zsh-theme \
    && sed -i 's/^ZSH_THEME=.*/ZSH_THEME="headline"/' /home/node/.zshrc

# act default: use the catthehacker image (closer to the real GitHub runner than the slim default)
RUN echo '-P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-latest' > /home/node/.actrc
