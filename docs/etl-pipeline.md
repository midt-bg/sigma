# ETL pipeline — multi-source ingestion

> **Status: admin ЦАИС ЕОП export loaded AND normalized into the domain locally (May 2026).**
> The pipeline is now **two sources**: the **admin export** as the authoritative 2020–2026 base,
> and the **OCDS JSON feed** ([data.egov.bg](https://data.egov.bg)) as the go-forward 2026+ delta.
> The xlsx bootstrap and the portal contracts CSV are **retired** (the CSV kept only as the
> coverage-comparison baseline). What remains: the **remote D1 push** and **OCDS scheduling**.
> Feeds the core explorer ([core-scope.md](core-scope.md)).
>
> Design prose in English; user-facing copy in Bulgarian.

## Goal

A repeatable, idempotent ETL that loads the **authoritative admin ЦАИС ЕОП export** for 2020–2026
**once**, then **stays current from the OCDS feed** (the rich 2026+ JSON), and **closes the
[core-scope](core-scope.md#data-dependencies-this-scope-needs) propagation gaps** in the same
pass — the admin export carries the procedure-level fields per row, so `normalize` propagates
them directly (no separate enrichment join).

## Schema (one file, not a chain)

Migrations exist to evolve a schema **without losing existing data**. Sigma is pre-production with
no deployed data — every import runs against a **fresh** database — so an incremental migration
chain would be pure overhead (and accumulates churn: a column added then renamed, retired tables,
vestigial slots). The schema therefore lives in a **single [`0000_init.sql`](../packages/db/migrations/0000_init.sql)**
that defines the final shape directly. We still use the migrations *directory* (it is how `wrangler`
applies schema to D1, local and remote); we re-introduce incremental migrations the first time there
is deployed data that cannot be dropped.

## Current state — implemented (May 2026)

The admin export is **loaded into staging AND normalized into the domain** in the local D1
(`sigma`). The earlier portal-CSV/xlsx ingest is superseded; see [Source history](#source-history)
for how we got here and what each retired loader still covers.

**Schema + scripts.** One command — `pnpm import` ([`scripts/import.mjs`](../scripts/import.mjs)) — runs
the whole pipeline; `--reset` rebuilds from a fresh DB, `--remote` targets Cloudflare.

- [`migrations/0000_init.sql`](../packages/db/migrations/0000_init.sql) — the **whole schema in one file**
  (domain + `raw_egov_*` staging + `fx_rates` + the `contract_participants` view). Pre-production and
  fresh-start, so a single schema file, not an incremental migration chain — see [Schema](#schema-one-file-not-a-chain).
- [`scripts/load-admin.mjs`](../scripts/load-admin.mjs) — admin export loader (Contracts / Tenders / Annexes, 2020–2026) → `raw_egov_*` staging.
- [`scripts/derive-amendments.sql`](../scripts/derive-amendments.sql) — rolls `current_value` + `annex_count` onto contracts.
- [`scripts/load-fx.mjs`](../scripts/load-fx.mjs) — ECB signing-date rates for foreign currencies → `fx_rates`.
- [`scripts/normalize-egov.sql`](../scripts/normalize-egov.sql) — full rebuild of the domain from staging (cleaning, `value_flag`, canonical EUR).
- [`scripts/load-ocds.mjs`](../scripts/load-ocds.mjs) — the **separate** go-forward OCDS 2026+ delta (run after, with dedup).

**Loaded into local D1 — staging (`source LIKE 'admin:%'`):**

| Table | Rows | Contents |
| --- | --- | --- |
| `raw_egov_contracts` | 190,428 | admin contracts, 2020–2026 (rich per row, `needs_enrichment = 0`) |
| `raw_egov_tenders` | 323,290 | admin procedures, lot-grained (one header row + one row per lot, per УНП) |
| `raw_egov_amendments` | 24,744 | admin annexes (изменения), 2020–2026 |

**Normalized into the domain (`scripts/normalize-egov.sql`):**

| Domain table | Rows | Notes |
| --- | --- | --- |
| `authorities` | 4,868 | deduped on ЕИК; 4,867 carry a `type` (Вид на възложителя) |
| `tenders` | 139,718 | 128,070 from the tenders-export header rows + 11,648 **synthetic** for contract-only УНП |
| `lots` | 195,220 | one per lot row |
| `bidders` | 17,354 | keyed by ЕИК (valid) or **normalised name** (4,442 name-keyed); **3,716 consortia** |
| `contracts` | 190,427 | 190,428 admin rows − 1 nameless; **17,470 amended**; value_flag: 172 value_suspect / 55 annex_suspect / 758 review |

Canonical total **≈ 50.8 bn EUR** (`SUM(amount_eur)`, errors excluded; see [Data quality](#data-quality)).
Currency is kept **per row** on `amount` (BGN pre-2026, EUR from 2026, 49 foreign) — see [Currency](#currency-not-one-unit).

**Where it's stored.** The local Cloudflare D1 database `sigma`, on disk under
`apps/api/.wrangler/state/v3/d1/` (miniflare SQLite, via `wrangler … --local`). The admin export
(`data/Open_data_resources.zip`) and the generated load SQL (`data/*-load.sql`) sit in `data/`,
which is **gitignored**. **Nothing is on the remote D1 yet** — `database_id` is still the `0000…`
placeholder. A remote import needs Cloudflare auth: `wrangler login` → `pnpm bootstrap:apply`
(creates the D1) → put the printed `database_id` into `apps/api/wrangler.toml` →
`node scripts/import.mjs --remote`.

**Known deliberate gap — the РОП register.** The admin export is **ЦАИС-ЕОП only**, so it omits
the legacy РОП (Регистър на обществените поръчки) contracts — ~28k thin pre-ЦАИС rows, mostly
2020 (≈20k), tailing off through 2023. Coverage of the ЦАИС era is otherwise complete (99.98 % vs
the open data, values matching 99.98 %). We chose **admin-only** and do **not** backfill РОП; if
full pre-2020 coverage is ever needed, the retired portal CSV loader can add those rows as thin
(procedure-less) contracts.

## Multi-source expansion (May 2026)

The pipeline grew from "admin-only" to a **multi-source** model under two standing principles:
**capture-all** (every field a source offers lands in raw staging, even with no UI yet — the domain
promotes what we use) and **live ETL** (each open feed has an idempotent periodic delta job; heavy
backfills stay one-time CLI). Branch: `feat/ingest-all-sources`.

**Admin export — now fully captured.** `load-admin.mjs` maps **every** column of all three CSVs
(Contracts 57 / Tenders 52 / Annexes 37) into `raw_egov_*`. Newly promoted to the domain: contract
`eu_programme` (operational-programme name — was thought external-only), `duration_days`, `winner_size`,
`subcontractor_eik/name/value`, `bids_sme/bids_rejected/bids_non_eea`, `eauction/framework/accelerated/
strategic`; tender `place_of_performance` (a **NUTS code** — tender-level region), `start_date/end_date/
duration`, tender-level `eu_programme`, `green/social/innovation/cancelled`. The empty **`bids` table was
dropped** (no source publishes per-offer bids; only counts/statistics).

**OCDS parties + award suppliers** (`load-ocds.mjs` → `raw_ocds_parties`, `raw_ocds_award_suppliers`).
Every release party (ЕИК, name, roles, full address incl. NUTS) is captured; `normalize-egov.sql`
enriches `authorities`/`bidders` `nuts/settlement/address` by ЕИК (the 2026+ entities OCDS covers). The
loader also captures **every award supplier** — `supplier_count > 1` marks a joint venture / consortium
(the member breakdown OCDS exposes), feeding the parked owner layer.

**Trade Register** (`load-tr.mjs` → `raw_tr_companies/_owners/_actual_owners`; domain `company_owners`
+ `beneficial_owners`). Parses the Агенция по вписванията **daily XML deltas** (data.egov.bg
`2df0c2af-…`) via `fast-xml-parser`: company seat (+ ЕКАТТЕ), partners/sole owner/managers, and
**ActualOwners** (beneficial owners, чл. 63 ЗМИП). Personal IDs are **hashed at source** — only name +
country stored. `normalize` enriches bidder seat/legal_form by ЕИК and (re)builds the owner tables.

**Full backfill is POSTPONED (decided 2026-05-24).** The open API is only daily *deltas* from
**2022-09-01** (no full-snapshot dump exists; the earliest files are normal-sized deltas, and the
"monthly extract" dataset is a different — property — register). Importing all ~1,686 deltas would
still miss companies dormant since before 2022-09. So instead we will load an **admin full export of
the entire register** (being obtained separately) as the one-time base; then `load-tr.mjs` (daily
deltas — `--all`/`--limit`, chunked resumable apply) plus the scheduled job keep it current — that is
the "delta updates for new data" path. **Until that base is loaded, treat the Trade Register as NOT
available** for functionality decisions. The loader, `raw_tr_*` staging, `company_owners`/
`beneficial_owners` domain tables and the scheduled job are all ready and simply unused; `import.mjs`
does not run `load-tr`, so a default rebuild has no TR data.

**NUTS reference** (`load-nuts.sql` → `nuts_regions`). The stable Eurostat/НСИ classification (28
области → 6 NUTS2 → 2 NUTS1) labels the OCDS-sourced NUTS codes and fills `authorities.region`.

**Scheduled live ETL** ([.github/workflows/etl-refresh.yml](../.github/workflows/etl-refresh.yml)).
A daily GitHub Actions cron runs the CLI delta loaders against remote D1 (OCDS catch-up + TR daily
window + NUTS seed + derive-amendments + normalize). The loaders need Node + a filesystem + XML
parsing, so CI cron is their home; the `apps/etl` Worker stays for light in-Worker tasks. No-ops until
`CLOUDFLARE_API_TOKEN` + a real `database_id` are configured.

**Deferred (documented blockers).** **ИСУН** (EU-funds project detail / consortium roles): its
data.egov.bg dataset URI is **not API-discoverable** (`listDatasets` ignores `org_id`; org 104's
reachable datasets aren't ИСУН) and the SPA isn't reliably scriptable — and its headline value, the
programme **name**, is already captured from the admin export, so it's low priority. **Settlement-level
ЕКАТТЕ classifier**: the open data.egov.bg ЕКАТТЕ resource is dead (returns empty); the TR already
supplies readable settlement/municipality names, and `nuts_regions` covers region aggregation.

## Currency (not one unit)

Unlike the xlsx (all EUR), the admin export spans the **BGN→EUR switch**: 2020–2025 contracts are
in **BGN**, 2026 in **EUR**, plus 49 foreign-currency contracts (USD/CHF/GBP/TRY/SEK/CZK). `normalize`
keeps each row's **native currency** on `amount`/`currency` (the faithful as-recorded value) and also
derives the canonical **`contracts.amount_eur`** for safe aggregation: BGN→EUR at the fixed peg
(÷ 1.95583), EUR as-is, and **foreign currencies at the ECB reference rate on the contract's signing
date** (`fx_rates`, loaded by [`scripts/load-fx.mjs`](../scripts/load-fx.mjs) via frankfurter.app;
`fx_converted = 1` marks those rows and `fx_rate` stores the applied rate on the row, so `amount` ×
`fx_rate` = `amount_eur` is auditable without a join). So `SUM(amount_eur)` is a clean single-currency total.
Display in лева is `amount_eur × 1.95583` (IA editorial principle #1). This corrects the earlier
"storage unit is EUR" framing being absent in [core-scope.md](core-scope.md).

## Data quality

The admin register carries a small number of **source** data-entry errors. They were investigated
(May 2026) and are handled in `normalize-egov.sql` **non-destructively** — staging stays raw; the
verdict (`value_flag`) and the clean amount (`amount_eur`) are derived columns (see the `contracts`
table in [0000_init.sql](../packages/db/migrations/0000_init.sql)).

- **Value errors (~213 contracts, 0.12 % of rows but ~12 % of the naive total).** A signed or amended
  value ≥100× the procurement's estimate. Raw-cell inspection shows a **dropped decimal comma at
  source** (signing `6938481985,00` vs estimate `69384819,85`), and a **cross-check against the
  open-data portal found the identical wrong values** (same ЦАИС source — 108/108 matched, none
  corrected) — so they are upstream errors, not a load artifact, and are **not recoverable**. Hence
  `value_flag`, never a fabricated correction:
  - `value_suspect` — the signed value itself is ≥100× the estimate → **excluded** from `amount_eur`.
  - `annex_suspect` — an amendment pushed `current_value` ≥100× signing (or negative); the signing
    value is sane (matches the estimate) → **fall back to signing**, so the contract still counts
    (e.g. the ЕТ whose annex read 4.6 bn falls back to its 113 500 signing).
  - `review` — 10–100× (gray zone: some real frameworks, some errors) → kept, flagged.
- **Recipient identity.** Bidders are keyed by ЕИК when valid (9/13 digits), else by **normalised
  name** — stopping the collapse where ~595 distinct withheld-ЕИК (`не се публикува`) contractors
  merged onto one node, and recovering 839 contracts whose contractor had a name but no ЕИК.
- **Foreign currency.** The 49 USD/CHF/GBP/TRY/SEK/CZK contracts are converted to `amount_eur` at the
  ECB reference rate on the **signing date** (`fx_converted = 1`); the raw `amount`/`currency` is kept.
- **Minor** (negligible, surfaced not altered): 33 out-of-range dates, 187 zero-value, the 1 negative
  (resolved by the annex fallback), ~269 duplicate `(УНП, contract_number)` keys (mostly real multi-lot).

Net canonical headline `SUM(amount_eur)` (every currency in EUR, errors excluded) ≈ **50.8 bn EUR**.

## Sources

Two sources feed the domain today, plus retired loaders kept for history.

| Source | What it carries | Period | Format | Role |
| --- | --- | --- | --- | --- |
| **Admin ЦАИС ЕОП export** (`data/Open_data_resources.zip`) | Contracts / Tenders / Annexes — rich per row: procedure type, CPV (+ label), estimated/signing/current value, lots, authority type, EU funding, bid count, consortium flag | 2020–2026 | CSV (nested zips) | **authoritative base**; loaded once by `load-admin.mjs` |
| **OCDS release packages** (data.egov.bg, org `502`) | full nested model: parties / tender / lots / awards / contracts / bids / amendments | 2026+ | JSON | **the ongoing/live feed**; `load-ocds.mjs` |

The admin export covers through its snapshot date (2026-05-22), so OCDS is the mechanism to stay
current after it — and the gap is **not** a data-loss risk: the OCDS periods are a **retained,
backfillable archive** (currently 2026-01-01 → 05-06, published fortnightly), so whenever you deploy
you catch up the whole window. At go-live, `load-ocds --all` pulls every period (overlapping the admin
base) and `normalize` dedupes — **admin wins**: an OCDS contract is taken only when no admin row shares
its **`contract_number`** (the АОП contract document number, the cross-feed key — OCDS keeps its `ocid`,
e.g. `ocds-e82gsb-…`, in `unp`, which never matches the admin УНП). **Validated**: loading the full
overlapping OCDS feed (12,436 contracts) moved the total only **190,427 → 190,429** (the 2 genuinely-new
ones), not +12k. `data_freshness` records the "current as of" date per feed.

**Go-live catch-up runbook:**
1. *(best)* refresh the admin export for a recent base;
2. `node scripts/load-ocds.mjs --all --apply` (overlaps the admin base);
3. re-run `normalize-egov.sql` (dedup, admin wins) — e.g. via `node scripts/import.mjs --remote` steps.

**Caveat for OCDS-as-primary** (not needed while admin is the base — OCDS adds only a handful of new
contracts today): because OCDS keeps its `ocid` in `unp`, OCDS-only contracts get an `ocid`-keyed
synthetic tender, and the amendment rollup (`derive-amendments.sql`, keyed on `unp`+`contract_number`)
won't attach OCDS amendments to admin contracts. Before OCDS becomes the authoritative feed, map the
real АОП УНП in `load-ocds.mjs` (or re-key those joins on `contract_number`). A contract whose УНП has
no tenders-export row gets a **synthetic tender** so it always has a parent.

## Source history

The pipeline reached the admin export through two now-retired ingests:

- **xlsx bootstrap** — two sector workbooks (~129k rows, all EUR) into a `raw_aop_contracts` staging
  table. Thin and EUR-only; **fully retired** — the table, its loader (`load-aop.mjs`) and
  `normalize-aop.sql` have been removed; the domain is rebuilt from the admin export.
- **Portal contracts/annexes CSV** (`load-egov.mjs` / `load-annexes.mjs`, data.egov.bg org `502`) —
  the public "Договори и изменения" register, 2016–2023, **broader** (all sectors, incl. РОП) but
  **thinner** per row (no procedure type / CPV / estimated value; `needs_enrichment = 1`). Used to
  **verify admin coverage** (it is how we measured the 99.98 % match and found the РОП gap), kept as
  that baseline but **not part of the live pipeline**. Its **dual-schema** handling is a finding worth
  keeping: АОП ships two header layouts — ЦАИС ЕОП („Уникален номер на поръчката", „Номер на договор",
  …) and the older **РОП** (`УНП`, `ДОГОВОР НОМЕР`, uppercased, leading blank column) — so any loader
  that touches the portal CSV must match headers **by name, case-insensitively, with aliases** (without
  it, РОП/2016–2019 files load only their two ЕИК columns).

## Architecture — one domain, many feeds

As built: per-source **loaders** write **dedicated staging tables** (rather than one canonical
`stg_*` table — the simpler choice that won), and a single SQL **rebuild** derives the domain.

```
admin export (zip: Contracts/Tenders/Annexes) ─load-admin.mjs─┐
OCDS JSON (2026+) ──────────────────────────────load-ocds.mjs─┤
                                                               ▼
   staging:  raw_egov_contracts · raw_egov_tenders · raw_egov_amendments
                    (source discriminator; scoped full-reload per feed)
                                                               │ derive-amendments.sql  (current_value + annex_count)
                                                               │ normalize-egov.sql      (full domain rebuild)
                                                               ▼
              authorities · tenders · lots · bidders · contracts
```

**Staging.** Three tables keyed by a `source` discriminator (`admin:contracts:YEAR`,
`admin:tenders:YEAR`, `admin:annexes:YEAR`, `ocds:YEAR:…`). Each feed is reloaded with a **scoped
full-reload** (`DELETE … WHERE source LIKE '<prefix>:%'`) so feeds coexist and a re-run is
idempotent. The admin export carries the procedure-level fields per row, so `needs_enrichment = 0`
and there is **no separate enrichment join** (the obsolete plan was a `УНП` merge of a thin CSV
with a later admin export — collapsed now that the admin export *is* the base).

**Loaders.** `load-admin.mjs` unzips the nested admin export and parses the EU-formatted CSVs
(comma decimals, dot dates, Да/Не booleans), batched to ≤90 KB UTF-8 (Cyrillic is 2 bytes/char)
and run as one atomic D1 batch. `load-ocds.mjs` walks OCDS release packages → contract +
amendment rows. `derive-amendments.sql` then rolls each contract's latest after-value into
`current_value` and counts annexes into `annex_count`.

**normalize v2** ([`normalize-egov.sql`](../scripts/normalize-egov.sql)). Full rebuild of the
domain from staging (deterministic, re-runnable, atomic): authorities deduped on ЕИК (+ `type`);
tenders from the tenders-export header rows plus a synthetic tender per contract-only УНП; lots
from the lot rows; bidders deduped on contractor ЕИК with a name-based consortium flag; contracts
1:1 with admin rows, `amount` = current value, with the core-scope fields propagated. Amendment
detail stays in `raw_egov_amendments` (no separate domain table) — the rollup onto contracts is
all the core needs; the full annex history feeds the parked signals.

**Freshness:** the `data_freshness` table records the "current as of" date + row count per feed
(`admin`, `ocds`), recomputed by `normalize` — this is the **data-freshness date the IA requires**.

## Runtime — backfill local, deltas (optionally) on a Worker

Split by **job**, not by environment; the transform logic is shared, so the split does **not**
double the work. The only non-shared code is the thin I/O shell.

| Job | Size | Runtime |
| --- | --- | --- |
| Backfill (the admin export, 2020–2026) | heavy, **one-time**, attended | **Node CLI** (`load-admin.mjs` + `normalize-egov.sql`), local or CI — never a Worker |
| Ongoing feed (**OCDS releases, 2026+**) | small, frequent, unattended | `load-ocds.mjs`, run by the CLI on CI cron *or* a thin **`apps/etl` Worker Cron Trigger** |

The Worker only ever handles small **OCDS** deltas, so it stays under memory/CPU limits — it never
parses the admin zip and never does bulk. Porting the *whole* pipeline into a Worker is the
anti-pattern (it duplicates logic and blows the limits); assigning each job to the right runtime is
what keeps it cheap. Until the Worker is wired, the CLI on a schedule (or manual) does the OCDS job.

- **Secrets:** **none for reads** — the OCDS feed is anonymous and the admin export is a local file.
  National-registry **write/private** credentials (НАП / Търговски регистър / АОП) remain production
  secrets, never committed (per [AGENTS.md](../AGENTS.md)); they belong to the parked owner layer.

## Dedup & identity

- **Contract identity:** one domain contract per staging row (`c:<staging id>`); a procurement is
  keyed by **УНП** (`tenders.source_id`). Note the admin УНП and the OCDS `ocid` are **different
  identifiers** — only `contract_number` is common to both feeds.
- **admin ↔ OCDS:** the admin export is the system of record through its snapshot date; OCDS
  **continues** the timeline after it. Where they overlap, **admin wins** — `normalize` takes an OCDS
  contract only when no admin row shares its **`contract_number`** (admin rows are richer). Validated:
  the full overlapping OCDS feed adds only the genuinely-new contracts, not duplicates.
- **Grain:** the tenders export is one **header row** per УНП (→ one `tenders` row) plus one row per
  **lot** (→ `lots`); each contract award line is its own contract. УНП seen only in contracts gets a
  synthetic tender so every contract has a parent.

## Phasing

| Phase | Work | Delivers |
| --- | --- | --- |
| **0 — Spike** (read-only) | pull one real contracts + amendments + procurements resource; confirm API/auth, encoding, and column parity | locked staging columns; go/no-go; findings note |
| **1 — Canonical staging + propagation** | migration to the superset schema; refactor the xlsx loader into the first adapter; normalize v2 propagates core-scope fields | multi-source-ready schema **and** the core-scope data-dependencies, in one migration |
| **2 — egov CSV backfill** (one-time) | fetcher + provenance; egov-contracts / -amendments / -procurements adapters; bulk load of 2007–2025 | the full historical corpus from the portal |
| **3 — OCDS adapter (2026+)** | release-package parsing → staging; idempotent **incremental** load keyed by `ocid` | the **ongoing/refreshable** feed; multi-supplier awards feed the (parked) consortium members for free |
| **4 — Scheduling** | **done** — `apps/etl` cron-triggered Cloudflare **Workflow** (`RefreshWorkflow`); OCDS off GitHub | unattended on-platform refresh; freshness surfaced in the UI |

**Status against this plan (the phases above are the original portal design; superseded by the
admin export):** the spike, the egov CSV backfill and the OCDS adapter all ran; the **column-parity
gap** they exposed (no procedure type / CPV / estimated in the portal CSV) is what motivated sourcing
the **admin export**, which carries those fields per row — so **normalize v2 is done** against the
admin staging (see [Current state](#current-state--implemented-may-2026)) and the УНП enrichment
merge is **obsolete**. **Remaining:** the **remote D1 push** (provision the remote D1 + secrets).

## Daily refresh Workflow (implemented — `apps/etl`)

The regular refresh runs **on Cloudflare, not GitHub** (decision 2026-05-24, superseding the
GitHub-cron `etl-refresh.yml`, now retired). `apps/etl` hosts a cron-triggered Cloudflare **Workflow**
(`RefreshWorkflow`, binding `REFRESH`); `scheduled()` calls `env.REFRESH.create()` every 6 h. Durable,
individually-retried steps:

1. **discover** — `listDatasets` (АОП org 502) → newest OCDS period + its JSON resource. (A fixture
   `releases[]` payload skips this for local tests.)
2. **ingest** (per dataset) — `getResourceData` → land the raw package in R2 (`RAW`, `ocds/<source>/…`)
   → flatten releases (`@sigma/ingest`, the in-Worker port of `load-ocds.mjs`) → upsert the contract
   staging (scoped `DELETE`+`INSERT`, bound params). The big payload stays inside the step; only the
   small `{staged}` count is persisted as the step result.
3. **derive-slice** — run [`scripts/refresh-slice.sql`](../scripts/refresh-slice.sql) via one D1
   `.batch()`.

**`refresh-slice.sql` — the scoped re-derive (the "incremental normalize" the v1 review flagged).**
It derives the OCDS go-forward delta into the domain and refreshes **only the affected** rollup/FTS
rows, never rebuilding the 190k admin base:

- New OCDS contracts get a **stable** id `c:o:<ocid>:<contract_number>` (the staging rowid is volatile
  across reloads), so the `c:o:%` set is wiped + re-derived deterministically → **idempotent**.
- **Base wins:** an OCDS row is derived only when no non-`c:o:%` contract already holds its
  `contract_number` (so a contract the admin export — or a prior full normalize — already has is never
  double-counted). Probed via `idx_contracts_cnum`.
- Mirrors `normalize-egov.sql` steps 1/2b/4/5 (authorities, synthetic `неизвестна` tenders, bidder
  identity, `value_flag` + `amount_eur`/`*_eur`) + `precompute.sql`, scoped: `company_totals` /
  `authority_totals` / `flow_pairs` / `search_index` are rebuilt for the touched entities only; the
  small globals (`home_totals`, `sector_totals`, `facet_counts`, `data_freshness`) recompute in full.
- `c:o:` prefix checks use **`GLOB`** (BINARY, PK-index-usable), not `LIKE`.

A periodic full `normalize-egov.sql` re-bases everything (rebuilds all contracts as `c:`||rowid),
which the next refresh then no-ops against. The full normalize + the admin bootstrap stay **off** the
cron path.

**Deferred (not built):** the **Trade Register** delta/backfill and its **Queue fan-out** (the
1,686-file TR history). When it lands, a Workflow step seeds a Queue and a `queue()` consumer parses
each TR XML with `fast-xml-parser` (pure JS, in-Worker), batched + retried with a dead-letter queue.
Trigger to build it: arrival of the TR full backfill.

**Verified locally** (wrangler 4.93 runs Workflows in dev): unit tests for the OCDS mappers + the SQL
splitter; `refresh-slice.sql` tested against the populated D1 (derivation, base-wins dedup,
idempotency, base-table reconciliation, unaffected entities intact); and an end-to-end Workflow run
under `wrangler dev` against a copy of the DB (fixture release → R2 + staging + scoped derive →
`{datasets:1, staged:2, derived:1}`, idempotent on re-run). The only paths not verifiable offline are
the live `data.egov.bg` round-trip (mitigated by fixtures + the proven `load-ocds.mjs` logic) and real
durable-retry timing — both confirmable on a deployed run.

## Findings (resolved during the build)

- **API:** every method is `POST https://data.egov.bg/api/<method>`; **no api_key for reads**.
  АОП is org `502`. Flow: `listDatasets` (criteria `org_ids:[502]`) → `listResources` (criteria
  `dataset_uri`) → `getResourceData` (returns the whole resource as JSON).
- **Encoding/format:** `getResourceData` returns UTF-8 JSON — for CSV resources `data` is an array
  with the **header in row 0**; cells arrive **quote-wrapped**, dates are **DD/MM/YYYY**, booleans
  **True/False**. Currency is **BGN** in the CSVs, **EUR** in OCDS 2026.
- **Column parity (the decisive finding):** the portal contracts CSV has **no** procedure_type /
  CPV / estimated_value and there is **no 2016+ procurements CSV** to recover them — which is exactly
  why we sourced the **admin export**, where every contract row carries them. That collapsed the
  planned УНП enrichment merge into a single authoritative load.
- **Dual schema:** ЦАИС ЕОП vs older РОП header layouts (see [Source history](#source-history)) —
  handled in the portal loaders by case-insensitive alias mapping; not a concern for the admin export.
- **Portal handoff gap:** the annual portal "Договори и изменения" CSVs end at **2023** and OCDS
  starts **2026**, leaving **2024–2025** uncovered on the portal — **the admin export fills it** (it
  is continuous 2020–2026), which is another reason it superseded the portal CSV.

## Cross-references

- What the ingested data feeds: [core-scope.md](core-scope.md).
- Schema (domain + staging + reference + view, one file): [0000_init.sql](../packages/db/migrations/0000_init.sql).
- Orchestrator: [import.mjs](../scripts/import.mjs) (`pnpm import`). Transform: [normalize-egov.sql](../scripts/normalize-egov.sql).
