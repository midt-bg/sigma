# Implementation Plan: #306 — annexes don't link to a contract (contract number in a different namespace)

## Executive Summary

| Field | Value |
|---|---|
| Ticket | [midt-bg/sigma#306](https://github.com/midt-bg/sigma/issues/306) — labels `data-quality`, `etl`, `priority: high` |
| Problem | 1,937 EOP annexes (7.2%) don't link to any contract. #286 fixed the OCDS half (procedure axis: OCID vs УНП). This is the other axis: the **contract number**. The annex carries an internal annex-side number (`148846`, `2886`); the contract carries the buyer's filing number (`Д-226`, `388-2020`). The exact `(unp, contract_number)` join fails, so the annex drops out of every annex→contract→company/authority rollup. |
| Root cause | Two genuinely unrelated identifiers in different namespaces — not dirty strings. Measured: `TRIM`+`UPPER` saves 0, digits-only 11, substring 19. String normalisation is a dead end. |
| Approach | Link by **value**: an annex's `value_before` is the contract's value at amendment time, so it equals the target contract's `signing_value`. Rewrite `raw_amendments.contract_number` to the resolved contract when `value_before` **exactly** (< 0.5 стотинка), currency-matched, uniquely matches one contract on the procedure; propagate across a chain sharing the annex-side number. |
| Complexity | Medium — the resolver is a self-contained CTE; the subtlety is full-vs-slice parity (the #305 bug class) and the slice's windowed staging. |
| Risk | Low on the full path (measured 99.99% precision), gated to leave ambiguous/no-match annexes unlinked. |
| Status | **Full-derive resolver implemented as a gated, standalone script (`scripts/resolve-amendment-contracts.sql`) that runs BEFORE `derive-amendments.sql`, full-derive path only. Slice/daily resolver deferred (documented below).** Validated against the live `sigma-dev` corpus; hardened per the PR #308 review (ordering blocker, group-contradiction rule, cumulative-candidate dedup, EIK guard, provenance columns). |

---

## 1. Problem, verified on real data (`sigma-dev`)

Reproduced the issue's breakdown exactly on the served corpus (an amendment `a` links iff `contracts c` exists with `c.tender_id = 't:'||a.unp AND c.contract_number = a.contract_number`):

| check | #306 | live `sigma-dev` |
|---|---|---|
| EOP annexes unlinked | 1930 | **1937** |
| empty contract_number | 0 | 0 |
| empty УНП | 0 | 0 |
| УНП not in `tenders` | 0 | 3 |
| procedure has no contract | 12 | 15 |
| procedure has contracts, none match | 1918 | **1919** |
| procedure has exactly 1 contract (safe) | 1012 | **1012** |
| price-changing | 554 | **555** |

## 2. The value anchor (the insight beyond the issue)

The issue proposed linking only the 1,012 single-contract procedures by УНП. Measuring `value_before` → `signing_value` unlocks the multi-contract cases too. On the **already-linked** annexes (ground truth), when `value_before` uniquely matches one contract's `signing_value`:

| gate | unique matches | correct | precision |
|---|---|---|---|
| within 1% | 9061 | 8975 | 99.08% |
| **exact (< 0.5 стотинка)** | **9349** | **9348** | **99.99%** |

Exact-cent match wins on **both** precision and recall — the 1% band manufactures ambiguity and admits the #305 "matched a smaller sibling's value" errors. Example `00011-2020-0002` (multi-lot): the unlinked `2886` annexes carry `value_before=56000`, which exactly matches contract `388-2020` (lot 2, signing 56000), **not** `387-2020` (64000) — a case УНП-only linking cannot resolve.

### Recovery under the shipped gate (exact + currency + unique + chain-propagation)

| tier | rule | links |
|---|---|---|
| single-contract, value-confirmed | procedure has 1 contract, `value_before` == its `signing_value` | 775 |
| multi-contract, value-unique | `value_before` exactly matches one of ≥2 contracts | 604 |
| **combined (before chain propagation)** | | **~1,379 (71%)** |

Left **unlinked by design**: value-ambiguous (matches 2+, ~115), no-match (~193, target not yet ingested — the #249 class), no-tender/no-contract (~18). An honest gap beats a wrong contract on a transparency site.

> **Re-measured on the live `sigma-dev` corpus (PR #308 review).** Read-only reproduction against the served corpus confirms the headline numbers hold under the revised rule: **1,937** unlinked, **1,563** recovered (1,377 direct + 186 propagated), precision **9,348/9,349 = 99.99%**. Two review inferences were corrected by the data: the `value_before IS NULL/≤0` class is **empty** (all 1,937 unlinked annexes carry a value; the `1,379+326≠1,937` gap is tier-estimate rounding, not a value-less class), and the only anchor-disagreement group in the whole corpus is the correct 00026 lot-base case (hence the §3.4 rule revision). **Still owed:** the served corpus is deduped one-row-per-contract, so it does not exercise the cumulative-staging path (§3.1) — that must be re-measured on raw cumulative staging via a local full backfill before the dedup fix is fully validated end-to-end.

## 3. Fix — full-derive path (`scripts/resolve-amendment-contracts.sql`, run before `derive-amendments.sql`)

The resolver is a **standalone script** that `import.mjs` runs from `runFullDerive` / `runWorkBackfill` **before** `derive-amendments.sql` — i.e. **before** the #286 prefer-EOP dedup DELETE and its diagnostics. Ordering is load-bearing (PR #308 review, todorkolev #1 blocker): rewriting an EOP annex onto a contract that already kept an OCDS twin, if done *after* the dedup, resurrects the twin (`annex_count = 2` on a one-annex contract) and trips the `amendment-twin-dedup` integrity gate (#303), failing the whole derive. Running first — and above the #286 diagnostics — keeps the dedup the sole twin guard and its dropped/excess counts honest bounds. The resolver reads only `source LIKE 'eop:%'` rows + `raw_contracts`, so it is independent of the OCDS bridge and safe to run first.

1. `contract_candidates` — `raw_contracts` **deduped to one row per `(unp, contract_number)`** (`ROW_NUMBER() … ORDER BY source DESC, id DESC = 1`), mirroring normalize-raw. `raw_contracts` is cumulative (the same contract recurs across daily buckets; the collapse happens later in normalize-raw), so without this `COUNT(*) OVER` would count staging **rows**, not contracts — mass fail-close on a real rebuild, or a match to a superseded value (PR #308 review, nikimilenkov HIGH 2).
2. `grp` — **all** EOP annexes with no `(unp, contract_number)` contract, grouped by the shared annex-side number `(unp, annex_cnum)` = one contract's chain. Value-less members (`value_before` NULL/≤0) are included so they can inherit the chain target (review MEDIUM 2).
3. `vmatch` — join to `contract_candidates` on `unp`, exact value (`ABS(signing_value − value_before) < 0.005`), **explicit** currency on both sides (blank ≠ blank; review LOW 1), null-tolerant contractor-EIK match (a value collision onto a different contractor is refused for free; review MEDIUM 5). `COUNT(*) OVER (PARTITION BY amendment_id)` flags uniqueness.
4. **Group rule** (reviews todorkolev #2, nikimilenkov MEDIUM 1 & 2, revised against the live corpus): a member's OWN unique (`n_match = 1`) exact match always applies — it is individually trustworthy (the 99.99% figure) and is **not** voided when annex-number siblings point elsewhere, because an annex number can be a **lot-base** shared across contracts (live corpus: `20РП-У50А015` → …-Л01 @ 22569.98 **and** …-Л03 @ 28557.50, each annex exactly-uniquely matching its own lot — the sole disagreement group in the whole corpus, and it is correct). Members with **no** own unique match (value-less admin steps, or later steps whose cumulative value matches no `signing_value`) inherit one agreed group target — but **only** when the direct members agree; disagreement withholds *propagation*, never the direct hits. A member that is itself value-ambiguous (`n_match ≥ 2`) carries its own contradicting evidence and never links, directly or by inheritance.

   > An earlier revision refused the whole group on disagreement (nikimilenkov MEDIUM 1 as first stated). Measured on the live corpus that dropped 2 confirmed-correct multi-lot links and prevented **zero** wrong links (the only disagreement group is the benign 00026 lot-base case), so the rule keeps direct hits and gates only propagation.
5. `UPDATE raw_amendments SET contract_number = resolved, contract_number_raw = <old>, link_method = 'value_anchor'` in place — like the #286 УНП bridge, but **preserving provenance** (review MEDIUM 4). The rollup, `promote-amendments.sql`, and the serving join then link with no further change; the original annex number stays in `contract_number_raw`, which also keeps it in the amendment `natural_key` so a resolved row never collides with a native annex sharing `document_number` on the target (review MEDIUM 3).

Diagnostic printed by wrangler: `annexes_value_linked`, `eop_annexes_still_unlinked` (complementary predicates over the same mismatch population).

Idempotent: after the rewrite the row links by number, so a re-run's `grp` no longer selects it and the provenance columns are never re-stamped.

## 4. Slice / daily path — **implemented** (corpus-safe resolver inside `refresh-slice.sql`)

Originally deferred: the standalone `resolve-amendment-contracts.sql` is **not** run on the slice path (`runSliceDerive`), because it would execute against `refresh-slice.sql`'s **windowed** `raw_contracts`, where "unique on the procedure" means "unique **in the window**" — a corpus-ambiguous annex looks unique in a narrow window and mislinks, and the measured 99.99% precision (a full-corpus number) would not carry (PR #308 review, nikimilenkov HIGH 1).

The daily/slice + Worker path now runs a corpus-safe equivalent **inside `refresh-slice.sql`** (search `#306: slice-safe value-anchor resolver`), addressing PR #308 review todorkolev "дневните обновявания": the cron runs only `refresh-slice.sql`, so the fix had to live there or stay inert in production. It applies the same value/currency/EIK anchor, chain rules, and provenance stamping as the full path, differing only in the candidate source:

- Candidate contracts are drawn from the **served `contracts` table** (the whole corpus; `unp` via the `tender_id` suffix, contractor ЕИК via the winning `bidders.eik_normalized`) **UNIONed** with this window's `raw_contracts`, so uniqueness is asked corpus-wide. It is intentionally **not** under a byte-identical lockstep marker — the candidate source differs by construction. Scans are bounded to procedures with an EOP annex in this window (`window_unps`), keeping the served read a keyed lookup (`idx_contracts_tender_id`).
- Resolved targets land in `refresh_touched_contracts` **for free**: the resolver rewrites the target `contract_number` onto `raw_amendments` in the setup batch, and the existing `@refresh-batch amendments` touch join (`raw_amendments` → `contracts` on `contract_number`) then scopes prior-window targets into it.
- It runs in the setup batch **before** the prefer-EOP dedup DELETE, the same ordering the full path uses before `derive-amendments.sql`'s dedup (review todorkolev #1 blocker — otherwise a rewrite resurrects an OCDS twin and trips `amendment-twin-dedup` #303).
- The "is this annex's number already a real contract?" question is asked over a **value-agnostic** `all_contract_numbers` CTE (every contract number on the procedure, from window `raw_contracts` **and** served `contracts`, regardless of `signing_value`) — **not** over `contract_candidates` (which requires `signing_value > 0` for value matching). This keeps the slice path identical to the full path's `NOT EXISTS … raw_contracts`: an annex that matches a **zero-value** contract by number links by number, and is never value-linked to a neighbour (review todorkolev discrepancy).

**Deployment (review todorkolev blocker).** `refresh-slice.sql` now writes `contract_number_raw` + `link_method` into served `amendments`, but the deployed DBs are populated out-of-band so `wrangler d1 migrations apply` can't run. `deploy.yml` gains an idempotent step (probe `pragma_table_info`, `ALTER` only the missing columns, malformed response fatal) **before** the Worker deploys — otherwise the first cron after release crashes on the missing columns. If #307 merges first, fold these two columns into its provenance step instead.

Provenance keeps slice and full keys aligned: the amendment `natural_key` (winners dedup + promotion) uses the raw annex number via `COALESCE(NULLIF(contract_number_raw,''), contract_number, '')`, and the served `amendments` promotion carries `contract_number_raw` + `link_method`. A resolved annex re-emitted in a later slice window re-resolves deterministically to the same key — an honest, never-double-counted link. Where a target contract and its namespace-mismatched annex arrive in the **same** window, the annex still links (window `raw_contracts` is in the candidate union); the residual best-effort gap is only a target never served or staged, which the next full rebuild closes (#286 precedent).

## 5. Blast radius (auto-corrects on a full rebuild)

Everything is rebuilt from scratch by `precompute.sql` (DELETE/INSERT), so it self-corrects: `company_totals`, `authority_totals`, `sector_totals`, `home_totals`, `facet_counts`, `flow_pairs`, `cpv_division_stats`, `search_index`, and each contract's `annex_count`/`current_value`/timeline. Overall annex counts and sums on the annexes themselves are unchanged. Two things to verify after the run: (1) `cpv_division_stats` p95/p99 bands shift for affected divisions; (2) **merge-order dependency** — ~23 newly-linked annexes have `value_after ≥ 2× value_before` and should trip the #307 double-count flags (`annex_total_suspect`/`value_suspect`). Those flags do **not** exist on this branch (they are #307, in review); if this merges before #307, the newly-linked ≥2× annexes enter the aggregates **unflagged** until #307 lands. Track the merge order explicitly.

**Migration numbering (PR #308 review todorkolev "сблъсък на номера").** #307 adds `0006_amendment_restated.sql` + `0007_amendment_value_suspect.sql`; this branch's provenance migration is therefore numbered **`0008_amendment_provenance.sql`** to sit after both. This assumes #307 merges first (it should — the ≥2× flags above depend on it). If #308 lands first instead, renumber to `0006` and have #307 shift to `0007`/`0008`.

## 6. Tests

`packages/db/src/amendments-contract-resolve.test.ts` runs the real `resolve-amendment-contracts.sql` + `derive-amendments.sql` (the full-derive composition) against SQLite and pins: single-contract link (00017 shape), multi-lot value disambiguation (00011 shape), chain propagation + `current_value` = last step, value-less chain member inherits (MEDIUM 2), ambiguous-in-chain member stays unlinked (todorkolev #2), whole-group refusal on disagreeing anchors (MEDIUM 1), cumulative-staging duplicate counted once (HIGH 2), EIK guard (MEDIUM 5), value-ambiguous / no-match / currency-guard / blank-vs-blank-currency (LOW 1) → unlinked, twin-ordering (the resolver runs before the prefer-EOP dedup, no `annex_count = 2` — todorkolev #1 blocker), gate (derive-alone does not resolve — HIGH 1), idempotency, natural-key collision avoidance (MEDIUM 3), provenance through promote into served `amendments` (MEDIUM 4), already-linked untouched, and the diagnostic counts.
