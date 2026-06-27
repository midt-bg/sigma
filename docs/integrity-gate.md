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

The hard-fail invariants (0–3, 5) all test **Sigma's own processing** — that a corpus landed at all, its
rollups, its `amount_eur` / `value_flag` derivation, its EIK normalization, its insert/dedup — things
Sigma controls and can fix. Sigma is a **consumer** of the EOP feed, so the gate must not hard-fail on
upstream record-level data quality it cannot correct: that is invariant 4's job (out-of-range dates) and
the non-`ok` arm of invariant 2 (negative source values), both of which only **warn** (see below).

0. **Non-empty corpus (unconditional).** `COUNT(contracts) > 0`, asserted on every backend with no
   self-skip. A catastrophic upstream failure (0 candidates) or a botched derive can leave 0 contracts;
   on the served D1 the staging check self-skips (no `pipeline_stats`) and every rollup sum is `0 == 0`,
   so without this guard a silently-emptied database would pass the whole gate green.

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
2. **No negative values feeding the totals**, split by who controls the defect:
   - `value_flag='ok' AND amount_eur < 0` → **hard fail.** A clean row cannot be negative except via a
     Sigma derivation bug (e.g. a sign flip); Sigma owns and can fix it.
   - a negative `spent_eur` / `won_eur` in any rollup → **hard fail** (whole-group structural corruption).
   - `amount_eur < 0` on **any other flag** → **`WARN`, not gated.** `normalize-raw.sql` keeps `value_low`
     rows (set when `COALESCE(current,signing) <= 0`) with a populated, possibly negative `amount_eur`,
     and `precompute.sql` sums every `amount_eur IS NOT NULL` row regardless of flag — so a negative
     **source** value silently understates a minister-visible total. The negative value is upstream
     (#19–27); Sigma cannot correct the source, so this must not break the daily import. But it does
     corrupt the published number, so it is surfaced loudly rather than hidden. **The accuracy-correct
     end state is to stop summing negatives in the value basis** (null `amount_eur` for a negative
     derived value in normalize) — a follow-up, out of this gate's #97 scope (which does not change the
     basis). Until then the `WARN` count makes any such row visible.
3. **EIK validity** (canonical home: `bidders`). `eik_valid = 1` ⇒ `eik_normalized` is a numeric
   9- or 13-digit ЕИК; `eik_valid <> 1` ⇒ `eik_normalized IS NULL`. (`normalize-raw.sql` sets
   `eik_normalized` only when `eik_valid = 1`; the gate proves the guarantee held.)
