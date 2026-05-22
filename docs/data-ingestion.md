# Data ingestion — АОП register → D1

How the procurement workbooks in [`data/`](../data) become queryable tables in
Cloudflare D1. This is the engineering reference for the pipeline; for the
product framing of the dataset and its fields see
[`docs/design/KICKOFF.md`](design/KICKOFF.md), and for the exact columns the
inline comments in [`packages/db/migrations/0001_raw_aop.sql`](../packages/db/migrations/0001_raw_aop.sql).

## Source

Two single-sheet workbooks (gitignored), each a denormalised export from the
**АОП register** (Агенция за обществени поръчки) — 23 columns (A–W), header in
row 1, one row per **contract / lot line**:

| File | Sector | Data rows |
| --- | --- | --- |
| `Храни.xlsx` | food-related procurement | 24,750 |
| `Строителство.xlsx` | construction-related procurement | 104,260 |
| | **total** | **129,010** |

Quirks the loader handles: text is Cyrillic; monetary values are in **EUR**;
dates are stored as **Excel serials**; empty cells use a single-space `" "`
sentinel; `cpv_code` / `contractor_eik` are stored as numbers in the sheet
(kept as text on ingest).

## Pipeline

```
data/*.xlsx
  │   scripts/load-aop.mjs        (SheetJS parse → SQL; runs in Node, NOT a Worker)
  ▼
data/aop-load.sql                 (~97 MB, gitignored; batched INSERTs, ≤90 KB/stmt)
  │   wrangler d1 execute --file
  ▼
raw_aop_contracts                 (staging — 23 columns, lossless, 129,010 rows)
  │   scripts/normalize-aop.sql   (clean · dedup · flag)
  ▼
authorities · tenders · lots · bidders · contracts   +   price_benchmark (view)
```

Why this shape:

- **Parse offline, not in a Worker** — the construction sheet is ~100 MB of
  uncompressed XML, past a Worker's 128 MB memory cap. SheetJS resolves shared
  strings; Excel date serials are converted to ISO-8601 UTC deterministically
  (independent of the container timezone).
- **Staging-first (ELT)** — land everything losslessly in `raw_aop_contracts`,
  then transform in SQL. Re-runnable, and nothing is dropped while the domain
  schema is still settling.
- **D1's 100 KB statement limit** — the loader budgets each `INSERT` to ≤90 KB
  of UTF-8 (Cyrillic is 2 bytes/char, so byte length ≫ JS string length).

## Files

| File | Role |
| --- | --- |
| `scripts/load-aop.mjs` | parse workbooks → `data/aop-load.sql`; `--apply` also migrates + loads staging |
| `scripts/normalize-aop.sql` | staging → domain tables (cleaning policy below) |
| `scripts/dq-aop.sql` | read-only data-quality report, re-runnable after each load |
| `packages/db/migrations/0001_raw_aop.sql` | `raw_aop_contracts` table + `price_benchmark` view |

## Commands (local)

```bash
node scripts/load-aop.mjs --apply        # parse + migrate + load staging into local D1
cd apps/api && wrangler d1 execute sigma --local --file ../../scripts/normalize-aop.sql
cd apps/api && wrangler d1 execute sigma --local --file ../../scripts/dq-aop.sql   # quality snapshot
```

`load-aop.mjs` reloads staging (`DELETE` + insert); `normalize-aop.sql` is a **full
rebuild** of the domain — it clears the derived tables and re-inserts, so a re-run
always reflects the current rules and leaves no stale rows. wrangler runs each file as
one atomic D1 batch, so a failed run rolls back. After a (re)load the pipeline order is
**load → normalize → recompute risk scores** (`apps/etl`), since the rebuild clears
`risk_scores`/`bids` as FK dependents. Remote loading is not wired yet — `database_id`
is a placeholder; create the real D1 with `pnpm bootstrap:apply`, then add `--remote`.

## Staging → domain mapping

| Domain table | Source | Notes |
| --- | --- | --- |
| `authorities` | distinct `authority_name` | keyed on a normalised form (UPPER + collapsed whitespace) → merges case/spacing-only duplicates |
| `tenders` | top-level rows (`parent_tender_id IS NULL`) | one per `tender_internal_id`; `source_id` = `unp` |
| `lots` | child rows (`parent_tender_id` set) | 1:1 with staging rows |
| `bidders` | distinct `contractor_eik` | raw ЕИК kept verbatim + quality flags (below) |
| `contracts` | awarded rows (contractor + value) | 1:1 with staging rows |
| `price_benchmark` (view) | the register | contract-value distribution per CPV + kind |

## Cleaning policy

Staging stays **100% raw**; all cleaning is in `normalize-aop.sql`. Anomalies are
*surfaced* (via `dq-aop.sql` / flags), not silently rewritten.

- **Currency** → `EUR` (the source columns say "(евро)"; the schema's `BGN`
  default does not apply to this data).
- **Authorities** → deduped on the normalised key (2,687 → 2,654; 33 phantom
  duplicates were pure case/whitespace variants). A canonical display name is kept.
