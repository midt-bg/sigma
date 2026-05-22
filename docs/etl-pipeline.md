# ETL pipeline — multi-source ingestion (design)

> **Status: design, not built.** Decided 2026-05-22. The forward plan for moving from
> one-shot Excel loads to a repeatable, refreshable ETL pulling the АОП open data from
> [data.egov.bg](https://data.egov.bg). It supersedes the single-source bootstrap in
> [data-ingestion.md](data-ingestion.md) (which stays as the xlsx-adapter reference).
> Lands in the same domain tables the core explorer reads ([core-scope.md](core-scope.md)).
>
> Design prose in English; user-facing copy in Bulgarian.

## Goal

Replace the manually-provided workbooks with an ETL that **backfills** the historical АОП data
(2007–2025 CSV) **once** and then **stays current from the OCDS feed** (the rich 2026+ JSON),
is re-runnable and idempotent throughout, and **closes the
[core-scope](core-scope.md#data-dependencies-this-scope-needs) propagation gaps** in the same
pass — because the new staging carries those fields anyway.

## Sources (data.egov.bg — АОП org `e9a95e08-7759-497a-a478-55f331d59447`)

~27 datasets; 18 CSV / 9 JSON; CC0 / CC-BY. Both pre-ЦАИС РОП and ЦАИС ЕОП data.

| Source | What it carries | Period | Format | Role here |
| --- | --- | --- | --- | --- |
| Обществени поръчки (incl. the 2007–2015 set) | opened procedures: authority, subject, **procedure type**, dates, EU/thresholds, participant presence | 2007–2025 | CSV | procedure-level spine; recovers procedure_type/estimated where the contracts set lacks them |
| Договори (annual) | authority → contractor → value → date | 2007–2025 | CSV | the money spine (matches the current data) |
| Изменения (annual) | per-contract amendments | annual | CSV | **annex count** + value-growth-over-time (a field neither xlsx nor core had) |
| OCDS release packages | full nested model: parties / tender / lots / awards / contracts / bids / amendments | 2026+ | JSON | richest; **the only ongoing/live feed** |
| `data/*.xlsx` (bootstrap) | the current ~129k rows | — | xlsx | one-time backfill, superseded once CSV lands |

**CSV is a one-time backfill; OCDS is the only ongoing feed.** The three CSV sets cover *closed*
historical years (2007–2025) and are ingested **once**. From **2026 the live feed is OCDS**,
which carries every new procedure, contract, and amendment — including amendments to historically
backfilled contracts, linked by `УНП`/`ocid`. So there is no CSV↔OCDS time overlap to reconcile;
the only historical overlap is xlsx↔CSV (and the xlsx is droppable once the CSV backfill is
validated).

Open against these is settled by **Phase 0** below: exact API methods + auth (anonymous file
URLs vs api_key), CSV encoding (UTF-8 vs Windows-1251), decimal/date conventions, and the
**column-parity check** — whether the contracts CSV carries procedure_type / CPV / estimated, or
those must be joined from the procurements set on `purchase_id`.

## Architecture — one domain, many feeds

Today is single-source (`xlsx → raw_aop_contracts → normalize`). Generalize to **per-source
adapters writing one canonical staging table**, so the domain build is source-agnostic:

```
data.egov.bg API ─fetch─► cached file (CSV: договори/изменения/поръчки) ─┐
OCDS JSON (2026+) ─fetch─► cached file (release packages) ───────────────┤ adapters
data/*.xlsx (bootstrap) ─────────────────────────────────────────────────┘  (pure fns)
                                                                              ▼
                                                              canonical staging (stg_*)
                                                                              │ normalize v2 (rebuild)
                                                                              ▼
                            authorities · tenders · lots · bidders · contracts
                                          + amendments (new) + provenance / freshness
```

**Canonical staging.** A generalization of `raw_aop_contracts`: the **superset** of every
modeled field the domain *and* core-scope need (sector, bids_received, eu_funded, contract_kind,
signing_value, current_value, contract_number/subject, contract_end_date), plus a `source`
discriminator, a derived **natural key**, and a **content hash** for idempotency. An optional
raw-JSON column preserves any unmapped source fields, so nothing is silently dropped. The cached
download files are the lossless per-source artifacts. **This table is the seam that merges the
multi-source work and the core-scope propagation into one migration.**

**Adapters** (pure, runtime-agnostic functions: source bytes/rows → canonical rows): `xlsx`
(refactor of the current loader), `egov-contracts`, `egov-amendments`, `egov-procurements`,
`ocds`. Each owns its column mapping, encoding, coercion, and natural-key derivation. They live
in a **shared package** so both runtimes (below) reuse them with zero duplication.

**Loader.** Idempotent upsert into staging (`ON CONFLICT(source, natural_key)`), batched to
≤90 KB UTF-8 (the proven byte budget — Cyrillic is 2 bytes/char) and run as one atomic D1 batch.
Incremental: only resources whose content hash changed are re-loaded.

**normalize v2.** Consumes canonical staging source-agnostically; full rebuild of the domain
(deterministic and cheap); **propagates the core-scope fields**; builds a new `amendments`
domain table; and links feeds by `УНП`/`ocid` — the xlsx bootstrap is superseded by the CSV
backfill for the same historical keys, and ongoing OCDS releases **update** earlier records
(amendments, value changes) rather than colliding with them (no CSV↔OCDS time overlap).

**Provenance & freshness.** An `etl_sources` table (dataset, resource, version/etag, fetched_at,
row_count, status) drives incrementality and surfaces the **data-freshness date the IA
requires**.

## Runtime — backfill local, deltas (optionally) on a Worker

Split by **job**, not by environment; the transform logic is shared, so the split does **not**
double the work. The only non-shared code is the thin I/O shell.

| Job | Size | Runtime |
| --- | --- | --- |
| Backfill (xlsx + the 2007–2025 CSV corpus) | heavy, **one-time**, attended | **Node CLI** (`scripts/etl`), local or CI — never a Worker |
| Ongoing feed (**OCDS releases, 2026+**) | small, frequent, unattended | the **OCDS adapter**, run by the CLI on CI cron *or* a thin **`apps/etl` Worker Cron Trigger** |

The Worker only ever handles small **OCDS** deltas, so it stays under memory/CPU limits — it never
parses xlsx or CSV and never does bulk. Porting the *whole* pipeline into a Worker is the
anti-pattern (it duplicates logic and blows the limits); sharing the adapters and assigning each
job to the right runtime is what keeps it cheap. Until the Worker is wired, the CLI on a schedule
(or manual) does the OCDS job too.

- **CLI surface:** `etl:fetch` / `etl:load` / `etl:normalize` / `etl:refresh` with
  `[--full | --since=YEAR]` and `[--remote]`.
- **Secrets:** the data.egov.bg api_key lives in `.dev.vars` / a Wrangler secret — never
  committed (treated as a production registry credential per [AGENTS.md](../AGENTS.md)).

## Dedup & identity

- **Natural key (contract):** `УНП + lot_number + contract_number`, falling back to
  `tender_internal_id`; this is also the link to OCDS `ocid`. Within a feed: `ON CONFLICT` replace.
- **xlsx ↔ CSV (historical):** the 2007–2025 CSV backfill is the system of record for past years;
  the xlsx is the pre-portal bootstrap, dropped once the CSV backfill is validated (kept meanwhile
  only for any fields the parity check shows the CSV lacks).
- **CSV ↔ OCDS:** no time overlap (≤2025 vs ≥2026). OCDS **continues** the timeline and updates
  earlier records (amendments, value changes) by `УНП`/`ocid` — a linkage, not a dedup conflict.
- The existing grain rules carry over (a `tender_internal_id` collapses to one tender; each award
  line is its own contract — see [data-ingestion.md](data-ingestion.md)).

## Phasing

| Phase | Work | Delivers |
| --- | --- | --- |
| **0 — Spike** (read-only) | pull one real contracts + amendments + procurements resource; confirm API/auth, encoding, and column parity | locked staging columns; go/no-go; findings note |
| **1 — Canonical staging + propagation** | migration to the superset schema; refactor the xlsx loader into the first adapter; normalize v2 propagates core-scope fields | multi-source-ready schema **and** the core-scope data-dependencies, in one migration |
| **2 — egov CSV backfill** (one-time) | fetcher + provenance; egov-contracts / -amendments / -procurements adapters; bulk load of 2007–2025 | the full historical corpus from the portal |
| **3 — OCDS adapter (2026+)** | release-package parsing → staging; idempotent **incremental** load keyed by `ocid` | the **ongoing/refreshable** feed; multi-supplier awards feed the (parked) consortium members for free |
| **4 — Scheduling** (optional) | the **OCDS** delta on CI cron, or a thin `apps/etl` Worker Cron Trigger | unattended refresh; freshness surfaced in the UI |

Phases 1–4 are sequenced after Phase 0 confirms the source reality. Phase 1 alone is worth doing
even if the portal ingest slips, because it closes the core-scope gaps.

## Open questions (resolved by the Phase 0 spike)

- Exact data.egov.bg API methods + auth — anonymous resource URLs vs api_key from the Developer
  Cabinet.
- CSV encoding, delimiter, decimal and date formats.
- Column parity: contracts CSV self-contained, or procedure_type / CPV / estimated joined from
  the procurements set on `purchase_id`?
- Cross-source dedup precedence for overlapping years.
- OCDS access — a live endpoint vs bulk file download.
- The exact CSV→OCDS handoff — is the cutover clean at 2025/2026, or does any CSV extend into 2026?

## Cross-references

- What the ingested data feeds: [core-scope.md](core-scope.md).
- Current single-source bootstrap (the xlsx adapter, in effect): [data-ingestion.md](data-ingestion.md).
- Schema + transform: [0000_init.sql](../packages/db/migrations/0000_init.sql),
  [0001_raw_aop.sql](../packages/db/migrations/0001_raw_aop.sql),
  [normalize-aop.sql](../scripts/normalize-aop.sql).
