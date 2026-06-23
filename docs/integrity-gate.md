# Pipeline reconciliation gate (#97)

`scripts/normalize-raw.sql` and `scripts/precompute.sql` **print** a consistency summary (rollup
counts, suspect/annex/review tallies, the clean total, freshness). Printing is not asserting —
nothing failed on drift. On a minister-visible site, silent numeric drift is unacceptable. This gate
promotes those printed numbers into **hard asserts that fail the import/CI with a non-zero exit
code**, generalising the single prior guard (the FX check, `assertFxPopulated*` in `import.mjs`).

## Where it runs

`scripts/integrity-checks.mjs` exports pure check functions over an injected `runner(sql) => rows[]`,
so the same logic runs against D1 (wrangler) and local sqlite. `assertIntegrity(runner)` runs every
check, prints one line each, and ends the process non-zero on the first real violation. It is wired
in after the rollups are (re)built — mirroring how `assertFxPopulated()` is called per backend:

| Call site | Backend | Notes |
|---|---|---|
| `import.mjs` → `runFullDerive()` | D1 | after `precompute.sql` |
| `import.mjs` → `runSliceDerive()` | D1 | after the refresh-slice batches |
| `import.mjs` → `runWorkBackfill()` | sqlite work DB | after `assertFxPopulatedSqlite`; rollup checks self-skip (rollups are built later, on the served D1) |
| `ship-domain.mjs` | served D1 | after `precompute.sql` on the database users read |

Each check **self-skips** when it cannot apply, so the same `assertIntegrity` call is correct at every
site with no per-site branching:

- **Rollup checks** require precompute to have run — detected via the single `home_totals` row it
  always writes. On the pre-ship work DB (rollups cleared by normalize, rebuilt later on D1) they skip.
- **Staging→domain reconciliation** requires `pipeline_stats` (written only by `normalize-raw.sql`,
  and not shipped to the served D1) and that it is **fresh** (its recorded `contracts_inserted` still
  equals the live `COUNT(*)`), so it runs right after a full normalize and skips on the slice path and
  the served D1.

## Invariants

The hard-fail invariants (1–3, 5) all test **Sigma's own processing** — its rollups, its `amount_eur`
/ `value_flag` derivation, its EIK normalization, its insert/dedup — things Sigma controls and can fix.
Sigma is a **consumer** of the EOP feed, so the gate must not hard-fail on upstream record-level data
quality it cannot correct; that is invariant 4's job, and it only **warns** (see below).

1. **Rollup ↔ contracts reconciliation (headline).** With
   `clean_total = SUM(amount_eur) WHERE amount_eur IS NOT NULL`:
   - `SUM(authority_totals.spent_eur)` equals the clean sum over contracts inner-joined
     tenders→authorities (precompute's own join);
   - `SUM(company_totals.won_eur)` equals the clean sum over contracts joined bidders **and** tenders;
   - `SUM(flow_pairs.won_eur)` equals the clean sum over contracts joined tenders→authorities **and**
     bidders;
   - `home_totals.value_eur` equals `clean_total`;
   - the **unattributed remainder** (clean contracts that resolve to no authority, or no bidder/tender)
     is **exactly 0 rows**. Bound = 0: normalize gives every contract a parent tender (synthetic when
     the staging has none) with a non-null authority, and a bidder row.
2. **No negative clean values.** Zero rows with `value_flag='ok' AND amount_eur < 0`, and no negative
   `spent_eur` / `won_eur` in any rollup.
3. **EIK validity** (canonical home: `bidders`). `eik_valid = 1` ⇒ `eik_normalized` is a numeric
   9- or 13-digit ЕИК; `eik_valid <> 1` ⇒ `eik_normalized IS NULL`. (`normalize-raw.sql` sets
   `eik_normalized` only when `eik_valid = 1`; the gate proves the guarantee held.)
4. **Date sanity — reported (`WARN`), NOT gated.** Counts non-null `signed_at` outside
   `[2007-01-01, today UTC]`. Unlike 1–3 and 5, `signed_at` is a **pass-through of the upstream EOP
   value**, not something Sigma derives — an out-of-range date is an upstream record-level defect
   (#19–27) Sigma cannot fix. Hard-failing on it would break **every** daily refresh forever over a
   single source typo (the 2024 feed really does contain one: `signed_at = '2029-05-14'`). So the
   check surfaces the count as a `WARN` and never fails the import. The count is still useful: a
   sudden spike would signal a Sigma-side date-parsing regression for a human to investigate. NULL
   `signed_at` is allowed.
5. **Staging → domain reconciliation.** `normalize-raw.sql` records, in one `pipeline_stats` row, the
   eligible-candidate count (the **same expression** the printed summary now reads) and the resulting
   contracts count. The gate asserts no contract appeared without an eligible candidate
   (`inserted ≤ candidates`) and that a non-empty corpus actually landed.

   **Known blind spot — under-insertion.** `candidates` counts raw eligible rows *before* the
   cumulative-bucket dedup (the same logical EOP contract recurs across daily buckets), so the
   `candidates − inserted` gap is large and legitimate, and only `inserted > candidates` or an empty
   corpus fails. That means **silent under-insertion is not caught here**: if half the eligible
   contracts were dropped, `inserted ≤ candidates` still holds, and the missing rows are absent from
   the rollups too, so rollup reconciliation (invariant 1) stays consistent as well. Asserting it
   exactly needs the dedup drop tracked separately — record `candidates_deduped = COUNT(DISTINCT
   <domain contract id>)` over the eligible set in `pipeline_stats` and assert
   `inserted == candidates_deduped`, or rely on **#99 golden totals** (an independent recount of the
   expected corpus). Tracked as the follow-up; this gate covers over-insertion and empty-corpus.

## Tolerances (and what is *not* tolerated)

- **The only tolerance is `EPS_EUR = 5.0`** (five euros), for float reassociation when `SUM()`ing the
  REAL `amount_eur` column in different group orders (grouped by authority vs summed flat) across
  ~200k rows. Worst-case rounding error of a length-N sum is `~(N-1)·u·Σ|xᵢ|` with `u = 2⁻⁵³`; at
  `N≈2e5`, `Σ≈5e10 €` that is ~1 € per sum, ~2 € between the two — 5 € clears it with margin. It
  cannot mask a real drop: a missing / duplicated / sign-flipped contract moves a sum by its whole
  value (the lowest kept `amount_eur` is ≫ 5 €). The bound is **analytic**, and validated on real
  data: on the 2024 EOP feed the observed residual was **exactly 0.00** at both 554 contracts (€186 M)
  and 37,784 contracts (€12.5 bn), across all four rollups — far under 5 €.
- **Structural exclusions are never absorbed into the epsilon.** The unattributed remainder
  (invariant 1) is asserted by **exact row count = 0**, not by a value tolerance.
- **Out-of-range and NULL `signed_at` never fail the import** (invariant 4). `signed_at` is upstream
  pass-through; bad/missing dates are source-data quality (#19–27), out of scope. Out-of-range dates
  are surfaced as a `WARN` count; NULL is allowed silently.
- **The candidates − inserted gap** (invariant 5) is the legitimate cumulative-bucket dedup drop
  (`INSERT OR IGNORE` over the composite contract id); it is reported, and only `inserted > candidates`
  (a phantom/orphan contract) or an empty corpus fails.

## Scope

This gate **asserts** that everything already agrees on the canonical `amount_eur IS NOT NULL` value
basis. It does **not** change that basis, and it does not address record-level data-quality issues
(#19–27). Foundational for #98/#99.
