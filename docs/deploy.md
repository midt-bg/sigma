# Deploying Sigma to Cloudflare

The v1 deploy set is two workers sharing one D1: **`sigma`** (the SSR explorer — `apps/web`) and
**`sigma-etl`** (the cron-triggered refresh Workflow — `apps/etl`). `apps/api`, `apps/admin`,
`apps/assistant` are out of v1 scope and need not be deployed.

The explorer reads D1 directly; the ETL writes to the **same** D1. Locally they share one miniflare
D1 via the vite `persistState` path; in production they share it by binding the **same
`database_id`** — but the committed `wrangler.*` files hold zero-UUID dummies (for local dev), and
the real IDs come from env vars at deploy time so the repo stays reusable across CF accounts (see
step 1 below).

## 0. Prerequisites (one-time)

- A Cloudflare account on the **Workers Paid** plan (needed for Workflows and a ~1.4 GB D1).
- A credential. Two ways:
  - **CI (recommended):** set repo secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`; deploys
    run from [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) **when you push a version
    tag** (cut a release). No long-lived credential on any developer machine (per AGENTS.md).

> **What CI does vs. what's one-time manual.** CI only **deploys** (`wrangler deploy`). It cannot run
> steps 1–2 below: `bootstrap:apply` produces resource IDs that must be captured into env vars / repo
> secrets (chicken-and-egg — CI needs them to deploy), and the initial data load needs the gitignored
> `data/` files. Do steps 1–2 once, locally; thereafter CI deploys on each tag and the `sigma-etl`
> cron keeps the data fresh.
  - **Local:** `pnpm exec wrangler login`, or export the same two env vars.

### Minimal API-token scopes

A custom token needs only these **Account**-level permissions (it cannot be scoped to a single
Worker — see "Access scoping" below): Workers Scripts **Edit**, D1 **Edit**, Workflows **Edit**,
Account Settings **Read**.

## 1. Provision the resources

```bash
pnpm bootstrap:apply   # creates D1 "sigma" (the only Cloudflare resource Sigma needs)
```

Capture the printed **D1 `database_id`** and set it as an env var — **not** in the committed
`wrangler.*` files, which keep a zero-UUID dummy that local dev (miniflare) uses unchanged. The
deploy script renders a sibling `wrangler.deploy.<ext>` with the real value via
[scripts/wrangler-render.mjs](../scripts/wrangler-render.mjs).

- **Local deploy:** `cp .env.example .env.local`, fill in `SIGMA_D1_ID`, then
  `set -a; source .env.local; set +a` before `pnpm deploy`.
- **CI deploy:** add `SIGMA_D1_ID` as a repo secret alongside `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` (and `ETL_REFRESH_SECRET` — see Notes);
  [deploy.yml](../.github/workflows/deploy.yml) already wires them through.

> The D1 `database_id` **must be identical** in `web` and `etl` so the explorer reads what the refresh
> writes — a single `SIGMA_D1_ID` env var feeds both. To deploy into another Cloudflare account, just
> set a different value; no file edit needed. Page caching is done via `Cache-Control` headers
> ([apps/web/app/lib/cache.ts](../apps/web/app/lib/cache.ts)) — no KV namespace needed.

## 2. Load the data into the remote D1

```bash
node scripts/import.mjs --remote   # migrate → admin export → fx → NUTS → normalize → precompute
```

> **Bulk-load caveat.** `import.mjs` runs each step via `wrangler d1 execute --remote --file`, which
> is the only bulk-import path in wrangler 4.x (there is no `wrangler d1 import` command despite older
> docs). It's slow over the API for the ~190k-row staging + domain tables but feasible — figure ~20
> min for a fresh remote load. The full DB is ~1.4 GB incl. staging — within the 10 GB Paid limit.
>
> **Two gotchas if you load from a sqlite `.dump`:** D1 rejects `PRAGMA foreign_keys = OFF;`, `BEGIN
> TRANSACTION;`, `COMMIT;`, and `PRAGMA writable_schema = ON;` (the last is what `.dump` emits to
> recreate FTS5 virtual tables). Strip those lines, and rebuild `search_index` with the normal
> `INSERT INTO search_index ... SELECT ... FROM contracts` recipe from
> [scripts/precompute.sql](../scripts/precompute.sql) — don't ship FTS content via dump.
>
> After the first load, the daily Workflow keeps it fresh incrementally (it never reloads the base).

## 3. Deploy

**CI (on a version tag):** cut a release → [deploy.yml](../.github/workflows/deploy.yml) ships
`sigma` + `sigma-etl`:
```bash
git tag v1.0.0 && git push origin v1.0.0
```
(or run it by hand from the Actions tab).

**Manual:**

```bash
pnpm --filter @sigma/web run deploy   # react-router build && wrangler deploy → the `sigma` worker
pnpm --filter @sigma/etl run deploy   # → the `sigma-etl` worker (registers the cron + RefreshWorkflow)
```

`apps/web` is named **`sigma`**, so this **replaces the static v1 mock** at
`sigma.<subdomain>.workers.dev` with the live SSR explorer (and attaches the D1 + KV bindings).

## 4. Verify

- Open `https://sigma.<subdomain>.workers.dev/` — real totals (190k contracts · ~50.8 bn €).
- Dashboard → **Workflows** → `sigma-refresh` is listed. Trigger one run to confirm the live
  `data.egov.bg` round-trip:
  ```bash
  # The refresh routes require the shared secret (the worker fails closed without it):
  curl -X POST -H "Authorization: Bearer $ETL_REFRESH_SECRET" https://sigma-etl.<subdomain>.workers.dev/etl/refresh
  curl -H "Authorization: Bearer $ETL_REFRESH_SECRET" https://sigma-etl.<subdomain>.workers.dev/etl/refresh/<id>   # poll until "complete"
  ```