4. **Date sanity — reported (`WARN`), NOT gated.** Counts non-null `signed_at` outside
   `[2007-01-01, today UTC]`. Unlike 0–3 and 5, `signed_at` is a **pass-through of the upstream EOP
   value**, not something Sigma derives — an out-of-range date is an upstream record-level defect
   (#19–27) Sigma cannot fix. Hard-failing on it would break **every** daily refresh forever over a
   single source typo (the 2024 feed really does contain one: `signed_at = '2029-05-14'`). So the
   check surfaces the count as a `WARN` and never fails the import. The count is still useful: a
   sudden spike would signal a Sigma-side date-parsing regression for a human to investigate. NULL
   `signed_at` is allowed.
5. **Staging → domain reconciliation.** `normalize-raw.sql` records, in one `pipeline_stats` row, the
   eligible-candidate count (the **same expression** the printed summary reads) and the resulting
   contracts count. The gate asserts no contract appeared without an eligible candidate
   (`inserted ≤ candidates`).

   **Soundness — the candidate expression mirrors the INSERT.** For `inserted ≤ candidates` to be a
   real invariant (not a false alarm), every row the `INSERT INTO contracts` keeps must be counted as a
   candidate. The candidate `WHERE` is therefore kept a true superset of the INSERT's: in particular its
   OCDS branch carries **no** `contract_number IS NOT NULL` guard — the INSERT keeps an OCDS row whose
   `contract_number` is NULL (its dedup `NOT EXISTS` over a NULL join is TRUE), so requiring it in the
   candidate count would undercount and make a legitimate insert look like `inserted > candidates` on an
   OCDS-heavy corpus. (`value_suspect` is already safe: it is only set when `eff_eur` — hence
   `COALESCE(current,signing)` — is non-null, so such a row always satisfies the candidate value filter.)

   **Known blind spot — under-insertion.** `candidates` counts raw eligible rows *before* the
   cumulative-bucket dedup (the same logical EOP contract recurs across daily buckets), so the
   `candidates − inserted` gap is the legitimate dedup drop, and only `inserted > candidates` fails.
   That means **silent under-insertion is not caught here**: if half the eligible contracts were
   dropped, `inserted ≤ candidates` still holds, and the missing rows are absent from the rollups too,
   so rollup reconciliation (invariant 1) stays consistent as well. Asserting it exactly needs the
   dedup drop tracked separately — record `candidates_deduped = COUNT(DISTINCT <domain contract id>)`
   over the eligible set in `pipeline_stats` and assert `inserted == candidates_deduped`, or rely on
   **#99 golden totals** (an independent recount). Tracked as the follow-up; this gate covers
   over-insertion, and invariant 0 covers empty-corpus.

## Tolerances (and what is *not* tolerated)

- **The only tolerance is `EPS_EUR = 5.0`** (five euros), for float reassociation when `SUM()`ing the
  REAL `amount_eur` column in different group orders (grouped by authority vs summed flat) across
  ~200k rows. Worst-case rounding error of a length-N sum is `~(N-1)·u·Σ|xᵢ|` with `u = 2⁻⁵³`; at
  `N≈2e5`, `Σ≈5e10 €` that is ~1 € per sum, ~2 € between the two — 5 € clears it with margin. It
  cannot mask a real drop: a missing / duplicated / sign-flipped contract moves a sum by its whole
  value (the lowest kept `amount_eur` is ≫ 5 €). The bound is **analytic**, and validated on real
  data: the observed residual was **exactly 0.00** across all four rollups at 554 contracts (€186 M),
  37,784 (€12.5 bn), and the **full 2020-01-01→2026-06-23 corpus — 193,902 contracts / €51.7 bn**,
  including FX-converted foreign-currency rows. The 5 € bound has never been approached.
- **Structural exclusions are never absorbed into the epsilon.** The unattributed remainder
  (invariant 1) is asserted by **exact row count = 0**, not by a value tolerance.
- **Out-of-range and NULL `signed_at` never fail the import** (invariant 4). `signed_at` is upstream
  pass-through; bad/missing dates are source-data quality (#19–27), out of scope. Out-of-range dates
  are surfaced as a `WARN` count; NULL is allowed silently.
- **The candidates − inserted gap** (invariant 5) is the legitimate cumulative-bucket dedup drop
  (`INSERT OR IGNORE` over the composite contract id); it is reported, and only `inserted > candidates`
  (a phantom/orphan contract) or an empty corpus fails.

## Limits of the guarantee

Two boundaries are deliberate, documented so the gate is not mistaken for more than it is:

- **Totals, not per-row attribution.** Invariant 1 compares `SUM(rollup)` to the whole attributed sum —
  it proves the *totals* reconcile, not that each contract is attributed to the *right* authority/bidder.
  Because the gate's joins replicate `precompute.sql`'s own joins, a drift that **preserves the grand
  total** passes: e.g. a contract attached to the wrong authority (or a `flow_pairs` `GROUP BY` key drift)
  moves value between two authorities while `SUM` stays put, so the gate is green even though that
  authority's page and the Sankey show wrong numbers. Empirically confirmed (moving €500 k between two
  authorities passes). Per-grain checking is **#99 golden totals**, not this gate.
- **On the in-place D1 paths the gate runs post-publish.** `runFullDerive` / `runSliceDerive` and
  `ship-domain.mjs` call `assertIntegrity` **after** `precompute.sql` has already written the served D1
  (D1 has no cheap blue-green swap), so on a violation `process.exit(1)` stops the run but the bad
  numbers are already being served until a human intervenes — a conscious **ship-and-alert** compromise.
  The **work-backfill path gates before shipping**: `runWorkBackfill` asserts the sqlite work DB, and
  `ship-domain.mjs` refuses to ship a 0-row source, so the bulk-rebuild path is guarded pre-publish.

## Scope

This gate **asserts** that everything already agrees on the canonical `amount_eur IS NOT NULL` value
basis. It does **not** change that basis (so a negative upstream `value_low` value still feeds the
totals — surfaced as a `WARN`, invariant 2, basis fix tracked separately), and it does not address
record-level data-quality issues (#19–27). Foundational for #98/#99.
