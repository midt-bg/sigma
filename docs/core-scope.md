# Core explorer — scope & data mapping (v1)

> The build target for the first iteration. It carves a deliberately narrow subset of the
> full design ([IA](../mocks/docs/design/01-information-architecture.md),
> [screens](../mocks/docs/design/02-screens.md)): show **the deals, who receives the money,
> and the structures that order it** — and nothing else yet. The owner layer and the
> red-flag signals layer are explicitly out (see [Parked](#parked)). The pipeline that
> feeds this is [data-ingestion.md](data-ingestion.md).
>
> Design prose in English; all user-facing copy in **Bulgarian**.

**Decided 2026-05-22.** Atomic record = the awarded contract (bids surface as a count, not
per-bidder offers — those aren't in the data). Money flows are **in** the core. Owners and
red-flag signals are **parked**.

## Scope in one line

Three entities — **Институция** (authority / buyer), **Компания** (recipient, keyed by ЕИК)
and **Договор** (contract) — plus the **authority→company money flows** and the **global
search** that connect them into one navigable graph. Read-only. Storage unit is EUR;
amounts are shown in лева (IA editorial principle #1).

## In scope

| Surface | Route | What it answers |
| --- | --- | --- |
| Home | `/` | Headline totals + entry points (top buyers, top recipients) |
| Authorities | `/институции` | Every buyer, rankable and filterable |
| Authority profile | `/институции/[slug]` | One buyer: how much, on what, to whom |
| Companies | `/компании` | Recipients; defaults to top beneficiaries |
| Company profile | `/компании/[eik]` | One recipient: total won, from whom, what |
| Contracts | `/договори` | Filtered contract list |
| Contract detail | `/договори/[id]` | One deal, full provenance |
| Flows | `/потоци` | Authority→company money flows (amounts + counts) |
| Search | `/търсене` | Across names, subjects and identifiers |

The atomic record is the **awarded contract** (договор), at lot granularity per the IA: lot
rows roll up to their parent tender for display but stay addressable. "Bidding" surfaces
only as the **count of offers received** (`bids_received`) plus the procedure type —
**per-bidder offer amounts are not in the АОП data**, so there is no per-offer view.

## Parked

Out of this iteration by decision. The schema **hooks stay** so nothing has to be
re-migrated when these resume — they just have no UI or scoring in the core.

- **Owner / `Лице` layer** — beneficial owners, shared-owner patterns, the `/лица` surface.
  Needs the Търговски регистър joined on ЕИК — a separate ingest (see
  [KICKOFF](design/KICKOFF.md)). The `bidder_members` table, the `contract_participants`
  view and the `eik_normalized` join key all remain in the schema, unused by the core UI.
  Money is attributed with **lens #1 only**: `SUM(contracts.amount)` grouped by `bidder_id`
  (a consortium is credited as the single awarded entity). The member-level lens #2
  activates with this layer — see the "Which sum to use" table under
  [data-ingestion.md → Consortia](data-ingestion.md#consortia-обединения--дззд).
- **Red-flag / signals layer** — the [signal catalog](../mocks/docs/design/03-red-flag-catalog.md),
  composite scoring and the `/червени-флагове` leaderboard. The `risk_scores` table and the
  `price_benchmark` view stay; nothing in the core surfaces them.

## Surfaces & data mapping

Source tables are the domain tables in [0000_init.sql](../packages/db/migrations/0000_init.sql)
unless noted. Fields marked **†** are needed by the core but **not in the domain yet** — they
live only in staging and must be propagated; see [Data dependencies](#data-dependencies-this-scope-needs).

### Authority profile (`/институции/[slug]`)

| Shows | Source / aggregation |
| --- | --- |
| Име | `authorities.name` |
| Общо похарчено | `SUM(contracts.amount)` over contracts whose `tenders.authority_id` = this id |
| Брой договори | `COUNT(contracts)` via `tenders.authority_id` |
| Какво купува (CPV mix) | `GROUP BY tenders.cpv_code` (readable CPV names need a dictionary †) |
| Към кого (топ изпълнители) | `GROUP BY contracts.bidder_id`, `SUM(amount)` desc → `bidders.name` |
| Процедури (mix) | `GROUP BY tenders.procedure_type` |
| ЕС финансиране (дял) | share of `eu_funded` † |
| Сектор | `sector` † |
| Тип (министерство / община / агенция …) | `authorities.type` † (classification pass) |

### Company profile (`/компании/[eik]`)

| Shows | Source / aggregation |
| --- | --- |
| Име / ЕИК | `bidders.name` (display-only) / `bidders.bulstat` + `eik_normalized` (key) |
| Общо спечелено | `SUM(contracts.amount)` grouped by `bidder_id` (lens #1) |
| Брой договори | `COUNT(contracts)` |
| От кои институции | `GROUP BY tenders.authority_id` → `authorities.name` |
| Какво продава (CPV mix) | `GROUP BY tenders.cpv_code` |
| Процедури (mix) | `GROUP BY tenders.procedure_type` |
| Среден брой оферти | `AVG(bids_received)` † |
| ЕС финансиране (дял) | share of `eu_funded` † |
| Сектор | `sector` † |
| Обединение / консорциум | `bidders.kind` / `is_consortium` — shown as a neutral label, not a signal |

### Contract detail (`/договори/[id]`)

| Shows | Source |
| --- | --- |
| Възложител | `authorities.name` via `tenders.authority_id` |
| Изпълнител | `bidders.name` + ЕИК |
| Стойности: прогнозна → при сключване → текуща | `tenders.estimated_value`; `contracts.signing_value` † + `current_value` † (today `amount` collapses these via `COALESCE`) |
| Процедура | `tenders.procedure_type` |
| Брой оферти | `bids_received` † |
| Обект (вид: доставки / услуги / строителство) | `contract_kind` † |
| CPV | `tenders.cpv_code` / `lots.cpv_code` |
| ЕС финансиране | `eu_funded` † |
| Дати: сключване / край / краен срок | `contracts.signed_at` / `contract_end_date` † / `tenders.deadline_at` |
| Номер и предмет на договор | `contract_number` † / `contract_subject` † |
| УНП | `tenders.source_id` |
| Обособени позиции | `lots` under the parent tender |
| Сектор | `sector` † |

### Lists & browser

- **Authorities** / **Companies** lists — ranked tables; companies default to top
  beneficiaries by `SUM(contracts.amount)`. Both rankable and filterable.
- **Contracts browser** — filtered list; filters are URL-encoded per the IA so any view is
  shareable: year (`signed_at`), sector †, CPV, procedure type, authority, company, value
  range, EU-funded †. Every aggregate elsewhere decomposes to a filtered view of this list.

### Flows (`/потоци`)

Authority→company edges: `GROUP BY tenders.authority_id, contracts.bidder_id` →
`SUM(amount)`, `COUNT(*)`; nodes drawn from `authorities` and `bidders`; top-N by amount,
with the same sector/year/value filters carried through. **No owner column** (that toggle is
part of the parked layer).

### Search (`/търсене`)

Prefix / fuzzy match against `authorities.name`, `bidders.name`, `tenders.title` (subject),
the УНП (`tenders.source_id`) and `contract_number` †.

## Data dependencies this scope needs

The domain tables are a thin skeleton; several fields the core **displays and filters on**
still live only in staging (`raw_aop_contracts`) and must be propagated by
[normalize-aop.sql](../scripts/normalize-aop.sql). **No new data source is required** — all
but the last two rows are already loaded; this is ETL/schema work, not sourcing.

| Field | Staging column | Proposed home | Needed by |
| --- | --- | --- | --- |
| Sector | `dataset` | `tenders` (tender-level) | sector chip / filter on every list |
| Bidder count | `bids_received` (M) | `tenders` (or lot-level) | contract detail, company "среден брой оферти" |
| EU-funded flag | `eu_funded` (K) | `tenders` | contract detail, EU share, EU filter |
| Contract kind | `contract_kind` (H) | `tenders` | "обект" display + filter |
| Signing & current value (separate) | `signing_value_eur` (T), `current_value_eur` (U) | `contracts` | value-history display (keep `amount` as the headline) |
| Contract number & subject | `contract_number` (P), `contract_subject` (Q) | `contracts` | detail + search |
| Contract end date | `contract_end_date` (S) | `contracts` | contract period |
| Authority type | — (derived) | `authorities.type` | the `/институции` type filter |
| CPV labels | — (external CPV dictionary) | reference table | readable CPV mixes |

The first seven are pure propagation from staging. **Authority type** needs a classification
pass over the already-normalised names (ministry / municipality / agency / state company /
education / health / other); profiles and lists work without it (untyped). **CPV labels**
need an external CPV code→name dictionary; until then CPV surfaces by code.

## What is not in v1

Carried over from the [IA](../mocks/docs/design/01-information-architecture.md#7-what-is-not-in-v1):
no login or saved state, no editorial/story layer, no map, no compare mode, no CPV browser
screen, no write side, no public API (bulk CSV export per filtered view is in scope).

## Cross-references

- Full design (the superset this carves from): [IA](../mocks/docs/design/01-information-architecture.md),
  [screens](../mocks/docs/design/02-screens.md).
- Pipeline feeding the domain tables: [data-ingestion.md](data-ingestion.md).
- Schema: [0000_init.sql](../packages/db/migrations/0000_init.sql) (domain),
  [0001_raw_aop.sql](../packages/db/migrations/0001_raw_aop.sql) (staging + `price_benchmark`),
  [0002_consortia.sql](../packages/db/migrations/0002_consortia.sql) (parked owner hooks).
