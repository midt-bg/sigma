# Implementation Plan: #229 — Composite subject-level risk indicator (CRI-style)

- **Status:** Draft — awaiting approval
- **Created:** 2026-07-14
- **Branch:** `feat/subject-risk-composite` (off `origin/main`)
- **Delivery:** ONE PR, ~6 focused commits (see §7)

## 1. Executive summary

Aggregate the two elementary per-contract risk flags that exist today (single-offer, high-markup)
into a **composite risk indicator per subject** (company / authority), computed by contract **count**
and by **value** (separately), and surface it on the profile pages as a **neutral indicator** with a
band, a component breakdown, the underlying counts, and a drill-down to the exact contracts.

- **Complexity:** Medium-High (touches the ETL pipeline, the daily refresh, the contract-detail read
  path, and two profile pages).
- **Risk level:** Medium — defamation-sensitive (a risk label on a named subject on a minister-visible
  site). Mitigated by the framing controls in §5.

## 2. Decisions locked (with the human who owns each)

| # | Decision | Choice | Owner |
|---|---|---|---|
| A | The `methodology.tsx` promise „не маркира фирми като рискови" contradicts a risk band | **Keep the promise; reframe the feature as a neutral aggregate indicator** and reword the sentence | The reword is **maintainer-sign-off-gated** (isolated in commit 6) |
| B | Two single-offer definitions exist (`bids_received=1` vs `admitted===1`) | **`bids_received=1`, unified site-wide** — matches the 3 shipped sites; refactor `riskLogic` per-contract flag to match | Us (documented in ADR-0007) |
| C | Composite math for a subject with a missing/thin component | **Mean of *reportable* components** (each with ≥ min-N eligible); band derives from the **count-weighted** composite (robust to one dominant contract); value-weighted shown as context | Us (ADR-0007) |

Consequence of B to record explicitly: the per-contract `no_competition` flag stops subtracting
rejected bids, so a `3-bid / 2-rejected` contract no longer flags. The "many bids, most rejected"
pattern is **deliberately deferred as its own future flag**, not silently dropped (noted in ADR-0007).

## 3. Current state (verified against code)

- **Elementary flags** live only in `apps/web/app/lib/riskLogic.ts` (34 lines, render-time TS), per
  contract. Shown via `RiskIndicators.tsx` on `contract.tsx`. No subject-level aggregate exists.
- **Single-offer share is already shipped per authority** — `competition.ts` (`getAuthoritySingleOffer`,
  `competitionTotals`) using `bids_received = 1` over a `bids_received >= 1` denominator; also in the
  assistant SQL `describe-schema.ts:129,137`. Our composite must agree with these.
- **Rollups** `company_totals` / `authority_totals` are one-row-per-subject, built in
  `scripts/precompute.sql` (JOIN-GROUP over `contracts`) and refreshed daily by scoped INSERTs in
  `scripts/refresh-slice.sql`. The web reads them via `getCompany`/`getAuthority` (`SELECT *`).
- **D1 bills rows scanned** → aggregates MUST be precomputed, never computed per request.

## 4. Target architecture (Approach A — materialize once, read many)

**4.1 Canonical per-contract flags — new columns on `contracts` (nullable = "unknown", never 0):**

```sql
is_single_offer = CASE WHEN bids_received IS NOT NULL THEN (bids_received = 1) END
is_high_markup  = CASE WHEN signing_value_eur IS NOT NULL AND current_value_eur IS NOT NULL
                        AND signing_value_eur <> 0
                   THEN ((current_value_eur - signing_value_eur) / signing_value_eur > 0.2) END
```

Populated by ONE unconditional `UPDATE contracts SET …` in `precompute.sql`, inserted **between the
section-0 EUR-timeline UPDATE (line ~40) and the `company_totals` INSERT (line ~50)** — it reads
`signing_value_eur`/`current_value_eur` and must feed the rollups. Mirrored in `refresh-slice.sql`
for the daily path, **after** its recalc UPDATE.

**4.2 Per-subject aggregates — inline in the GROUP BY INSERT (not correlated subqueries):**
for each component store, per subject:
- `*_k` = flagged count, `*_n` = **eligible** count (own denominator: single-offer → `bids_received>=1`;
  high-markup → non-null signing/current). Storing `k`/`n` powers "K от N" (M4) and min-N (M3).
- count-share = `k / NULLIF(n,0)`; value-share = `SUM(flag·amount_eur) / NULLIF(SUM(eligible amount_eur),0)`.
- `composite_count` = mean of reportable components; `band` = CASE over `composite_count`.

**4.3 Read path:** `getCompany`/`getAuthority` already `SELECT *`, so columns arrive for free — but the
hand-written `*TotalsFull` interfaces and the `CompanyDetail`/`AuthorityDetail` object literals in
`details.ts` must name the new `risk` block. `listCompanies`/`listAuthorities` use explicit `COLS` and
are **not** touched (profile-only; YAGNI).

## 5. Anti-defamation & data-integrity controls (MANDATORY — from the security review)

