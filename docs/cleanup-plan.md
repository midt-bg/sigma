# Cleanup plan — single-source EOP, remove stale apps & dead code

**Status:** proposed — nothing executed. A descriptive task list (no line numbers on purpose — the
working tree is volatile, so anchor on symbol/file names and re-ground at execution time).

**Scope rules (per decisions):**
- `mocks/` and `docs/` are **left as-is** — out of scope for this cleanup.
- The `raw_egov_*` / `raw_ocds_*` staging tables **stay** — they are live transform-only staging, never
  persisted in the served DB (see §3). Not obsolete, not renamed.
- The `etl-work-db-split` re-architecture has **landed on `main`**; re-ground against the current tree
  before executing (other ETL work, e.g. R3, may still be in flight).

**Provenance:** the orphan/dead-code findings come from a symbol-level grep audit (authoritative).
`graphify` (installed locally for Claude + Codex) was used to map module-level dependencies — it
corroborated that the three stale apps are low-connectivity modules, but its AST symbol extraction is
incomplete for this TS workspace, so it is not the source of the symbol-level orphan list.

---

## 1. Remove the three non-deployed apps

The v1 deploy set is only `@sigma/web` + `@sigma/etl`. Remove:
- **`apps/assistant`** — stub; replaced by `apps/web/app/lib/assistant/` on `feat/ai-assistant`.
- **`apps/admin`** — parked ops UI, never deployed.
- **`apps/api`** — never deployed; the explorer reads D1 directly via `@sigma/db`.
- **`packages/assistant-tools`** — imported only by `apps/assistant`.

**Relocate the local D1 anchor first (before deleting `apps/api`).** The local miniflare **served** D1
that `pnpm dev` reads is rooted under `apps/api/.wrangler/state`. Everything that targets it points at
`apps/api`: `scripts/import.mjs`, `scripts/setup.mjs`, `scripts/teardown.mjs`, **`scripts/ship-domain.mjs`**
(new — the work-DB-split shipper), and `apps/web/vite.config.ts`. Repoint all of them to `apps/web`
(which already declares an identical D1 binding), relocate the existing state, and smoke
`setup → import → dev` before removing `apps/api`.

> Note (work-DB split, now on main): `pnpm import` builds into a **throwaway work DB** at
> `data/work/backfill.sqlite` (applies the migrations + `work-staging-schema.sql`, runs `load-eop`),
> then `ship-domain.mjs` ships only the domain/precompute/reference tables to the **served** D1. Only
> the *served*-D1 location (the `apps/api` anchor) relocates; the work DB path is independent.

**Other references to update:** the "consumed by apps/api" comment in `@sigma/api-contract`; the
`ADMIN_BASIC_AUTH_*` block in `.dev.vars.example` (keep `AI_GATEWAY_*`); the api/assistant/admin port
forwards in `.devcontainer/devcontainer.json`; and the apps/packages rows in `README.md`.

