# Sigma — agent working conventions

This file is the source of truth for repo conventions. Both Codex agents (which read it natively from cwd) and Claude agents (which load it via the sibling `CLAUDE.md` import) consume the same content.

For project background, architecture, and scope, read the design docs in [docs/](docs/). For day-to-day commands and the intended layout, see [README.md](README.md).

## Repository model

Single repo, trunk-based:

```
midt-bg/sigma   ← origin; `main` is the only long-lived branch
```

No `develop`, no `staging`. Maintainers with write access work on short-lived feature branches off `main`; external contributors fork and open PRs from their fork (see [CONTRIBUTING.md](CONTRIBUTING.md)). Either way, work merges back into `main` via PR.

## Branching

- One branch per logical change. Name pattern: `<type>/<slug>` — e.g. `feat/citizen-explorer`, `fix/risk-score-rounding`, `docs/spec-consolidation`. `<type>` matches the commit types below; the slug is a short kebab-case description.
- Branch off the latest `main`. Keep branches short-lived; pull `main` in if one lingers.
- Local git worktrees are fine for juggling parallel work — just never run two unrelated changes on one branch.

## Commits

- Use [conventional commits](https://www.conventionalcommits.org): `<type>(<scope>): <subject>`. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, `style`. Subject is lowercase imperative, no trailing period.
- Use the `/smart-commit` and `/suggest-commit` skills when drafting messages. They produce the canonical format for this repo.
- **Never include `Co-Authored-By:` trailers.** Keep the history clean; CI may grep for this.
- Small, focused commits are encouraged. Commit as you go — not all at the end. Easier to review and revert. Don't mix unrelated changes in one commit.

## Pull requests

- Feature branch → PR into `main` on `midt-bg/sigma` → review → merge → delete the branch.
- Push the branch _before_ opening the PR. Keep each PR scoped to one logical change so it stays reviewable.
- Use the `gh` CLI for PR operations. Only push or open a PR when asked.

## Working directory and environment

- The runtime cwd is the project root — `/workspaces/sigma` inside the devcontainer.
- Sigma reuses an existing pnpm + turbo monorepo tech stack on Cloudflare (React Router v7 (SSR) on Workers, D1, Durable Objects, Vectorize, Workers AI, Queues, KV, R2, AI Gateway). Use the existing `pnpm`, `wrangler`, and `turbo` scripts — see [README.md](README.md).
- The monorepo scaffold (`apps/`, `packages/`, workspace + lockfile) is still being established. If a script doesn't exist yet, say so rather than inventing one.
- Run only the minimal tests needed to gain confidence in the change. Full release verification is reserved for explicit asks (release tickets, smoke tests).

## Things not to do

- Do not commit secrets, `.env*` files, or anything in `.dev.vars`. Treat national-registry credentials (НАП, Търговски регистър, АОП) as production secrets.
- Do not amend commits that have already been pushed.
- Do not force-push to a branch someone else might be reading.
- Do not delete branches you didn't create.
- Do not edit files outside your change's intended scope. If you find an unrelated bug, note it separately; don't sneak the fix into your branch.

## Notes and decisions

- Design decisions, plans, and the evolving specification live in [docs/](docs/) — not as scattered notes in the repo.
- Claude agents persist cross-session facts via their file-based memory; keep anything that belongs to the project itself (decisions, scope, constraints) in `docs/` so every agent and contributor sees it.
