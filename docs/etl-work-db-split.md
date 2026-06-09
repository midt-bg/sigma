# ETL: work-DB backfill + staging-free live refresh

> **Status: approved + spike-validated (2026-06-08).** Implements the decision to keep ETL
> staging OUT of the served database. Branch `refactor/etl-work-db-split`. Design prose in
> English; user-facing copy in Bulgarian. Extends [etl-pipeline.md](etl-pipeline.md).

## Why

`apps/web` reads the served D1 directly, and in local dev it shares `apps/api`'s miniflare D1
file (`apps/web/vite.config.ts` `persistState` -> `../api/.wrangler/state`). The ETL `raw_*`
staging (~1.8 GB for the full 2020-2026 corpus, dominated by `raw_egov_tenders`/`_contracts`)
bloated that shared file past what `workerd` would open, breaking the web app with
`SQLITE_CANTOPEN`. Staging is a transform **work-area**, not an archive — the storage.eop.bg
per-day buckets (cached in `data/eop/`) are the durable raw source. So staging must never live
in the served DB.

## Decision

- **Backfill** runs the full ELT (`load-eop` -> `derive-amendments` -> `load-fx` -> `normalize-egov`)
  in a **throwaway plain-SQLite work file** (no D1 size/CPU limit), then **ships only domain +
  reference + amendments** into the served D1 and runs **`precompute` ON the served D1** (rollups +
  FTS built natively by D1).
- **Live refresh** runs against the served D1 with **no persistent staging** — it stages the small
  recent window in **transient** `raw_*` tables, derives, then drops them; dedup/parents/identity/
  enrichment reconcile against the **served domain**.
- **Amendments** are promoted to a **served domain table** so the `current_value`/`annex_count`
  rollup history lives in the served DB (today it lives only in staging, and the live path's
  OCDS-row rollup is silently broken — this fixes it).

## Spike validation (2026-06-08)

- Range `2026-05-20..2026-06-07`: sqlite3 work-DB vs isolated miniflare-D1 domains were
  **byte-identical** — full-row diffs `0/0` for contracts/authorities/bidders/tenders/lots, strict
  ID-set diffs `0/0`, and the Cyrillic `UPPER()`/`TRIM()`/consortium/name-key logic matched exactly
  (51 consortia, 50 name-keyed bidders both ways). Independently re-verified by attaching both DBs.
- `precompute` ran on a served DB with all `raw_*` **dropped**: built `search_index` (FTS5,
  `MATCH 'договор'` -> 26 rows), all rollups populated. **Confirms the FTS/precompute-on-served
  simplification** (no need to copy FTS shadow tables across DBs).
- **FX foreign-currency parity:** validated on `2021-05-04..2021-05-06` (CHF/CZK) — foreign
  contracts produced identical `amount_eur`/`signing_value_eur`/`fx_rate`/`fx_converted` work-DB vs
  D1 (e.g. CHF `c:206` -> 34670.251326, CZK `c:207` -> 2502.668750), `assertFxPopulated` 0 both.
  Mechanical: `load-fx.mjs` needs a `--work-db` / `--out` target switch (it hardcodes
  `wrangler d1 execute`), mirroring the switch `load-eop.mjs` needs.

## Verified facts (adversarial workflow, 2026-06-08)

- **No served query reads `raw_*`** (every `packages/db/src/queries/*.ts` reads only
  domain + precompute + reference + FTS) -> removing staging from the served DB is safe.
- **`precompute.sql` reads only domain tables** -> it runs on the served DB.
- Full-history staging dependencies and where they resolve:
  1. **Amendment rollup** (`derive-amendments.sql`) -> moves to the served `amendments` table.
  2. **EOP cumulative-bucket dedup** + 3. **OCDS-vs-EOP "EOP wins" dedup** -> already reconcile
     against the served `contracts` domain (`base-wins` `c:[eo]:` GLOB scoping); bounded in the live
     path by the lookback window.
  4. **`data_freshness`** (MAX/COUNT over staging) -> recompute from served `contracts`.

## Schema (served D1)

- **ADD** domain `amendments`: `id` (`'am:'||unp||':'||contract_number||':'||<natural-key>`),
  `contract_number`, `unp`, `value_before/after/delta`, `currency`, `published_at`,
  `document_number`, `description`, `source`; INDEX `(unp, contract_number)`.