- **Contractor ЕИК** → kept verbatim in `bidders.bulstat`, plus three derived flags:
  - `eik_normalized` — digits-only ЕИК when recoverable (e.g. strips a `"ЕИК "`
    label prefix, preserving leading zeros), else `NULL`.
  - `eik_valid` — `1` when `eik_normalized` is a valid 9- or 13-digit ЕИК
    (8,321 of 8,510 distinct contractors).
  - `is_consortium` / `kind` — flags joint ventures (multi-id ЕИК field **or**
    `ДЗЗД`/`ОБЕДИНЕНИЕ`/`КОНСОРЦИУМ` in the name); see the Consortia section below.
  - The ~190 invalid values (`"не се публикува"`, company name in the ЕИК field,
    foreign ids) stay visible for the cartel / related-party module; downstream
    joins clean identities on `eik_normalized`.
- **Grain** — a `tender_internal_id` can appear on several top-level rows, but the
  audit shows `unp` + `authority` never diverge, so the `OR IGNORE` collapse to one
  tender is lossless; each award line stays its own `contracts` row.
- **Anomalies left in place, reported by `dq-aop.sql`** — 58 zero-value signings,
  2 negative values, 2 contracts ending before they start, 22 deadlines in 2027+,
  and 621 contracts whose current value exceeds 2× the signing value (an
  annex-growth red-flag signal for the analysis module).

## `price_benchmark` view

Per `cpv_code` + `contract_kind`: `n`, `avg_value`, `min_value`, `max_value`,
`median_value` of the signing value. The register has **no quantities/units**, so
these are *contract-value* benchmarks, not unit prices. Use **median** as the
reference — `avg` is skewed by the few huge framework contracts (e.g. CPV
`45000000` works: median ≈ €135k vs avg ≈ €1.3M against a €180M max). 1,736
CPV+kind categories are covered.

## Consortia (обединения / ДЗЗД)

Many awarded "contractors" are joint ventures — `ДЗЗД`, `ОБЕДИНЕНИЕ`, `КОНСОРЦИУМ` —
that bid as one entity but stand for several member companies. Here **738 bidders**
are flagged `kind = 'consortium'` (~1,718 award rows); detection uses name markers
and multi-id ЕИК fields (`is_consortium`).

Model (`migrations/0002_consortia.sql`):

- `bidders.kind` ∈ {`company`, `consortium`} — the contract stays awarded to the
  consortium entity, so the award fact is never lost.
- `bidder_members(consortium_id, member_eik, member_id, share_pct, source)` records
  participants. Populated **now** only from the few ЕИК fields that list several ids
  (`source = 'in_field'`) — and in this data that yields 0, because those
  separator values are court / foreign registration numbers (`212/5724/1684`,
  `J08/53/2002`), not Bulgarian ЕИК lists. Most consortia carry a single own ЕИК, so
  their members must come from the **Търговски регистър / БУЛСТАТ** open data joined
  on ЕИК — a later pipeline. Until then those contracts surface as
  `consortium_unresolved`.
- `contract_participants` (view) explodes contracts to participating companies:
  `sole` company → one row; resolved consortium → one row per member;
  `consortium_unresolved` → the consortium entity itself.

**Attribution rule.** `allocated_amount` splits each contract's value across its
participants so it is **always safe to `SUM`** — at any grouping (per company, per
person, grand total), with no dedupe. A sole winner or an unresolved consortium
carries the full value on one row (`is_estimated_split = 0`); resolved consortium
members get an equal split (`amount / member_count`, `is_estimated_split = 1`) until
documented shares (`bidder_members.share_pct`) replace it. For the full headline
contract value, read `contracts.amount`.

**Which sum to use.** There are two correct, additive money lenses — pick by the
question; never mix them in one total:

| Question | Query | Notes |
| --- | --- | --- |
| Money **won** by an entity (Топ бенефициенти, authority spend) | `SUM(amount)` over `contracts`, grouped by `bidder_id` (or by `authority_id` via `tenders`) | one row per contract; a consortium is credited as the single awarded entity |
| Money **flowing to** participating companies (member- / owner-level totals) | `SUM(allocated_amount)` over `contract_participants`, grouped by `participant_eik` | consortium value is split across resolved members; per-contract value is conserved |

Both are double-count-free. The first is the headline beneficiary number; the second
pushes consortium money down to member companies once they're resolved (today, with 0
resolved members, the two lenses give identical totals).

## Caveats / next steps

- `dataset` (which workbook) **≠** `contract_kind` (column H): the Строителство
  file contains works **and** related services/supplies.
- Lot rows inherit tender-level fields (`authority_name`, `procedure_type`, `unp`,
  `published_ojeu`) as `NULL` — by design; they live on the parent.
- `scripts/seed.sql` is a **pre-AOP placeholder** for an empty dev DB; once AOP data
  is loaded, `normalize-aop.sql` owns the domain and replaces those demo rows (they do
  not coexist). `pnpm setup` re-seeds an empty DB.
- **Beneficial ownership** is not in this data (only `contractor_eik`); the
  owner-network layer needs the Търговски регистър joined on ЕИК — see KICKOFF.
