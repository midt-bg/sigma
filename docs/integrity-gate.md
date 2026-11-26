# Pipeline reconciliation gate (#97)

`scripts/normalize-raw.sql` and `scripts/precompute.sql` **print** a consistency summary (rollup
counts, suspect/annex/review tallies, the clean total, freshness). Printing is not asserting —
nothing failed on drift. On a minister-visible site, silent numeric drift is unacceptable. This gate
promotes those printed numbers into **hard asserts that fail the import/CI with a non-zero exit
code**, generalising the single prior guard (the full import check for available but unused FX rates, `assertFxValued` in `import.mjs`).

## Where it runs

`scripts/integrity-checks.mjs` exports pure check functions over an injected `runner(sql) => rows[]`,
so the same logic runs against D1 (wrangler) and local sqlite. `assertIntegrity(runner)` runs every
check, prints one line each, and ends the process non-zero on the first real violation. It is wired
in after the rollups are built when the backend publishes them:

| Call site | Backend | Notes |
|---|---|---|
| `import.mjs` → `runFullDerive()` | D1 | after `precompute.sql` |
| `import.mjs` → `runSliceDerive()` | D1 | after the refresh-slice batches |
| `import.mjs` → `runWorkBackfill()` | sqlite work DB | after `assertFxValued`; rollup checks self-skip (rollups are built later, on the served D1). The only site that also runs the build checks (`build: true`, invariant 8) |
| `ship-domain.mjs` | served D1 | after `precompute.sql` on the database users read |
| `apps/etl` Workflow → `integrity-gate` step | served D1 (async runner) | the 6-hourly cron refresh, after each slice derive; runs the shared roster and retains the window for replay on a violation. It stores the verdict in `refresh_verdict` ([below](#the-stored-verdict)). FX coverage is checked before derive. |

The runner the checks receive may be **synchronous** (the sqlite3/wrangler CLI orchestrators return rows
directly) or **asynchronous** (the Workflow runs `env.DB.prepare(sql).all()`, a Promise). The checks
`await runner(sql)` throughout, so both fit; the CLI call sites are unchanged apart from `await`ing the
now-async `assertIntegrity`.

Each check **self-skips** when it cannot apply, so the same `assertIntegrity` call is correct at every
site with no per-site branching:

- **Rollup checks** require precompute to have run — detected via the single `home_totals` row it
  always writes. On the pre-ship work DB (rollups cleared by normalize, rebuilt later on D1) they skip.
- **Staging→domain reconciliation** requires `pipeline_stats` (written only by `normalize-raw.sql`,
  and not shipped to the served D1) and that it is **fresh** (its recorded `contracts_inserted` still
  equals the live `COUNT(*)`), so it runs right after a full normalize and skips on the slice path and
  the served D1.

The **build checks** (`BUILD_CHECKS`) are not part of that roster. They need the work staging and
evaluate every contract at once, which no served gate can afford, so only `assertIntegrity(runner, {
build: true })` on the work database runs them. `runIntegrityChecks` (the cron gate, the stored verdict,
`CHECK_NAMES`) never includes them, and they never appear there as a skip or a warning.

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
   **#99 golden totals** (an independent recount — implemented as
   `packages/db/src/golden-dataset.test.ts`, see [`review-testing.md`](review-testing.md)); this gate
   covers over-insertion, and invariant 0 covers empty-corpus.

6. **An `annex_total_suspect` contract sums at its signing value** (`annex-total-suspect-basis`). Its annex
   announced a new total that doubled the contract (#305), so the derive falls back to the signing value
   and the contract page calls the current value „двойно отчетена". A row whose `amount_eur` is the doubled
   current value inflates every total while each rollup still reconciles with it, so invariant 1 cannot
   see it. The check recomputes the derive's own expression (signing value in the contract's currency, or
   with no signing value the current value in the amendment's currency; EUR as-is, BGN at the peg, other
   currencies at the row's `fx_rate`) and allows one cent. It self-skips on a schema before migration 0002.
   `scripts/repair-annex-total-suspect.sql` repairs such rows on staging, where the one-time 0002 backfill
   once wrote them.
7. **No annex is served twice** (`amendment-twin-dedup`). No `(unp, contract_number)` carries both an EOP
   and an OCDS amendment (the prefer-EOP dedup of #286), and no OCDS amendment stays served under its OCID
   beside the annex it duplicates. The OCID names the procedure (`ocds-` + six-character prefix + `-` +
   `tender.id`); the served tender with that `eop_tender_id` gives the УНП, only when exactly one does and
   never an OCDS-only procedure. Under that УНП the row is a twin when the contract has an EOP annex or the
   same OCDS publication is already served there; a row whose OCID carries contracts of its own is the
   key, not a twin. The definition is one query, `AMENDMENT_OCID_TWINS_SQL`: the gate counts it and
   `refresh-slice.sql` deletes it on every refresh, so the gate is the post-condition of that removal.
   Nor does an OCDS amendment stay served under the number its EOP twin was published under before the
   value resolver moved that annex onto its contract (`contract_number_raw`): same УНП, an EOP annex with
   that annex-side number, and no contract under the number itself. That is a second one-query definition,
   `AMENDMENT_RAW_NUMBER_TWINS_SQL`, counted by the gate and deleted by `refresh-slice.sql` on every
   refresh in the same way; the removed row is no contract's annex input, so no count or sum moves.
8. **Every contract carries the value rule** (`contract-value-rule`, build check only). Each `c:e:`/`c:o:`
   contract of the work database is staged through `raw_served_contract_value_base`, which reads a served
   row as the daily `amendments` batch does (a test holds the two equal), and evaluated by the rule itself
   (`raw_contract_annex_evidence` / `raw_contract_values`). Any row whose `value_flag`, `amount_eur`, other amounts (`amount`,
   `current_value`, `signing_value_eur`, `current_value_eur`; money to half a cent), current-value currency
   or conversion marker, signing rate (relative 1e-9) or annex count differs **fails the build**. An OCDS
   release that carries a value corrected at the source (docs/etl.md, „Стойност, поправена в източника само с
   OCDS изменение") is served as an annex with an after-value, so the check reads it like any other annex.
   The detail gives the count, the count per kind and the `amount_eur` that would move, never a row. It proves that the
   build and the daily path agree, so a contract that a later window re-values does not move for no reason.
   Two kinds of legacy row (`own_estimate_source` NULL) are **held as stored and counted** in the detail,
   because their stored inputs cannot settle them: a `value_suspect` verdict the rule no longer reaches
   (the branch that set it may have read the own estimate, which was never stored), and a `value_low`
   verdict whose own estimate was never stored (`keep_symbolic` keeps it). A fresh build stores
   `own_estimate_source` on every row, so both counts are 0 there and every row passes by construction.
   The check writes and empties transient staging; on 200k contracts it takes about 9 s on local SQLite.
   Stored rows come in line with a changed rule only through a rebuilt slot: the change raises the data
   version, and the deploy preflight runs production only on a slot built at that version
   ([deploy.md](deploy.md), „Версията на данните“).

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
  authorities passes). Per-grain checking is **#99 golden totals**, not this gate — covered by the
  golden dataset test (`packages/db/src/golden-dataset.test.ts`), which recounts every grain of a
  synthetic corpus against hand-verified absolute numbers.
- **On the in-place D1 paths the gate runs post-publish.** `runFullDerive` / `runSliceDerive` and
  `ship-domain.mjs` call `assertIntegrity` **after** `precompute.sql` has already written the served D1
  (D1 has no cheap blue-green swap), so on a violation `process.exit(1)` stops the run but the bad
  numbers are already being served until a human intervenes — a conscious **ship-and-alert** compromise.
  The **work-backfill path gates before shipping**: `runWorkBackfill` asserts the sqlite work DB, and
  `ship-domain.mjs` refuses to ship a 0-row source, so the bulk-rebuild path is guarded pre-publish.
  The **`apps/etl` cron refresh inherits the same ship-and-alert shape**: it gates the served D1 after
  the slice has already been written, so a violation cannot un-serve anything and does not fail the run.
  It logs `etl_integrity_violation` at error level and the result carries `integrity: 'violation'`. A D1
  error during the check is retried by the step; if the retries run out, the run logs
  `etl_integrity_unverified` and carries `integrity: 'unverified'`. In both cases the window stays
  recorded, so the next run replays it and checks again. Neither holds back the as-of date or the data
  generation: they describe the contracts that are served, and those are served already (see
  [`etl.md`](etl.md#датата-данни-към-и-поколението-на-данните)). Whether the numbers are verified is said
  by the stored verdict below, not by the date.

## The stored verdict

The cron refresh's verdict does not live only in the Workflow log. A run that ends `violation` or
`unverified` still shows up as a *completed* instance there, the same as a healthy one. So every run
that reaches the gate stores its verdict in the step `record-verdict`, one row per run, in the runtime
table `refresh_verdict` on the served D1. The refresh creates the table itself (`CREATE TABLE IF NOT
EXISTS` in the same batch), in the same way as `refresh_lease` and `refresh_pending_window`, so no
migration or ship touches it.

| column | meaning |
| --- | --- |
| `run_started_at` | when the Workflow instance was created (ISO); the key, so a retried write replaces its own row. It names the run without exposing the instance id. |
| `window_from`, `window_to` | the contract window the run refreshed |
| `verdict` | `ok`, `violation`, `unverified` or `skipped` |
| `checks` | JSON array of check **names** only (the `name` ids of `scripts/integrity-checks.mjs`): the checks that broke (`violation`), or the one whose query could not complete (`unverified`, empty if it failed outside a check) |
| `decided_at` | when the gate decided (ISO) |

- **Only `ok` is healthy.** `violation` and `unverified` both mean the numbers are not shown to
  reconcile. A reader must never present either one as healthy.
- **`skipped`** is a run that returned early: nothing staged, nothing pending, nothing inherited.
  It verified nothing, so it is stored only as evidence that the refresh ran. It is never read as the
  verdict, so it cannot replace the last real one with an `ok` it did not earn.
- **Some runs record nothing:** a run that fails before the gate, and a run that steps aside for a
  held lease. A run that errored keeps its window pending, and the older row stays the latest. A
  reader therefore compares `decided_at` and `last_run_at` with the clock.
- **The write is one small batch.** It retries through the step like every other write. If it still
  fails, it does not fail the run, which has already served and checked its numbers. The run logs
  `etl_refresh_verdict_unrecorded` at error level and carries `verdictRecorded: false`.
- **Retention:** rows older than 90 days are pruned by the write that adds a new one.
- **Not recorded:** the CLI paths (`import.mjs`, `ship-domain.mjs`) and a rebuilt slot until its
  first refresh. On such a slot the table does not exist yet, which a reader treats as "no verdict".

The site's `/health` report carries the verdict as `runs.refresh.verdict`, `verdictAt` and `verifiedAt`
(the last `ok`), read inside the report's own statement ([deploy.md](deploy.md), „Проверка след
внедряване“).

The one-row read is `getLatestRefreshVerdict` in `@sigma/db` (`packages/db/src/queries/refresh-verdict.ts`).
It returns `null` when the table is missing or holds no gate verdict yet, and every other error
propagates. The query walks `idx_refresh_verdict_decided` from the newest row:

```sql
SELECT v.verdict, v.decided_at, v.checks, v.window_from, v.window_to, v.run_started_at,
  (SELECT MAX(decided_at) FROM refresh_verdict) AS last_run_at
FROM refresh_verdict v
WHERE v.verdict <> 'skipped'
ORDER BY v.decided_at DESC
LIMIT 1
```

## Scope

This gate **asserts** that everything already agrees on the canonical `amount_eur IS NOT NULL` value
basis. It does **not** change that basis (so a negative upstream `value_low` value still feeds the
totals — surfaced as a `WARN`, invariant 2, basis fix tracked separately), and it does not address
record-level data-quality issues (#19–27). Foundational for #98/#99.
