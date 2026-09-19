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
- **Never credit a coding agent in a `Co-Authored-By:` trailer** (Claude Code, Codex, Cursor, Copilot). Trailers naming **people** are fine and must not be stripped — GitHub generates them from the PR's commit authors on squash, and they are what keeps a contributor's credit on `main`, since the squash commit's own author is always the PR opener.
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
- **Never put a real person in a file under version control** — not in code, not in a test fixture, not in a comment, not in a commit message, not in a PR description. This repo is public and its history is permanent.
  - It covers the name itself and anything that singles one person out: a post plus an organisation plus a year, a declaration's document id, a personal ЕГН-derived identifier, an address.
  - That the site publishes the same fact is not a licence to record it here. On the site the fact sits in its own context, with the methodology beside it and a way to contest it. In the repo the same person is written down as the EXAMPLE OF A DEFECT — „this one splits into two profiles", „this one has a typo" — and that is a claim about them, not about the code, which no later commit can take back.
  - Instead: invent a name of the same shape (one letter apart, three parts, the casing you need) and describe the case generically — „the head of a state company filed under a parliamentary category", not the post, the company and the year. The test still proves the same thing.
  - **A named organisation is not free either.** A curated list that IS the data — the Agency's public-enterprise list, a seed file, a fixture that cannot work without the real ЕИК — is fine and belongs here. Reaching for one real company or institution to ILLUSTRATE a defect is not: „this company's rows are broken", „this authority's id is malformed" attaches the suggestion to a named business, for no gain the invented name would not give.
  - Aim for **no concrete entity at all**: invent the name („Община Тест", „ТЕСТ ГРУП ЕООД"), or describe the shape („an authority whose id is not an ЕИК"). A real municipality is the mildest case and is tolerated where a test genuinely needs one — a municipality is not a business and the example says nothing against it — but invent even then if the test works either way, which it almost always does.
  - Check the whole change before opening a PR, including the commit messages, and check what you ADD after an earlier clean-up — a real name reintroduced later looks clean in the history that precedes it.
- Do not amend commits that have already been pushed.
- Do not force-push to a branch someone else might be reading.
- Do not delete branches you didn't create.
- Do not edit files outside your change's intended scope. If you find an unrelated bug, note it separately; don't sneak the fix into your branch.

## Notes and decisions

- Design decisions, plans, and the evolving specification live in [docs/](docs/) — not as scattered notes in the repo.
- Claude agents persist cross-session facts via their file-based memory; keep anything that belongs to the project itself (decisions, scope, constraints) in `docs/` so every agent and contributor sees it.