- The cron (`0 */6 * * *`) then refreshes unattended.

## Notes

- **Runtime secrets.** The explorer needs none (read-only public data; OCDS reads need no key). The
  **ETL** requires one shared secret, `ETL_REFRESH_SECRET`, gating `POST /etl/refresh` and the status
  route — the worker **fails closed (401)** without it. Generate it once with a CSPRNG
  (`openssl rand -hex 32`), store it as the repo secret `ETL_REFRESH_SECRET`, and
  [deploy.yml](../.github/workflows/deploy.yml) pushes it to the Worker via `wrangler secret put`
  (encrypted, stored separately from the bundle; the deploy refuses to ship without it). For a
  **manual** deploy, set it once yourself:
  `printf '%s' "$ETL_REFRESH_SECRET" | pnpm --filter @sigma/etl exec wrangler secret put ETL_REFRESH_SECRET --config wrangler.deploy.toml`.
  Callers then authenticate with `Authorization: Bearer <secret>` (or `X-Sigma-ETL-Secret`); rotate by
  updating the repo secret and re-deploying. The `.dev.vars` secrets remain for the parked
  `assistant`/`admin` apps — `admin` likewise fails closed without `ADMIN_BASIC_AUTH_PASS` (set
  `ADMIN_ALLOW_UNAUTH=true` only for local dev).
- **Access scoping.** Cloudflare API tokens scope by permission + account, **not down to one Worker
  script** (`Workers Scripts: Edit` is account-wide). For true "only-Sigma" isolation, put the Sigma
  workers in their own Cloudflare account and scope the token to it. Otherwise use the minimal scopes
  above and keep the token in CI rather than on a laptop.
- **Reusing the `sigma` worker.** Deploying `apps/web` overwrites whatever currently serves `sigma`
  (the static mock). The ETL is necessarily a separate worker (`sigma-etl`) — it carries a cron
  trigger and the `RefreshWorkflow` class.
