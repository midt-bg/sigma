# Sigma

**Платформа за Прозрачни Възлагания (ППВ)** — a transparency-and-analysis platform for Bulgarian public procurement. Sigma centralizes the full procurement lifecycle (planning → publication → bidding → evaluation → contract → execution) and layers AI checks on top: it flags rigged technical specifications, detects price anomalies against market indices, surfaces cartels and related-party networks, and publishes a public risk score for every tender.

Built as an analysis/transparency layer over the national procurement data (АОП / ЦАИС ЕОП), with open data for citizens, journalists, and NGOs.

The design is captured in [`docs/`](docs/) — start there:

- **Платформа за СИГМА** — concept overview, key functionality, roadmap.
- **Обща рамка, концепция, roadmap, законови промени** — architecture, the analysis/monitoring module, phased roadmap, and the legislative changes the platform assumes.
- **UX - СИГМА** — user journeys for the three personas: contracting authority (възложител), citizen (гражданин), and bidder (фирма-участник).

> These are early drafts. A consolidated `docs/specification.md` (mirroring the kolkostruva spec structure) will follow as scope firms up.

## Quick start

This repo is set up to be developed inside a Devcontainer — host machine needs Docker (or compatible: OrbStack, Rancher Desktop) and an editor with Devcontainer support (VS Code, JetBrains, etc.).

```bash
# Open the folder in your editor and "Reopen in Container"
# (or run `devcontainer up --workspace-folder .` from the CLI)

pnpm setup    # one-time per fresh checkout: install + local D1 + seed
pnpm dev      # daily: starts every Worker + frontend in parallel
```

> **Status:** prototype. The container, agent conventions, and design docs are in place; the TypeScript monorepo scaffold (`apps/`, `packages/`, workspace + lockfile) is still being established, so the `pnpm` commands below describe the intended flow rather than what runs today.

## Layout

Sigma reuses the kolkostruva tech stack — a single TypeScript monorepo on Cloudflare's edge platform (pnpm + turbo; SvelteKit on Pages; Workers + D1 + Durable Objects + Vectorize + Workers AI + Queues + KV + R2, fronted by AI Gateway). The intended top-level layout:

| Top-level dir | Contents |
|---|---|
| `apps/` | Cloudflare Workers / Pages — `web` (citizen / authority / bidder portals), `api` (procurement search, profiles, risk scores, open-data), `assistant` (AI Procurement Assistant), `etl` (ingestion + analysis pipeline), `admin` (auditor/controller ops UI) |
| `packages/` | Shared libraries — `api-contract`, `db`, `analysis` (risk scoring, anomaly + cartel detection), `config`, `assistant-tools`, `shared` |
| `scripts/` | Bootstrap, deploy, setup-local, teardown |
| `data/` | Market-price reference workbooks (`Храни.xlsx` — foods, `Строителство.xlsx` — construction) for the price-anomaly module, plus local fixtures |
| `docs/` | Specification and design docs |
| `.devcontainer/` | Container-based dev environment |
| `.github/workflows/` | CI: deploy on push, scheduled ingestion, tests on PR |

The analysis/monitoring module (risk scoring 0–100, спец-checker AI, ценови аномалии, картелна детекция) is the heart of the system — see the architecture doc in `docs/`.

## Common commands

| Command | Purpose |
|---|---|
| `pnpm setup` | First-time setup on a fresh checkout |
| `pnpm dev` | Start every Worker + frontend locally (miniflare) |
| `pnpm typecheck` | Type-check the workspace |
| `pnpm test` | Run all tests |
| `pnpm bootstrap` | Dry-run Cloudflare resource creation (one-time per CF account) |
| `pnpm bootstrap:apply` | Actually create the resources |
| `pnpm deploy` | Run by CI on push to `main`; idempotent migrate + seed + deploy |

## Operational security

Production deploys originate only from GitHub Actions; the dev machine never holds a long-lived production credential. Procurement data is public by design, but integrations with national registries (НАП, Търговски регистър) carry access constraints — treat any credentials for those as production secrets.

## License

TBD before public release.