**Follow-ups:** `pnpm install` (regenerate the lockfile — don't hand-edit), then typecheck/build/test.
The deploy workflow targets only web+etl, so it is unaffected.

---

## 2. Make `storage.eop.bg` the sole import source

**Delete the obsolete-source loaders:** `scripts/load-admin.mjs` (admin/ЦАИС export),
`scripts/load-ocds.mjs` (retired `data.egov.bg` wrapper), `scripts/load-tr.mjs` (Trade Register via
`data.egov.bg`). None is invoked by `import.mjs`.

**Strip the `admin:%` source handling from shared statements (keep the eop/ocds arms):**
- the `admin:%` disjunct in the `normalize-egov.sql` source filter,
- the `admin:%` pricing branch in `load-fx.mjs` (the FX loader otherwise stays whole),
- the unreachable `admin` arm of the id-prefix CASE in `normalize-egov.sql` (live ids are `c:e:%`/`c:o:%`),
- the admin "bare-id rows win" guards in `refresh-slice.sql`.

**Keep — looks admin/egov but the eop path reuses it:** the `raw_egov_*` staging tables (transform-only
— see §3), the `raw_ocds_*` tables, the OCDS mappers in `@sigma/ingest`, the `idx_egov_*` indexes, and
the FX + NUTS **reference** loaders (`load-fx.mjs` minus its admin branch; `load-nuts.sql`).

---

## 3. `raw_egov_*` / `raw_ocds_*` staging — KEEP (transform-only, never served)

These are **not** obsolete and are **not** renamed — they are the live load+transform staging schema.
The architecture invariant (the work-DB split already on `main`) is that **no `raw_*` table ever
persists in the served database**:
- **Backfill:** `load-eop` populates `raw_egov_contracts/_tenders/_amendments` (+ `raw_ocds_*`) in a
  throwaway sqlite **work DB**; the transforms (`normalize-egov.sql`, `derive-amendments.sql`) read them
  to build the domain; only the domain / precompute / reference tables ship to the served D1.
- **Live refresh (Worker):** the same tables are created **transiently** in the served D1, the window is
  staged into them, `refresh-slice.sql` reads them, and they are **dropped at the end of the run**.
- Their DDL lives in `scripts/work-staging-schema.sql` (applied to the work DB / created transiently),
  **not** in `0000_init.sql`. The served DB holds **zero `raw_*` tables** — that is the core invariant.

So keep the `raw_egov_*` / `raw_ocds_*` tables, the `idx_egov_*` / `idx_ocds_*` indexes, and the OCDS
mappers as-is. The `egov` name reflects the data **shape**, independent of the storage.eop.bg source —
the earlier "rename to eop-named staging" idea was based on a misunderstanding and is dropped.

> **R3 has landed:** the curated **served** `parties` table (`packages/db/migrations/0002_parties.sql`)
> is live and read by `normalize-egov.sql` (authority nuts/address/contact enrichment). It is a clean
> domain-style projection, distinct from the transient `raw_ocds_parties` — keep it; it is not a cleanup
> target. (Schema is now four migrations: `0000_init` + `0001_amendments` + `0002_parties` +
> `0003_tender_eop_id`; the `bidder_members` / `contract_participants` / `risk_scores` objects in §5/§8
> are still in `0000_init.sql`.)

---

## 4. Remove the parked Trade-Register chain

The owner tables are already gone on this branch; what remains is small and self-contained:
- the `raw_tr_companies` staging table + its index in `work-staging-schema.sql`;
- the "Company master from the Trade Register" block in `normalize-egov.sql`;
- in `@sigma/ingest`'s `refresh.ts`, the guard that exists **only** to spare `raw_tr_companies`
  (`isExcludedWorkTable`) — delete it and simplify the staging filter;
- the `raw_tr_companies` fixture/assertion in `ocds.test.ts`;
- the "Trade Register" mentions in `@sigma/db`'s `schema.ts` comments.

**Safety:** no live route reads TR tables. `company.tsx` → `getCompany` reads only
`company_totals` / `bidders` / `contracts` / `tenders` / `authorities`. The `bidders` address &
legal-form columns **stay** (also populated from OCDS parties / NSI); only the TR enrichment stops.

---

## 5. Remove the parked consortium-attribution layer

Confirmed fully dead (no `INSERT/UPDATE INTO bidder_members`; no `FROM/JOIN contract_participants`;
both result-shape interfaces have zero importers):
- the `bidder_members` table + its index, and the `contract_participants` view, in `0000_init.sql`;
- the no-op `DELETE FROM bidder_members` in `normalize-egov.sql`;
- the `BidderMemberRow` and `ContractParticipantRow` interfaces in `@sigma/db`'s `schema.ts`.

**Keep — this is the LIVE path, not the dead layer:** `parseConsortiumMembers` /
`ConsortiumMembership` (`@sigma/shared`) and `ConsortiumParticipant` (`@sigma/api-contract`) parse the
`contractor_name` string for display and are used by `@sigma/db`'s `details.ts` and
`apps/web/.../companies.tsx`. Only their stale "TR backfill parked" comments need updating.

---

## 6. Remove orphan / unused code (symbol audit)

**Standalone orphans — safe to remove now (referenced only in their own file):**
- `getSectorTotals` + `SectorTotalRow` in `@sigma/db`'s `queries/sectors.ts`;
- `CPV_CATEGORY_BY_DIVISION` in `@sigma/config` (used only by `categoryForDivision` in-file).

**Config orphans (zero external refs):** `PRICE_INDEX_CATEGORIES` (with its derived `PriceIndexCategory`
type + comment), `CURATED_SECTORS`, `RISK_BAND_LABELS`. **Keep** `CpvSector`, `RiskBand`, `requireEnv`
(all have live callers).

**Over-exported helpers — drop the `export`, keep them as private (used only in-file + their own test):**
`monthYear` (`@sigma/shared` format), `encodeCursor`/`decodeCursor` (`@sigma/db` keyset),
`searchMoreHref` (`@sigma/db` search), `CONTRACTS_PER_SITEMAP` (`@sigma/db` sitemaps),
`toSecuredFinancing`/`toVariants`/`baseColumnKind` (`@sigma/ingest` base),
`splitSqlStatements`/`transientStagingStatements`/`dropTransientStagingStatements` (`@sigma/ingest`
refresh), and `ISODate`/`Brand`/`isDefined`/`assert` (`@sigma/shared` index).

**Remove together with the dead apps (these go orphan once apps/api + apps/admin are gone — remove
with them, not before, or the build breaks):**
- `@sigma/db` exports used only by api/admin: `getTenderById`, `listRecentTenders`, `sectorBreakdown`,
  `SectorBreakdownRow`;
- the legacy `@sigma/api-contract` DTO surface: `TenderSummary`, `TenderDetail`, `SearchTendersQuery`,
  `SearchTendersResponse`, `SectorsResponse`, `ApiError`, `API_ROUTES`;
- `Money` / `Currency` in `@sigma/shared` — remove once the legacy `estimatedValue` DTO that uses them
  is gone.

---

## 7. Owner-gated (decide intent before removing)

- **`raw_ocds_award_suppliers`** — staged (a writer exists) but **never read** (no `FROM`/`JOIN`), even
  after R3's `parties` projection landed (R3 enrichment reads `parties`, not this table). Wired-but-unused
  supplier normalization. Remove the table + its writer only if supplier normalization is confirmed
  abandoned (any further R3 supplier work would revive it).

---

## 8. Keep (looks dead, isn't) — guardrails

- `@sigma/analysis` + the `risk_scores` schema + `upsertRiskScore` — parked, but `feat/ai-assistant`
  wires `@sigma/analysis` into the web app.
- `@sigma/db`, `@sigma/config`, `@sigma/shared`, `@sigma/api-contract` (live parts);
  `CpvSector`/`RiskBand`/`requireEnv`.
- FX + NUTS reference data; the `raw_egov_*` / `raw_ocds_*` staging tables, `idx_egov_*` / `idx_ocds_*`
  indexes, and OCDS mappers — **live transform-only staging, never served** (§3); the `bidders` /
  `authorities` master tables.
- `apps/web`, `apps/etl`.
- `mocks/` and `docs/` — intentionally untouched this pass. (Aside: `docs/deploy.md`'s cron section
  still describes the retired `data.egov.bg` feed and is stale, but it is out of scope here.)

---

## 9. Sequencing & verification (when approved, after the etl-refactor settles)

1. Re-ground against the then-current tree.
2. **Privatizations + standalone orphans first** (§6 in-file helpers, `getSectorTotals`, `CPV_CATEGORY_BY_DIVISION`) — zero cross-package risk.
3. **Apps + their dependents together** (§1, plus the §6 "remove with the apps" exports/DTOs) — including the D1-anchor relocation done and smoke-tested before deleting `apps/api`.
4. **Single-source EOP strip** (§2).
5. **TR chain** (§4) and **consortium layer** (§5), each atomic.
6. **Config orphans** (§6).
7. `pnpm install`; verify `pnpm --filter @sigma/ingest test`, then `pnpm -w typecheck` (gate per-package — `db` `details.test.ts` is pre-existingly red), `pnpm -w build`, `pnpm -w test`; confirm the deploy workflow still resolves `@sigma/web` + `@sigma/etl`.
