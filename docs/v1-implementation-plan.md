# V1 implementation plan — the public explorer

> Turning the rendered mockups in [`mocks/v1/`](../mocks/v1/) into a working React Router v7 app on
> the domain we built. Companion to [mock-coverage.md](mock-coverage.md) (what the data supports) and
> [core-scope.md](core-scope.md) (intended scope). This is the **build plan**.
>
> Assessed against a freshly built local D1 (2026-05-24): 4,868 authorities · 147,024 tenders ·
> 195,220 lots · 17,448 bidders · 190,429 contracts · **50.84 bn € clean** (`SUM(amount_eur)`).

## Locked decisions

1. **Currency: EUR only.** Display `amount_eur` directly — no лв., no FX at display time. Bulgarian
   number abbreviations stay (млн. / млрд. / хил.), decimal comma. The mock's BGN copy is rewritten to €.
2. **Scope: read-only explorer.** The 9 explorer pages on the data we hold. **No** risk/signals layer,
   **no** owners/persons layer, **no** price benchmark, **no** map, **no** auth/registration, **no**
   public HTTP API expansion. (All explicitly parked in methodology.html + core-scope.)
3. **Data path: web loaders query D1 directly** via a shared `@sigma/db` query layer. `apps/web` gets a
   D1 binding. CSV/JSON exports are React Router **resource routes** in `apps/web`. **`apps/api` is left
   untouched** (it remains the seed of a future public API).

## Architecture

`apps/web` (React Router v7 SSR on Workers) **is** the whole v1 app.

```
request → apps/web Worker (workers/app.ts) → RR loader → @sigma/db query fn → env.DB (rollups + base) → SSR HTML
```

