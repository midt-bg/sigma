# Dev + preview setup — exact steps

Copy-paste runbook for standing up the **`dev`** and **`preview`** environments. For the *why* behind
this design (shared dev D1, web-only previews, etc.), see [`dev-environments.md`](dev-environments.md).

Assumes repo `midt-bg/sigma` and GitHub Environments named exactly **`dev`** and **`preview`** (the
workflows match on those names).

> **Secrets:** run the `wrangler`/`gh` commands in your own terminal. Replace `<YOUR_ROTATED_TOKEN>`,
> `<D1_DATABASE_ID>`, and `<YOUR_CLOUDFLARE_ACCOUNT_ID>` with real values — never commit them or paste
> them into chat/tickets. The Cloudflare **Account ID is not strictly secret** (it appears in dashboard
> URLs), but it's a permanent account identifier, so keep it out of the repo too — find it at
> `dash.cloudflare.com` → any domain/Workers page, or via `wrangler whoami`.

Prerequisites:
- Cloudflare **Workers Paid** plan (needed for the etl Workflow + the ~1.4 GB D1).
- **R2 enabled on the account** — one-time, dashboard only (`dash.cloudflare.com/<acct>/r2` → Enable R2). `bootstrap-r2.mjs`'s bucket create fails with `code: 10042` until this is done; no token/CLI can enable it.
- An API token scoped to **Account-level only** — `Workers Scripts: Edit`, `D1: Edit`, `Workers R2 Storage: Edit`, `Account Settings: Read` (no Zone permissions, so it cannot touch domains/DNS in the account).

---

## Step 1 — Authenticate wrangler with the rotated token

```bash
export CLOUDFLARE_API_TOKEN='<YOUR_ROTATED_TOKEN>'
export CLOUDFLARE_ACCOUNT_ID='<YOUR_CLOUDFLARE_ACCOUNT_ID>'
pnpm exec wrangler whoami        # should show the account + the 4 scopes
```

## Step 2 — Provision the dev D1 + R2 (yields SIGMA_D1_ID)

```bash
# D1 (served data) — prints the database_id
SIGMA_D1_NAME=sigma-dev node scripts/bootstrap.mjs --apply

# R2 (CSV-export cache) — separate script so bootstrap.mjs stays untouched on this PR
SIGMA_CSV_CACHE_NAME=sigma-csv-cache-dev node scripts/bootstrap-r2.mjs --apply
```

Copy the **`database_id`** UUID that `wrangler d1 create` prints — that is `SIGMA_D1_ID` for both
environments below.

## Step 3 — Create the two GitHub Environments

```bash
gh api --method PUT repos/midt-bg/sigma/environments/dev
gh api --method PUT repos/midt-bg/sigma/environments/preview
```

Leave both **without required reviewers**, or dev deploys and previews will block.

## Step 4 — `dev` environment (3 secrets + 5 variables)

```bash
# secrets
gh secret   set CLOUDFLARE_API_TOKEN  --env dev --repo midt-bg/sigma --body '<YOUR_ROTATED_TOKEN>'
gh secret   set CLOUDFLARE_ACCOUNT_ID --env dev --repo midt-bg/sigma --body '<YOUR_CLOUDFLARE_ACCOUNT_ID>'
gh secret   set SIGMA_D1_ID           --env dev --repo midt-bg/sigma --body '<D1_DATABASE_ID_FROM_STEP_2>'

# variables
gh variable set SIGMA_WEB_NAME        --env dev --repo midt-bg/sigma --body 'sigma-dev'
gh variable set SIGMA_ETL_NAME        --env dev --repo midt-bg/sigma --body 'sigma-etl-dev'
gh variable set SIGMA_WORKFLOW_NAME   --env dev --repo midt-bg/sigma --body 'sigma-refresh-dev'
gh variable set SIGMA_D1_NAME         --env dev --repo midt-bg/sigma --body 'sigma-dev'
gh variable set SIGMA_CSV_CACHE_NAME  --env dev --repo midt-bg/sigma --body 'sigma-csv-cache-dev'
```

## Step 5 — `preview` environment (3 secrets + 2 variables)

Previews are **web-only and share the dev D1**, so `SIGMA_D1_ID` here is the **same** id as dev, and
there are no ETL/workflow names. Do **not** set `SIGMA_WEB_NAME` — the workflow computes
`sigma-pr-<number>` per PR.