| ID | Control | Implementation |
|---|---|---|
| M2 | No verdict words | Band labels describe the *indicators*: „Малко индикатори" / „Единични индикатори" / „Множество индикатори" / „Много индикатори — заслужава преглед". Never „критичен"/„корупция"/„нередност". |
| M3 | Min-N suppression | A component is reportable only when its **eligible** denominator `n ≥ 5`. If no component is reportable → no band, no score. |
| M4 | Counts beside shares | Always render „34 от 120 договора", never a bare %. |
| M5 | Exclude suspect rows | Reuse the existing `value_flag`/EUR-null rules; a `value_suspect` row can never be `is_high_markup=1` (its EUR figures are NULL). |
| M6 | Concentration guard | Band derives from **count-weighting**; value-weighting is context only, with a note when one contract dominates. |
| M7 | Drill-down | „виж договорите зад този индикатор" → the subject's contracts filtered by the flag. |
| M8 | Atomic block, no leak | Score + disclaimer + counts + link are one `Callout` unit; excluded from `<meta>`/OG so it can't become a search snippet. |
| M9 | Constants + persons | Thresholds are server-side constants (never query params); the whole block is **suppressed for natural-person profiles** (reuse `company.tsx:28,51-55`). |

Reused verbatim: the neutral-indicator disclaimer pattern at `methodology.tsx:359` and Principle #3
(„СИГМА не тълкува, а показва").

**Provisional band cutoffs** (count-weighted composite ∈ [0,1]) — documented as **tunable, pending
calibration against the real distribution**, not presented as science:
`<0.10` Малко · `0.10–0.30` Единични · `0.30–0.55` Множество · `≥0.55` Много — заслужава преглед.

## 6. Test strategy (TDD-first)

- **Golden fixture** (`refresh-slice.test.ts` pattern): seed contracts directly, run the SQL, assert
  exact shares/composite with `toBeCloseTo(_,6)`. Cover: single-offer true/false incl. NULL bids;
  high-markup boundary (`deltaPct = 0.20` → NOT flagged, `0.21` → flagged); suspect rows (NULL EUR →
  `is_high_markup` NULL, no error); a subject where **count-share 0.75 ≠ value-share 0.35** (proves the
  two weightings diverge); an **authority-side** row (the two rollup blocks are copy-paste twins);
  idempotency (re-run → identical); min-N boundary (n=4 suppressed, n=5 shown).
- **Parity guard (no-drift):** narrow `evaluateRiskIndicators`' param to
  `RiskFlagInput = Pick<ContractDetail, …>` so the test feeds flat SQL-row literals and asserts the
  materialized `is_*` column == the TS predicate per row.
- **Full-vs-daily parity:** extend the `refresh-slice.test.ts` projection that compares slice vs full
  rebuild to include the new columns (else drift ships green).
- **Non-vacuity:** assert an exact fixture row count, mirroring the `home_totals` guard.

## 7. Commit plan (ONE PR — dependency order; each commit compiles & its tests pass)

1. `docs(adr): ADR-0007 subject risk composite` — decisions (grain, 2 components, `bids_received=1`
   + the per-contract behavior change, equal weights, count+value, min-N, band cutoffs, neutral
   framing, deferred "disqualification-heavy" signal). Pure docs; the design gate.
2. `feat(db): materialize is_single_offer/is_high_markup on contracts` — columns in `0000_init.sql`
   **and** the `precompute.sql` mirror; the `UPDATE` in both `precompute.sql` and `refresh-slice.sql`;
   flag unit tests.
3. `feat(db): per-subject risk shares + composite on totals` — `k/n`/share/composite/band columns on
   both totals tables; inline aggregation in `precompute.sql` + both scoped INSERTs in
   `refresh-slice.sql`; golden tests + extended full-vs-slice parity.
4. `refactor(web): unify single-offer on bids_received=1, read materialized flags` —
   `ContractDetail` + `details.ts` (row/SELECT/object); `riskLogic` reads the columns; guard the
   `deltaPct` crash; rewrite `riskLogic.test.ts`.
5. `feat(web): subject risk indicator on company/authority profiles` — `SubjectRisk` types;
   `SubjectRiskIndicator` (own file, score inside a new `neutral` `Callout` variant, visible band
   label, ternary-not-`&&`); wire into `company.tsx`/`authority.tsx` via `Section`; M3/M4/M6/M7/M9 guards.
6. `docs(web): methodology section for composite + reword neutrality promise` — new explainer **and**
   the `methodology.tsx:146` reword. **Isolated so the maintainer can see exactly what public wording
   changes** — merge-gated on their sign-off.

## 8. Risks

- **Framing / defamation** (highest) → §5 controls + ADR + maintainer sign-off on the reword.
- **Daily-path drift** (the silent one) → explicit `refresh-slice.sql` steps + extended parity test.
- **Cross-page inconsistency** → resolved by Decision B (`bids_received=1`).
- **`riskLogic` behavior change** → documented; tests updated.
- **Band cutoffs arbitrary** → shipped as provisional/tunable, calibration is a follow-up.

## 9. Success criteria

- [ ] Golden + parity + full-vs-slice tests green; `tsc` 0; prettier clean.
- [ ] Composite single-offer share == `getAuthoritySingleOffer` on a shared fixture.
- [ ] No score renders without its disclaimer + counts; suppressed for natural persons and `n<5`.
- [ ] No band label is a verdict word; risk block excluded from `<meta>`/OG.
- [ ] Daily refresh keeps the new columns in sync with a full rebuild (parity test proves it).

## 10. Out of scope (v2 / follow-up)

Non-procedural/#153 and CPV-cohort/#41+#210 as new elementary flags; decision-window & new-supplier
flags (no data collected); the "disqualification-heavy" signal; band-cutoff calibration against the
real distribution; extracting shared string-scan helpers into `@sigma/shared`.
