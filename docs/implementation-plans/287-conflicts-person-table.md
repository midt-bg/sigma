# Implementation Plan: #287 — Свързаните лица: таблица по лице, детайлите на страницата на лицето

## Executive Summary

| Field | Value |
|---|---|
| Ticket | [midt-bg/sigma#287](https://github.com/midt-bg/sigma/issues/287) — labels `enhancement`, `web` |
| Problem | `/conflicts` renders one card per **relationship** (връзка). A person with stakes in three winners = three fat cards. The 431-line `ConflictCards` component is the only view, and the detail page `/conflicts/official/:id` calls the **same** component with `omit="official"` — so list and detail are identical and the detail page is pointless. With #279 the published set grows from ~100 links to ~330 across 300+ people; the list stops being browsable. |
| Ask | (1) `/conflicts` becomes a `DataTable` with **one row per person**; (2) the rich detail moves to the person page (`/conflicts/official/:id`) and mirror company page (`/conflicts/company/:eik`); (3) sort stays by `NEXUS_ORDER` with a person's rank driven by their **strongest** link. |
| Separate bug | `/conflicts/official/:id` claims in four places it shows only the person's **own** declared share. The query already includes a relative's declared share (per ADR-0032, deliberately). Text-only fix, shipped first and independently. |
| Approach | Group in **TypeScript** after fetch (no SQL `GROUP BY`); the leaderboard query already returns everything pre-sorted, capped at 1000, loaded whole. Lift the card's detail sub-blocks into an exported detail component the person/company pages compose. |
| Complexity | Medium — no ETL, no schema change. Correctness traps: per-ЕИК money dedup, rank-from-strongest-link, coverage ratchet. |
| Risk | Low-medium — presentation + shaping only. Main data-layer touch is eager-loading contracts into the two detail loaders (tiny volume). |
| Status | **Draft** |

> **The query layer is NOT in `lib/conflicts.ts`.** The issue text names `LINK_SELECT`/`OFFICIAL_SQL`/`NEXUS_ORDER` loosely; they actually live in `packages/db/src/queries/related-persons.ts`. `apps/web/app/lib/conflicts.ts` is pure presentation-shaping (`conflictHeadline`, `authorityShares`, hrefs). The grouping helper belongs in `lib/conflicts.ts`; no rewrite of the SQL projection is needed for grouping.

---

## 1. Ground truth (verified against the codebase)

### Query layer — `packages/db/src/queries/related-persons.ts`
- `LINK_SELECT` (~:135-171) — shared projection. **One row = one published `(official, ЕИК)` ownership link.** Gated by `SURFACED_OWNERSHIP` (~:119-120) = `status='published' AND interest_class IN ('private_ownership','family_ownership')`, a live zero-contract `EXISTS` gate, and `NOT_REDUNDANT_FAMILY` (drops a family row when the same person has a self stake in the same ЕИК).
- `NEXUS_ORDER` (~:113-114) — 4-key lexicographic: `own_institution='exact' DESC, contemporaneous_contract_count>0 DESC, contemporaneous_value_eur DESC, link_key`. Appended by `LEADERBOARD_SQL`, `OFFICIAL_SQL`, `COMPANY_SQL`.
- `OFFICIAL_SQL` (~:214) = `LINK_SELECT AND person_id = ? ORDER BY NEXUS_ORDER`; `COMPANY_SQL` mirror on `eik`.
- Row type `LinkRow` → `toLink` → `ConflictLink` DTO (`packages/api-contract/src/index.ts`). `OfficialConflicts`/`CompanyConflicts` DTOs carry only `links: ConflictLink[]` — **no `ConflictContract[]`** (contracts are lazy-fetched per link via the `conflict.contracts.tsx` resource route).

### Presentation — `apps/web/app/`
- `routes/conflicts.tsx` (156) — loads up to 1000 links, paginates client-side, renders `<ConflictCards>`. Explanatory/callout block at ~:82-101 must stay.
- `components/ConflictCards.tsx` (431) — the card. Module-private sub-blocks to lift: `CaseDetail` (~:229-250), `Timeline` (~:309-361), `AuthorityShares` (~:256-305), `ContractList`/`ContractItem` (~:371-431). Card carries `aria-posinset/aria-setsize` (~:111) — to be **dropped** in favour of native table semantics.
- `components/DataTable.tsx` (77) — target. Renders `<table><caption class="sr-only"><thead th scope="col"><tbody>`; supports `isRank` (corner badge on phone), `isTitle` (card heading on phone), secondary columns (drop on tablet), right-align, server-side phone card reorder via `data-label`. Template usage: `routes/companies.tsx:~209` (`caption="Компании по спечелено"`).
- `lib/conflicts.ts` (354) — shaping helpers + the per-ЕИК money-dedup already solved in `conflictHeadline` (~:325-347). New `groupByPerson` goes here.

### noindex — intact, must stay
- Route `meta()`: `conflict.official.tsx:~23`, `conflict.company.tsx:~24` push `{name:'robots', content:'noindex'}`.
- Worker header (authoritative): `apps/web/workers/app.ts:~74` `isNoindexNamesPath` matches `/conflicts` + `/conflicts/*` (except methodology), sets `X-Robots-Tag: noindex` at ~:182.

---

## 2. PR 1 — text-truth fix (ship first, standalone)

The issue splits this out deliberately (*"струва си да се оправи веднага и отделно"*). `OFFICIAL_SQL` filters `interest_class IN ('private_ownership','family_ownership')` and narrows no further, so the page **already** shows a relative's declared share — which is correct per **ADR-0032** (family ownership published identically to self ownership; only the relation label differs; the relative is never named, the relationship never asserted). The text simply lagged the ADR. **Text/comment only — zero logic, zero query change.**

| # | file:line | current | fix toward |
|---|---|---|---|
| a | `conflict.official.tsx:12` (comment) | "Reads private-ownership interest_links only" | note it reads published links incl. a relative's declared stake (ADR-0032); relative never named |
| b | `conflict.official.tsx:55` (lede) | „…декларирало **собствен дял** пред КПКОНПИ" | „…декларирало дял — **свой или на свързано лице** — пред КПКОНПИ" |
| c | `conflict.official.tsx:61-62` (callout) | „…само **собствен** деклариран дял" | „…деклариран дял — **собствен или на свързано лице**" |
| d | `conflict.official.tsx:70` (hint) | „…декларирало **собствен дял**" | same reframe |

**Also (found in analysis, not in the issue's list):** `conflict.company.tsx:~62/67` carries the same "собствен дял" / "декларациите на самите длъжностни лица" implication. Fold into this PR for consistency.

Wording must match what `conflicts.tsx:~82` and the methodology page already say. Update the `conflict.pages.render.test.tsx` assertions that lock the old strings.

**Acceptance:** the three official strings + comment + company lede reframed; existing render tests updated; `noindex` assertions unchanged; typecheck + vitest green.

---

## 3. PR 2 — grouping refactor

### 3.1 Data shaping — `lib/conflicts.ts` (+ `api-contract`)
Add a pure `groupByPerson(links: ConflictLink[]): ConflictPersonRow[]`. Per person (grouped by `officialSlug`):

| field | derivation |
|---|---|
| `official`, `officialSlug`, `institution` | from the person's **strongest** link, computed explicitly via NEXUS_ORDER (**not** `links[0]` — the helper must be correct for any input order, so it never assumes the caller sorted) |
| `companyCount` + `soleCompany` | distinct `eik`; carry the single company's name+eik when count === 1 (issue: „брой, или името, ако е едно") |
| `contractCount` | per-ЕИК-deduped (company-level winner total, like the money), null-guarded |
| `contemporaneousValueEur` (lead) + `contractValueEur` (total, „от") | per-ЕИК-deduped via the shared `dedupeMoneyPerEik`, **null-preserving** (a row with no summable € stays `null` → „—", never a fabricated 0). A duplicate ЕИК must still not double-count, so the dedup is unconditional — not a straight sum |
| `stakeKind` | `'self'`/`'family'`/`'mixed'` (identity-free) — drives the „свързано лице" qualifier so a family-only row is not read as an own stake |
| `ownInstitution` flag | OR across links |
| `hasContemporaneous` flag | any link with `contemporaneousContractCount > 0` |
| rank | driven by the strongest **single** link, **not** the OR-ed flags |

**Rank invariant:** compute each person's strongest link explicitly under NEXUS_ORDER and sort person rows by that link's key (`ownInstitution DESC, hasContemporaneous DESC, contemporaneousValueEur DESC, link_key ASC`, stable tiebreak on `officialSlug`) — **not** by the OR-ed row flags (two weak links must never out-rank one strong link), and **not** by assuming `links[0]` is strongest. A person with a strong link must not sink because of a weak second link — locked with a discriminating fixture (see `conflicts.test.ts`).

Add a `ConflictPersonRow` type. Simplest: local to `lib/conflicts.ts` (grouping stays in the component like the existing `conflictHeadline` call, loader still returns raw `links`). Promote to `api-contract` only if the loader is changed to return grouped data.

### 3.2 List presentation — `conflicts.tsx`
Swap `<ConflictCards>` → `<DataTable>`. Keep the explanatory/callout block above the table and the empty state („Все още няма публикувани връзки"). Columns:

| col | content | DataTable config |
|---|---|---|
| № | rank | `isRank` |
| Длъжностно лице | name + institution beneath | `isTitle` |
| Дружества | count, or name if 1 | plain (person link already in title col) |
| Договори | count | numeric |
| Публични средства | contemporaneous sum, „от" total beneath | right-aligned, two-line |
| Признаци | „от собствената институция", „към момента на договор" | secondary (drops on tablet), restrained Chips — no new colour |

Drop `aria-posinset/setsize`; pass a real `caption`. Pagination now counts **persons** (rows), not links.

### 3.3 Detail pages carry the detail — `conflict.official.tsx`, `conflict.company.tsx`
- Lift `CaseDetail`/`Timeline`/`AuthorityShares`/`ContractList`/`ContractItem` out of `ConflictCards.tsx` into an exported `components/ConflictDetail.tsx` (clean lift — they already take `(link, contracts)` props).
- The two pages compose one detail block **per link, eagerly expanded** (no lazy fetcher — these pages exist to show detail). Official page heads each block by company (ЕИК + profile link); company page heads by official.
- **One data-layer change:** `getOfficialConflicts`/`getCompanyConflicts` must load `ConflictContract[]` server-side (today lazy per link). Volume is tiny (~98 links corpus-wide; per-person/per-company N is small). Add contracts to `OfficialConflicts`/`CompanyConflicts` DTOs.
- `ConflictCards` retires from the list; its detail sub-blocks live on in `ConflictDetail`. Keep `conflict-cards.css` for whatever the detail blocks still use.

---

## 4. Tests (`review-testing.md` — lock exact invariants, adversarial)

**Break & rewrite:** anything on `.conflict-card`/`.conflict-cards`/`aria-posinset` in `conflicts.render.test.tsx` → `tbody tr`. In-list CaseDetail/expand tests move to `conflict.pages.render.test.tsx`.

**New grouping cases (`lib/conflicts.test.ts` unit + render):**
- N links same `officialSlug` → **1 row**; person named once.
- Strong-second-link person does **not** sink below a weak person (rank = strongest link). Must go red if sort becomes per-link.
- Public funds deduped per ЕИК across a person's links; contemporaneous shown with „от" total; duplicate ЕИК doesn't double.
- `companyCount`: 3 → count, 1 → company name.
- Признаци flag sourced from a second link still renders; in a **secondary** column.
- `contractCount` null/0-contract link doesn't NaN.
- Empty state preserved (no `<table>`); family anonymity preserved on a grouped row (relative never named).

**Accessibility (`docs/accessibility.md`, `docs/review-accessibility.md`):** caption non-empty; every `thead th` `scope="col"`; title col `cell-title` + `data-label`; rank col `cell-rank`; no synthetic ARIA; признаци as restrained Chips, no new inline `style`/colour; `noindex` assertions unchanged.

**Ratchet:** `coverage-baseline.json`, ≤0.5pp drop per workspace. CaseDetail coverage leaving the list test must be recovered on the person-page tests + the grouping helper. Run `pnpm typecheck`, `pnpm test -- --coverage`, `pnpm check:coverage`.

---

## 5. Files touched

**PR 1:** `apps/web/app/routes/conflict.official.tsx`, `conflict.company.tsx` (strings/comment), `conflict.pages.render.test.tsx`.

**PR 2:** `apps/web/app/lib/conflicts.ts` (+ `.test.ts`; `ConflictPersonRow` lives HERE, not in api-contract — see §6.5), `routes/conflicts.tsx`, `components/ConflictCards.tsx` → new `components/ConflictDetail.tsx`, `routes/conflict.official.tsx`, `routes/conflict.company.tsx`, `packages/db/src/queries/related-persons.ts` (eager contracts in detail loaders), `packages/api-contract/src/index.ts` (**contracts on the detail DTOs only** — `ConflictPersonRow` is NOT promoted here), `routes/conflicts.render.test.tsx`, `routes/conflict.pages.render.test.tsx`.

---

## 6. Open decisions (defaults chosen)
1. **Pagination unit** → persons (rows). *Assumed.*
2. **Дружества >1** → plain count, no link (person link is in the title column). *Assumed.*
3. **Filterable list?** → **no** new filter control in this ticket; if added later, a `role="status"` aria-live announcement becomes a hard a11y requirement.
4. **Company-page text bug** → folded into PR 1. *Assumed.*
5. **`ConflictPersonRow` locus** → local to `lib/conflicts.ts` (loader keeps returning raw links; grouping in the component, mirroring `conflictHeadline`).

---

## 7. Done when
- `/conflicts` is a `DataTable`, one row per person, with the six columns.
- The person/company pages carry the moved detail and are worth opening.
- `NEXUS_ORDER` ordering preserved after grouping; rank = strongest link.
- Existing render tests pass, with added grouping cases.

---

## 8. Post-merge reconciliation (#312 review)
Where the shipped code intentionally differs from the plan above (corrected inline; summarised here so a reader trusts HEAD, not the first draft):

- **Strongest link is computed, not `links[0]`.** `groupByPerson` derives each person's strongest link explicitly under NEXUS_ORDER; it does not assume the DB pre-sorted. The rank fixture was made discriminating (an OR-ed-flag ranking now fails it).
- **Money & `contractCount` are unconditionally per-ЕИК-deduped and null-preserving**, via the shared `dedupeMoneyPerEik`. „No summable €" renders „—", never a fabricated 0 (`fundsCellLabel`'s `!= null` guard reproduced by `personFundsCell`). The „straight sum is safe" note was wrong — the collapse only makes ЕИК distinct per person *today*, and the dedup defends the sum regardless.
- **`stakeKind` added** (`self`/`family`/`mixed`, identity-free) so a family-only row shows a neutral „свързано лице" qualifier and is never read as an own stake.
- **`ConflictPersonRow` stays in `lib/conflicts.ts`** (§6.5) — it is NOT promoted to `api-contract`; only the detail DTOs gained the eager `contracts` map.
- **Leaderboard ceiling guard.** The list is NEXUS-ordered, not person-ordered, so a cut at `LEADERBOARD_MAX` gives partial per-person aggregates. The loader fetches ceiling+1 to detect truncation and warns; the durable fix is grouping in SQL / server-side (tracked, not in #312).
- **Corpus size:** „~98 links" is the current corpus; „~330 across 300+ people" is the post-#279 projection. The eager detail-page load is bounded by per-page N (small either way); the leaderboard fetch is separately ceiling-guarded, so neither figure gates the eager decision.
- **Orphaned lazy route.** With eager detail loading, `conflict.contracts.tsx` (+ `linkContractsHref`) has no consumer. It is retained for now as the ready valve for a future large-page fallback (HIGH 2); if not adopted, retire it. ADR-0024's expanding-row detail is superseded by this eager-detail design.
- Text-truth fix shipped (PR 1) ahead of the refactor.