- **Query truth** lives once, in `@sigma/db`. Loaders and (later) `apps/api` both consume it.
- **DTO truth** lives in `@sigma/api-contract` (typed loader return shapes).
- **Deterministic labelling** (CPV sectors, procedure groups) lives in `@sigma/config`.
- **Formatting** (EUR, dates, ЕИК/УНП, %) lives in `@sigma/shared`.
- **Heavy aggregates are precomputed** by normalize into rollup tables — loaders read those, not a
  per-request `GROUP BY` (see [Precompute layer](#precompute-layer-normalize--explorer)).

### Workspace changes per package

| Package | Change |
| --- | --- |
| `apps/web/wrangler.jsonc` | add `d1_databases` binding `DB` → `sigma` (page caching is done via `Cache-Control` headers — no KV) |
| `apps/web/workers/app.ts` | `Env` already flows via `AppLoadContext.cloudflare.env`; regenerate `worker-configuration.d.ts` so `env.DB` types |
| `apps/web/app/routes.ts` | add all routes below |
| `apps/web/app/components/` | new — the shared UI (shell + primitives + charts) |
| `apps/web/app/lib/` | new `format.ts`, `filters.ts` (URLSearchParams ↔ typed filter state) |
| `@sigma/db` | new `queries/` module — one function per page-section (read-only); reads rollups for aggregates |
| `@sigma/api-contract` | add `Company*`, `Authority*`, `Contract*`, `Flows*`, `Search*` DTOs |
| `@sigma/config` | add `PROCEDURE_GROUPS` (real values below) + `ENTITY_TYPES` |
| `@sigma/shared` | add the formatting helpers |
| `packages/db/migrations/0000_init.sql` | add the rollup tables, the `search_index` FTS5 vtable, and `*_eur` value columns |
| `scripts/normalize-egov.sql` | populate the rollups + FTS + `*_eur`; the daily Workflow recomputes the touched slice |

### Apps in scope & where the ETL lives

The explorer is **`apps/web`** alone (loaders query D1 directly). The scheduled data refresh runs on
**`apps/etl`** as a Cloudflare Workflow. The rest stay as-is:

| App | In scope? | Role |
| --- | --- | --- |
| `apps/web` | **yes — the explorer** | RR7 SSR, all 9 pages |
| `apps/etl` | **yes — the refresh** | cron-triggered Cloudflare **Workflow** — the on-platform ETL (Queue fan-out deferred, see below) |
| `apps/api` | no — untouched | thin JSON API (4 routes); the future **public** API. Web does not route through it. |
| `apps/admin` | no — later | auditor/controller ops UI |
| `apps/assistant` | no — later | AI Procurement Assistant (stub) |

**The regular refresh runs on Cloudflare, not GitHub** (decision 2026-05-24, superseding the GitHub-cron
approach). `apps/etl` hosts a cron-triggered Workflow: `scheduled()` calls `env.REFRESH.create()`; the
Workflow runs durable, individually-retried steps — fetch the OCDS (+TR) delta over HTTP → land raw in
R2 (`RAW`) → upsert staging → **scoped re-derive** of the touched slice (domain rows + their
rollups/FTS; see [Precompute layer](#precompute-layer-normalize--explorer)) → record freshness. The Worker `fetch()`es sources straight into memory (no filesystem); `fast-xml-parser` is
pure JS and runs in-Worker. The daily delta is tiny (OCDS feed + eventually 1–2 TR files), so a single
Workflow step handles it; the initial OCDS catch-up paginates across steps.

Bindings to add now in `apps/etl/wrangler.toml`: `[[workflows]]`; `RAW` R2 + `DB` D1 + the cron already
exist.

**Queue fan-out — deferred (not built now).** The only workload that needs a Queue is the eventual
1,686-file **TR backfill**, which is postponed. When it lands, a Workflow step **seeds a Queue** and a
`queue()` consumer parses+upserts each file with batching, retries, a dead-letter queue and a
`max_concurrency` cap — so the full TR history runs on-platform. This is a **non-breaking add** (one new
step + a consumer handler + `[[queues.producers]]`/`[[queues.consumers]]` bindings); nothing in the
daily path changes. Trigger to build it: arrival of the TR full backfill.

**Stays off the cron path:** the full-rebuild `normalize-egov.sql` (a CLI job, or a Workflow run on
demand) and the one-time admin-xlsx bootstrap (`pnpm import`, or an R2 upload the Workflow ingests).
GitHub Actions keeps **only the deploy job** — it is no longer an ETL runtime. The main engineering
item is the per-run **scoped re-derive + rollup/FTS refresh** (above), not a naive row upsert. Fuller
design lands in [etl-pipeline.md](etl-pipeline.md) when this is built.

## Precompute layer (normalize ⇄ explorer)

The review surfaced the coupling the first draft missed: **the explorer must not recompute aggregates
per request.** Every leaderboard, the home KPIs, the sector facet and the flows Sankey would otherwise
be full `GROUP BY` scans over 190k contracts × 3 joins — and D1 meters rows read and caps query time. So
**normalize (and the daily Workflow) precompute read-optimised artifacts** and the explorer reads those.
This makes the tracks dependent: a slice of normalize ships *before/with* the list pages, not after.

**Rollup tables** (built by normalize; refreshed each Workflow run):

| Table | Grain | Feeds |
| --- | --- | --- |
| `home_totals` | 1 row | index KPIs + freshness (`refreshed_at`) |
| `company_totals` | per bidder | companies leaderboard: won €, contracts, #authorities, kind, sector mix, period |
| `authority_totals` | per authority | authorities leaderboard: spent €, contracts, avg, #suppliers, type_group |
| `sector_totals` | per CPV division | sector facet + filter counts |
| `flow_pairs` | per (authority, bidder) | flows Sankey + table |

Leaderboards become `SELECT … FROM *_totals WHERE <filters> ORDER BY won DESC` + keyset — a small
indexed read. Facet dimensions kept at the grain (sector division, year, eu) are **columns** on the
rollup so they stay one indexed scan; rare cross-cuts fall back to the base tables.

**`*_eur` value timeline.** Only `amount_eur` is converted today (and it is `NULL` for `value_suspect`),
while `estimated_value`/`signing_value`/`current_value` are raw native (mostly BGN, some foreign). The
contract page needs estimated→signing→current **all in EUR**, so normalize materialises
`estimated_value_eur`, `signing_value_eur`, `current_value_eur` (peg ÷1.95583 for BGN, row `fx_rate` for
foreign) + the signed delta. **Display rule:** render a value only when its `*_eur` is non-null; for
`value_suspect`/`annex_suspect` the suspect figure is suppressed behind a „данните се преглеждат" note —
never a fabricated number.

**Search index (FTS5).** A `search_index` FTS5 virtual table (built by normalize) over authority names,
bidder names + ЕИК, and contract subject + УНП, with a **Cyrillic + Latin, accent/case-folded**
tokenizer (`unicode61 "remove_diacritics 2"`), columns tagged by entity kind so hits group. Replaces the
naive `LIKE` (which can't case-fold Cyrillic and full-scans). Search becomes a ranked `MATCH`.

**How it stays fresh.** The full rebuild (CLI / on-demand Workflow) builds all of the above. The daily
Workflow, after upserting the delta, runs a **scoped re-derive of only the touched УНП/entities** and
**recomputes their rollup + FTS rows** — this is the realistic shape of the "incremental normalize"
item. The admin-wins dedup + cross-table enrichment make a fully-incremental domain pass tricky, so we
re-derive the affected slice and refresh its artifacts rather than rebuild everything.

## Design-system port (Tailwind v4)

The mock is an **editorial** look: warm paper, serif display, mono eyebrows, ink hairline rules. Port
the OKLch tokens verbatim into `app/app.css` `@theme`, and rebuild the CSS classes as React components
(no heavy `@apply`).

**Tokens** (from `mocks/v1/assets/styles.css`):

```css
@theme {
  --color-paper:     oklch(98.5% 0.008 80);
  --color-ink:       oklch(18%   0.012 70);
  --color-ink-mid:   oklch(38%   0.010 70);
  --color-ink-soft:  oklch(56%   0.008 70);
  --color-rule:      oklch(86%   0.008 75);
  --color-rule-soft: oklch(91%   0.008 75);
  --color-accent:    oklch(48%   0.18  28);  /* red — links/warnings */
  --color-accent-bg: oklch(94%   0.04  28);
  --color-pos:       oklch(45%   0.10  165); /* teal — positive deltas */
  --font-serif: "Charter","Iowan Old Style",Georgia,"Times New Roman",serif;
  --font-mono:  ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --font-sans:  system-ui,-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif;
}
```

Drop the Inter webfont from `root.tsx` (the mock uses system serif/mono stacks — no webfont request).
`<html lang="bg">` stays. Container max 1280px (narrow 880px), 8-pt spacing scale.

### Component inventory (`app/components/`)

**Shell:** `SiteHeader` (brand "Сигма" + nav: Начало / Институции / Компании / Договори / Потоци /
Методология + search toggle), `SearchDrawer` (port `site.js` open/close/Esc/click-outside into a React
component), `SiteFooter` (source + дата), `Breadcrumbs`, `PageHeader` (kicker + serif h1 + lede).

**Primitives:** `TotalsStrip` (bordered metric cells), `DataTable` (mono header, tabular-nums money),
`ShareBar` (inline % bar, `.warn` variant), `Flag`/`Chip` (pills — sector, entity type, EU), `Callout`
(left-rule note), `FactsList` (`<dl>`), `ResultCard` (search hit), `FilterRail` (sticky `<details>`
groups), `Pagination`.

**Charts — server-rendered SVG/CSS, no library** (the mock itself ships zero chart JS):

- `StackedBar` — procedure mix ("Как купува/печели"), CSS flex segments + legend.
- `SankeyDiagram` (flows) — compute node order, y-offsets and ribbon widths **in the loader** from the
  flows query, emit `<svg>` with quadratic-bezier `<path>`s (exactly the mock's structure). Always
  paired with the top-N table fallback.

## Formatting (`@sigma/shared`)

All **hand-rolled — do not rely on `Intl`/`bg-BG`**, whose locale data workerd does not fully carry.

- `money(eur)` → EUR tiers: `< 1 000` → `"640 €"`; `< 1e6` → `"412 хил. €"`; `< 1e9` → `"187 млн. €"`;
  else `"1,3 млрд. €"`. One decimal, comma.
- `pct(x)` → `"45,3%"`. `date(iso)` → `"14.10.2024"`; `monthYear` → `"октомври 2024"` via a hard-coded
  Bulgarian month-name map (not `Intl.DateTimeFormat`).
- `eik`, `unp` → mono passthrough (УНП format `NNNNN-YYYY-NNNN`).
- `entityName(bidder)` → consortium rows hold a `;`-joined member string → first member + „и др." with an
  **Обединение** badge; companies pass through (source names keep their quoting — show source truth).
- `contractValue(row)` → picks the right `*_eur` (current when an annex legitimately raised it, else
  signing; `estimated_value_eur` for the forecast line); returns `null` for `value_suspect` / foreign-
  without-rate so the caller renders the „данните се преглеждат" note, not a number.
- **Count/sum consistency:** a totals figure and its count cover the **same row set** — `value_suspect`
  rows (NULL `amount_eur`) are excluded from both and surfaced as a small „N с непотвърдена стойност"
  note, never counted-but-unsummed.

## Config (`@sigma/config`)

`PROCEDURE_GROUPS` — deterministic map of the real `procedure_type` values (not a heuristic; sanctioned
for the non-critical ЗОП taxonomy). Drives the procedure filter, "Как купува" stacks, and the
**non-competitive %** KPI:

| group | competitive | procedure_type values (counts) |
| --- | --- | --- |
| Открита | ✓ | Открита процедура (37,942); Ограничена процедура (121); … по ДСП/КС |
| Състезание | ✓ | Публично състезание (35,423); Състезателна процедура с договаряне (20) |
| Събиране на оферти | ✓ | Събиране на оферти с обява (33,940) |
| Договаряне (с покана) | ~ | Договаряне с предварителна покана … (954/360/95); Покана до определени лица (2,200) |
| Пряко / без обявление | ✗ | Договаряне без предварително обявление (8,199); Пряко договаряне (6,925); Договаряне без … (946/89) |
| Друго | — | Динамична система (151); Квалификационна система (89); Конкурс за проект (44); Партньорство за иновации (1) |
| Неизвестна | — | неизвестна (18,954 — **13%**; shown as its own bucket, never silently dropped) |

`ENTITY_TYPES` = `{ company: "Дружество", consortium: "Обединение" }` only. **The mock's ЕТ and
„чуждестранно" facets are dropped** — no real source field (no-heuristics rule). `bidders.kind` is real
(company 13,712 / consortium 3,736).

## Query layer (`@sigma/db/queries`)

Read-only, parameterised. Leaderboards / facets / flows read the **rollup tables** (not per-request
`GROUP BY`); detail pages read the base tables for a single entity (cheap, scoped).

- **Home** — one row from `home_totals`; top-10 from `company_totals`; ministries/общини slices from
  `authority_totals`.
- **Company / authority leaderboards** — `SELECT … FROM company_totals|authority_totals WHERE <facet
  columns> ORDER BY <sort>` + keyset page.
- **Company / authority detail** — for one `:id`, the entity row + breakdowns, where `GROUP BY` is fine
  because it is scoped to that entity's contracts: "Откъде печели"/"Топ изпълнители", "Как купува"
  (procedure groups), "Какво купува" (CPV), bid-count distribution, recent contracts (LIMIT 10).
- **Contracts list** — base `contracts` filtered/sorted, keyset page of 15; **CSV** = same filter,
  **streamed** (below), never buffered.
- **Contract detail** — the row + `*_eur` timeline + authority/bidder panels + same-tender lots +
  cross-pair links. **JSON** export = the assembled record.
- **Flows** — `SELECT … FROM flow_pairs WHERE <sector/year/eu> ORDER BY won DESC LIMIT topN`.
- **Search** — ranked `search_index MATCH ?`, grouped by entity kind, with per-group counts.

**Pagination — keyset, not OFFSET.** `WHERE (sort_key, id) < (?, ?) ORDER BY … LIMIT n` is O(1) at any
depth; `OFFSET` is not (the contracts list is ~8,600 pages). UI keeps Prev/Next + a current-page marker
+ a total (from the rollup or a cached `COUNT`); deep random page-jumps are not offered (they would force
`OFFSET`). `@sigma/api-contract`'s `cursor` already models this.

**CSV streaming.** Export routes return a streamed `Response` (a `ReadableStream` emitting rows as they
are read from D1), so a 190k-row `contracts.csv` never materialises in Worker memory.

**Indexes.** Rollups are keyed on grain + sort columns; base-table filter/join indexes exist in
`0000_init.sql`; add covering indexes in Phase 1 where `EXPLAIN QUERY PLAN` shows a scan.

## Routes (`app/routes.ts`)

| Route | Page | Notes |
| --- | --- | --- |
| `/` | index.html | totals, ministries/общини, top-10 companies |
| `/search?q=` | search.html | grouped hits (FTS) |
| `/companies` | companies.html | filters/sort/page in URL |
| `/companies/:eik` | company.html | `:eik` = ЕИК (was `?id=` in mock) |
| `/companies.csv` | — | resource route, streamed, same filters |
| `/authorities`, `/authorities/:eik`, `/authorities.csv` | authorities/authority | mirror |
| `/contracts`, `/contracts/:id`, `/contracts.csv` | contracts/contract | `:id` opaque (`c:`-rowid) |
| `/contracts/:id.json` | — | resource route, the record |
| `/flows?sector&year&funding&top` | flows.html | Sankey + table |
| `/methodology` | methodology.html | exists; truthful rewrite (checklist below) |

**Identity in URLs.** Domain ids are `'auth:'||ЕИК`, `'eik:'||ЕИК` (valid) / `'name:'||name` (no valid
ЕИК), `'c:'||rowid`. Authority/company routes use the **ЕИК** (clean, shareable, stable). Bidders with no
valid ЕИК fall back to a short stable hash of their `name:`-id and are flagged „непотвърден ЕИК"; they may
fragment across name variants — a known limit until the Trade Register lands.

All filter/sort/page state lives in the query string (shareable URLs — a methodology principle).
`headers()` sets `Cache-Control: public` (reuse `app/lib/cache.ts`); hot aggregate reads also memoise in
the `CACHE` KV with a daily TTL keyed by the refresh stamp.

## Deltas from the mock (must apply consistently)

- **EUR only**, not BGN. Totals are the real corpus: ~50.8 bn €, **190,429 contracts**, **4,868**
  authorities, **17,448** companies, **all 45 CPV divisions**, **2020–2026** — not the mock's 2-sector /
  2020–2024 / 47.8 bn лв. slice. Rewrite every hard-coded figure and the methodology/footity copy.
- **Sector filter** lists the divisions actually present (top-N by value + the two curated), not just
  Строителство/Храни.
- **Consortia** appear as entities (badge **Обединение**), names via the display helper.
- **Partial-coverage fields render only when present** (per your rule): location/region (authorities
  46%, companies 23%), EU-programme name (14%), execution dates (87%), the per-lot table (71% of
  contracts have `lot_id`), bid-count metrics (90%). Absent → omit the line, never show "N/A noise".
- **Dropped:** ЕТ/foreign entity facets; any per-bidder bid amounts; secondary CPV (show per-lot CPVs
  instead). The "неизвестна" procedure is a visible bucket.
- **Consortium ranking is faithful but conspicuous.** Counting an обединение as one entity (the mock's
  rule) puts large framework consortia atop „печеливши компании" (e.g. a 16-member pharma JV at 1.3 bn €
  from a single contract). We keep the rule, **badge** them Обединение, and lean on the
  company/обединение **entity-type filter** to isolate operators — an editorial choice recorded here.

### methodology.html — rewrite to what we actually hold

Credibility-critical, so the copy must match reality, not the mock's narrower claims. Required edits:
currency is **EUR** (the peg note kept as history); scope is **all CPV divisions, 2020–2026, 190k
contracts** (not 2 sectors / 2020–2024); the "known gaps" table states the *real* coverage — **location
partial** (authorities 46%, companies 23%), **EU-programme 14%**, **execution dates 87%**, **per-lot
table 71%**; **owners/persons and risk/signals are "deliberately absent"**; **per-bidder bid amounts do
not exist in any source**; the `value_suspect` exclusion + count/sum rule are disclosed; "консорциум
counted as one entity" is stated.

## Sequencing (each phase = one branch/PR off `main`)

> Prereqs: (1) land `feat/ingest-all-sources` first, or branch off it — the v1 UI is a fresh effort with
> its own `feat/…` branches. (2) Provision the **remote D1** (wrangler login → `bootstrap:apply` → real
> `database_id`) before deploy — both web reads and the Workflow write to it.

- **Phase 0 — foundation.** D1 + KV bindings on web; `@sigma/db/queries` skeleton; `@sigma/api-contract`
  DTOs; `@sigma/shared` format lib; `@sigma/config` procedure/entity maps; design tokens; shared shell
  (header/nav/search-drawer/footer/breadcrumbs/page-header); `routes.ts`. **Normalize emits
  `home_totals` + the `*_eur` columns.** Gate: SSR renders + the home **totals** read from `home_totals`.
- **Phase 1 — list pages.** contracts, companies, authorities — `FilterRail` + `DataTable` + keyset
  `Pagination` + sort + streamed CSV. **Normalize emits `company_totals` / `authority_totals` /
  `sector_totals`.** (Highest reuse; do first.)
- **Phase 2 — detail pages.** contract (+ `*_eur` timeline, lots table, JSON export), company, authority
  — `FactsList`, `StackedBar`, top-N tables, recent lists, cross-links.
- **Phase 3 — home + search + flows + methodology.** **Normalize emits `flow_pairs` + the `search_index`
  FTS5 table.** Sankey layout in the loader; ranked search; methodology truthful rewrite (above).
- **Phase 4 — polish.** Empty/partial + suspect-value states, 404/ErrorBoundary, `meta`/SEO,
  **sitemaps** (authorities/companies/contracts), KV cache wiring, accessibility (preserve the mock's
  ARIA), `pnpm typecheck` + a few loader/format/rollup-reconciliation tests.

## Verification per phase

`pnpm typecheck`; `pnpm dev` smoke each route; **reconcile each rollup against a base-table `GROUP BY`
spot-check**; confirm FTS returns ranked Cyrillic+Latin hits, keyset Prev/Next holds at depth, and
`contracts.csv` streams (no buffering) honouring filters; check a partial-coverage entity (missing
location), a `value_suspect` contract (shows the преглеждат note), and a consortium render. Run only the
minimal tests needed (per AGENTS.md).

## Review resolutions

The plan-review findings and where each is now handled:

| # | Issue | Resolution |
| --- | --- | --- |
| 1 | Per-request aggregation cost | [Precompute layer](#precompute-layer-normalize--explorer) — rollup tables; loaders read those |
| 2 | EUR value timeline unavailable | normalize materialises `*_eur` for estimated/signing/current + `contractValue()` |
| 3 | No search index (naive LIKE) | `search_index` FTS5, Cyrillic+Latin folded; ranked `MATCH` |
| 4 | Unbounded CSV export | streamed resource route, filter-scoped |
| 5 | Count-vs-sum inconsistency | same row set; suspect rows excluded from both + disclosed |
| 6 | ЕИК-less entity URLs | ЕИК slugs; hashed fallback + „непотвърден ЕИК" caveat |
| 7 | "Incremental normalize" underestimated | scoped re-derive of touched slice + rollup/FTS refresh |
| 8 | bg locale in workerd | hand-rolled money/% + month-name map; no `Intl('bg-BG')` |
| 9 | Deep OFFSET pagination | keyset pagination; Prev/Next + count, no deep page-jumps |
| 10 | Consortium ranking distortion | keep single-entity rule, badge + entity-type filter (editorial) |
| 11 | methodology must be truthful | rewrite checklist |
| 12 | Prereqs unscheduled | remote D1 provisioning + sitemaps added to Sequencing |

## Cross-references

- Data support per page: [mock-coverage.md](mock-coverage.md).
- Schema: [0000_init.sql](../packages/db/migrations/0000_init.sql). Transform:
  [normalize-egov.sql](../scripts/normalize-egov.sql).
- Sector config: [`@sigma/config`](../packages/config/src/index.ts).
