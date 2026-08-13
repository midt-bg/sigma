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
| Status | **Full-path resolver implemented + tested. Slice-path resolver deferred (documented below).** Validated against the live `sigma-dev` corpus. |

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

## 3. Fix — full path (`scripts/derive-amendments.sql`)

A resolver block runs after the prefer-EOP dedup and before the annex→contract rollup:

1. `unlinked` — EOP annexes with `value_before > 0` and no `(unp, contract_number)` contract.
2. `vmatch` — join to `raw_contracts` on `unp`, exact value (`ABS(signing_value − value_before) < 0.005`), currency-guarded (`COALESCE(NULLIF(currency,''),'BGN')` equal). `COUNT(*) OVER (PARTITION BY amendment_id)` flags uniqueness.
3. `direct` — keep unique matches only (`n_match = 1`).
4. `group_target` — propagate one agreed target across a `(unp, annex-number)` chain (refuse if members disagree), so later chain steps (whose `value_before` is the prior cumulative, not `signing_value`) link too and `current_value` reflects the **last** step.
5. `UPDATE raw_amendments SET contract_number = resolved` in place — like the #286 УНП bridge; the rollup, `promote-amendments.sql`, and the serving join then link with no further change.

Diagnostic printed by wrangler: `annexes_value_linked`, `eop_annexes_still_unlinked`.

Idempotent: after the rewrite the row links by number, so a re-run's `unlinked` CTE no longer selects it.

## 4. Slice path — deferred (documented)

`scripts/refresh-slice.sql` (the daily go-forward) needs the same resolver, but two divergences make it a separate, carefully-tested change:

- Its `raw_contracts` holds only the current window, so candidate contracts must also be drawn from the served `contracts` table (like the prefer-EOP dedup already consults served `amendments`) — this block would **not** be under a byte-identical lockstep marker.
- `refresh_touched_contracts` is populated from the window's `raw_contracts` only, so an annex resolved to a **prior-window** contract would be promoted without that contract's `annex_count`/`current_value` being refreshed. The resolver must additionally mark resolved targets as touched.

Per the #286 precedent (the slice bridge is "best-effort by design; the full pipeline is authoritative"), the full-path resolver fixes the entire measured backlog on the next full rebuild; go-forward annexes with a namespace mismatch stay unlinked only until then. Shipping a slice resolver without the touched-contracts wiring would leave contract totals stale — worse than deferring.

## 5. Blast radius (auto-corrects on a full rebuild)

Everything is rebuilt from scratch by `precompute.sql` (DELETE/INSERT), so it self-corrects: `company_totals`, `authority_totals`, `sector_totals`, `home_totals`, `facet_counts`, `flow_pairs`, `cpv_division_stats`, `search_index`, and each contract's `annex_count`/`current_value`/timeline. Overall annex counts and sums on the annexes themselves are unchanged. Two things to verify after the run: (1) ~23 newly-linked annexes have `value_after ≥ 2× value_before` and would trip the #305 double-count flags (`annex_total_suspect`/`value_suspect`) — correct behaviour, but #305 must be in place; (2) `cpv_division_stats` p95/p99 bands shift for affected divisions.

## 6. Tests

`packages/db/src/amendments-contract-resolve.test.ts` runs the real `derive-amendments.sql` against SQLite and pins: single-contract link (00017 shape), multi-lot value disambiguation (00011 shape), chain propagation + `current_value` = last step, value-ambiguous → unlinked, no-match → unlinked, currency guard, already-linked untouched, and the diagnostic counts.