- **REMOVE** `raw_*` from the served schema. **Split**: `0000_init.sql` becomes the *served* schema
  (domain + precompute + reference + FTS + `amendments`); a new `scripts/work-staging-schema.sql`
  holds the `raw_*` DDL, applied only to the work DB.
- **KEEP**: all domain, precompute, reference (`fx_rates`, `nuts_regions`, `data_freshness`),
  `search_index`. `contracts.current_value`/`annex_count` stay (the rollup; `amendments` is its
  source history).

## Files / phases

1. **Schema** — `packages/db/migrations/0000_init.sql` (+`amendments`, −`raw_*`); new
   `scripts/work-staging-schema.sql`.
2. **Backfill** — `scripts/import.mjs` (`--work-db=<path>` mode: transforms via `sqlite3` on the
   work file; new ship phase); `scripts/load-eop.mjs` + `scripts/load-fx.mjs` (target switch so they
   apply to the work sqlite); new `scripts/ship-domain.mjs` (copy served tables work->served D1 in FK
   order, chunked apply, then run `precompute` on the served D1); promote-amendments step (work DB:
   populate `amendments` + roll onto `contracts`).
3. **Live refresh** — `apps/etl/src/index.ts` (transient `raw_*` create/drop around the slice);
   `packages/ingest/src/refresh.ts`; `scripts/refresh-slice.sql` (promote amendments to served +
   rollup from served + `data_freshness` from served); `scripts/derive-amendments.sql` -> promote/
   rollup against the served domain (shared by backfill + live).
4. **Verify** — parity + idempotency tests; ship to local served D1; web smoke; adversarial review.

## Local-dev impact

`apps/web` reads `apps/api/.wrangler`'s served D1 directly; once the ship phase writes that D1, the
web app reads it with no re-import. The work DB (`data/work/*.sqlite`, gitignored under `data/`) is
invisible to the web app. `import.mjs --reset` also cleans `data/work/`.

## Risks / verify-in-build

- `load-fx.mjs` target switch (FX into the work DB) — see the FX spike's recommended change.
- Transient temp-table visibility across the Worker's `db.batch()` (fallback: real tables + `DROP`).
- EOP republish lag <= `lookbackDays` (live-path dedup correctness) — verify empirically.
- Amendment natural key reliably populated (`document_number` / `correction_number`).
- Ship FK ordering + remote-apply idempotency/resumability.

## Out of scope (separate approval)

- Remote D1 deploy (schema + domain ship to remote) — needs explicit per-deploy approval.
- Retiring the legacy CLI slice path.

## Deployment caveats accepted for this phase

- `ship-domain.mjs` is idempotent and avoids a global empty served database, but it is still not a zero-downtime ship: each served table is briefly deleted and refilled during its own pass. The served D1 should not be read by the live web app mid-ship. Production remote deployment should use a shadow-table/swap or equivalent zero-downtime promotion.
- Amendment IDs use a stable natural key. When `document_number`, `correction_number`, and `seq_no` are all missing, the fallback key is deterministic content (`published_at`, values, currency, description). Two genuinely distinct amendments with identical fallback content are intentionally indistinguishable in this phase.
- Live refresh and full normalize currently assign different surrogate contract IDs. The live slice
  uses a composite natural key (`c:e:<unp>:<contract_number>:<lot>:<bidder>:<ordinal>`), while the
  full normalize still uses the staging rowid. Convergence is therefore measured on contract content,
  not on the surrogate `id`; contract content (`amount`, `value_flag`, `amount_eur`, FX fields) is
  byte-identical and `SUM(amount_eur)` matches to the cent. Recommended follow-up: move both paths to
  the composite key, which also removes the pre-existing rowid instability across rebuilds.
- Synthetic `neizvestna` tenders without a real procurement notice derive placeholder
  `cpv_code`/`estimated_value` from contracts. The live slice can only aggregate the refreshed
  window, while full backfill aggregates the full corpus, so a small number of placeholder tenders can
  differ until the next full re-base. This is accepted as low blast radius and eventual-consistent for
  this phase.
- Entities born in a live window whose best contact or enrichment-bearing OCDS party falls outside
  that window can stay unenriched until the next full re-base. The live slice only sees transient
  parties for the refreshed window; full backfill sees the whole corpus and reconciles these fields.