```bash
# secrets
gh secret   set CLOUDFLARE_API_TOKEN  --env preview --repo midt-bg/sigma --body '<YOUR_ROTATED_TOKEN>'
gh secret   set CLOUDFLARE_ACCOUNT_ID --env preview --repo midt-bg/sigma --body '<YOUR_CLOUDFLARE_ACCOUNT_ID>'
gh secret   set SIGMA_D1_ID           --env preview --repo midt-bg/sigma --body '<SAME_D1_DATABASE_ID_AS_DEV>'

# variables
gh variable set SIGMA_D1_NAME         --env preview --repo midt-bg/sigma --body 'sigma-dev'
gh variable set SIGMA_CSV_CACHE_NAME  --env preview --repo midt-bg/sigma --body 'sigma-csv-cache-dev'
```

## Step 6 — (optional, can be later) load data into the dev D1

An empty D1 deploys fine; pages show zeros until loaded.

First apply the schema to the new remote D1 (the dev name isn't in the migrate config, so use
`d1 execute`, not `migrations apply`):

```bash
SIGMA_D1_NAME=sigma-dev wrangler d1 execute sigma-dev --remote --file packages/db/migrations/0000_init.sql
```

Then load the corpus. The work-DB path builds a local SQLite from the EOP feed, then ships it
chunked to the remote D1 and runs precompute:

```bash
SIGMA_D1_NAME=sigma-dev SIGMA_D1_ID=<dev-d1-id> \
  node scripts/import.mjs --work-db --remote
```

> **Migrate step / alternate-named D1.** `scripts/ship-domain.mjs` first runs
> `wrangler d1 migrations apply $SIGMA_D1_NAME`, which only resolves DB names present in the committed
> migrate config (`apps/web/wrangler.jsonc`) — `sigma-dev` is not there, so that step errors. The schema
> is already applied via `d1 execute` above, so for this one-time seed add a **temporary, uncommitted**
> `d1_databases` entry for `sigma-dev` to `apps/web/wrangler.jsonc` for the duration of the load, then
> revert it. (Ongoing freshness is handled by the deployed `sigma-etl-dev` cron, so this manual path is
> only needed for the initial seed or a full reset.)

> **Timing.** Only fast (~20 min) if `data/eop` is already cached. With no cache it first fetches the
> **whole feed (2020→today)** — plausibly 1–3 h. For a quick, still-useful dev dataset, narrow the
> window, e.g. `--from=2024-01-01`. If a prior ship failed midway, wipe the domain tables first
> (children-first `DELETE`) so the full replace doesn't hit FK orphans, then re-run. Transient D1 API
> errors on large chunks are normal — `SHIP_RETRIES=5 SHIP_MAX_FILE_BYTES=8000000` rides them out.

---

## What goes where

| Name | Type | `dev` | `preview` | Value |
|---|---|:--:|:--:|---|
| `CLOUDFLARE_API_TOKEN` | secret | ✅ | ✅ | rotated token |
| `CLOUDFLARE_ACCOUNT_ID` | secret | ✅ | ✅ | `<YOUR_CLOUDFLARE_ACCOUNT_ID>` |
| `SIGMA_D1_ID` | secret | ✅ | ✅ | dev D1 `database_id` (same in both) |
| `SIGMA_WEB_NAME` | var | ✅ | — | `sigma-dev` |
| `SIGMA_ETL_NAME` | var | ✅ | — | `sigma-etl-dev` |
| `SIGMA_WORKFLOW_NAME` | var | ✅ | — | `sigma-refresh-dev` |
| `SIGMA_D1_NAME` | var | ✅ | ✅ | `sigma-dev` |
| `SIGMA_CSV_CACHE_NAME` | var | ✅ | ✅ | `sigma-csv-cache-dev` |

---

## Using it

- **Deploy any branch to dev** (works once `deploy.yml`/`preview.yml` are on `main` — Actions runs
  workflow definitions from the default branch):
  ```bash
  gh workflow run deploy.yml --ref <branch> -f environment=dev
  ```
- **Ephemeral previews** run automatically: open a PR → `sigma-pr-<n>.<subdomain>.workers.dev` is
  deployed and the URL is posted as a PR comment → torn down on close.
- **Auto-reaping:** `preview-reap.yml` runs on a schedule and deletes any `sigma-pr-<n>` worker that
  has gone **5 days** without a redeploy (configurable via `PREVIEW_MAX_AGE_DAYS`). This backstops
  idle-but-open PRs and orphans whose close-time teardown failed; a new push redeploys the preview.
  It only ever deletes ephemeral preview workers — the shared dev D1/R2 and long-lived workers are
  refused by the same allowlist `teardown-remote.mjs` enforces.
