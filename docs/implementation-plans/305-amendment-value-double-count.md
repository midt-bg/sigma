# Implementation Plan: #305 — Amendment value double-count (a new *total* is added to the old value)

## Executive Summary

| Field | Value |
|---|---|
| Ticket | [midt-bg/sigma#305](https://github.com/midt-bg/sigma/issues/305) — labels `data-quality`, `etl`, `priority: high` |
| Problem | When an EOP annex announces a new **total** contract value, ЦАИС ЕОП puts that total in the *change* field, so `currentContractValue = lastContractValue + newTotal`. Sigma stores `value_after` verbatim, so the served value is **doubled** (the old value is counted twice). |
| Root cause | **Source data defect, faithfully stored.** `base.ts:313-315` maps `value_before ← lastContractValue`, `value_after ← currentContractValue`, `value_delta ← contractValueDifference` with **no arithmetic**. The bug is that, for a subset of annexes, `contractValueDifference` (→ `value_delta`) holds the **new total**, not the increment — and the feed's `currentContractValue` is `before + that total`. Verified: `value_after = value_before + value_delta` on **100%** of delta-carrying rows on `sigma-dev`. |
| Why existing flags miss it | A double-count is only ~2× signed value. `value_flag = 'annex_suspect'` needs ≥5× aggregate (+ a ≥10× per-step); #299 the same; the estimate-based flags need ≥10×/≥200×. 2× < 5× ⇒ classed **`ok`** ⇒ enters the `amount_eur` canonical value base and inflates every rollup. (`normalize-raw.sql:882-948`.) |
| Scale (real corpus) | On the issue's 2020→2026 local rebuild: 7,335 price-raising annexes, **686 at ≥100% growth**, ~666 unflagged, **€475.4M**. Independently reproduced on `sigma-dev`: **686 at ≥100% growth**, ~526 unflagged. The named records (145652, 189325, 84818) confirm. |
| Complexity | Medium. Detection is the hard part (a source-text heuristic with false-positive risk); the plumbing (flag + exclude, then optional correct) mirrors the existing `annex_suspect` machinery. |
| Risk | Medium. A naive correction that trusts a text heuristic can mis-restate genuine >100% increases; a flag-only tier is safe and ships first. The signature has a **blind spot** (a new-total *lower* than the old value hides below +100%), so the fix must not be sold as complete. |
| Status | **Draft — investigated with real DB calls + code trace.** |

> **Two independently-true facts frame the fix.** (1) The source is internally *consistent* — `value_after = value_before + value_delta` always — so the correction can be expressed purely as *"when `value_delta` is a **total**, the true `value_after` is `value_delta`, not `value_before + value_delta`."* (2) The defect is `value_flag = 'ok'`, so it is inside the aggregated value base; the minimal safe fix is to move it *out* of that base (a new verdict), exactly as #299 did for its case.

---

## 1. Problem, verified on real data

### 1a. The mechanism (code, on `main`)
- `packages/ingest/src/base.ts:313-315` — EOP annexes map three source keys straight to columns, no math:
  - `value_before ← lastContractValue`
  - `value_after  ← currentContractValue`
  - `value_delta  ← contractValueDifference` (the only signed field)
- `scripts/derive-amendments.sql:147-155` (mirrored in `scripts/normalize-raw.sql:752-759`): `contracts.current_value` = the latest amendment's non-null `value_after`. So the doubled `value_after` becomes the served contract value.
- `scripts/promote-amendments.sql:42-44`: `value_before/after/delta` copied verbatim into served `amendments`.

**Conclusion:** the doubled figure is not computed by Sigma; it arrives in `currentContractValue`. For the affected annexes the authority entered the **new total** into `contractValueDifference`, and the feed's `currentContractValue = lastContractValue + newTotal`. Sigma stores it faithfully.

### 1b. The named records (queried on `sigma-dev`, read-only)

| contract | source | value_before | value_after | value_delta | doubled? |
|---|---|---|---|---|---|
| 145652 (УНП 00010-2023-0006) | `eop:annexes:2024-06-21` | 442,000 | **981,240** | 539,240 | yes — `value_delta` (539,240) is the announced new total; true `value_after` = 539,240 |
| 189325 (УНП 00210-2024-0024) | `eop:annexes:2025-10-07` | 77,000,000 | **154,000,000** | 77,000,000 | yes — exact 2× (currency-change annex) |
| 84818 (УНП 00080-2023-0001) | `eop:annexes:2026-07-17` (EUR) | 76,769,540.87 | **153,539,081.74** | 76,769,540.87 | yes — exact 2× |

Caveats found in verification: 84818 has **6** amendment rows (only the 2026-07-17 EUR annex is the doubled one — earlier BGN annexes are consistent); the issue treated it as one. Absolute counts differ from the issue because `sigma-dev` (31,543 amendments) is a superset of the issue's local rebuild (26,921).

### 1c. The math signature and its blind spot
- `value_delta = value_after − value_before` holds on **100%** of delta-carrying rows (`sigma-dev`), i.e. the source is self-consistent. The defect is semantic: `value_delta` is sometimes a *total*, not an *increment*.
- A double-count where `newTotal ≥ before` produces growth **≥ 100%** (686 rows). The exactly-+100% subset (`value_after = 2×before`) is the "same total re-stated" / currency-change case.
- **Blind spot:** if `newTotal < before`, the double-count yields growth **< 100%** and hides among clean rows. The +100% line is a *safety threshold*, not a proof of cleanliness — the fix must say so.

---

## 2. Why the existing flags don't catch it

`scripts/normalize-raw.sql:882-948` (mirrored in `refresh-slice.sql`), evaluated top-down against `eff_eur = EUR(COALESCE(current_value, signing_value))`:
- `value_suspect`: `eff_eur > 2e9`, or `> 200 × proc_est_eur`, or the стотинки band — estimate-relative, ignores a 2× overrun.
- `annex_suspect` (`:937-945`, the #299/#248 rule): `current_value/signing_value ≥ 100`, **or** (`≥ 5` **and** a per-step `value_after ≥ 10 × value_before`). A double-count is ~2× signed ⇒ below 5×.
- `review`: `eff_eur ≥ 10 × proc_est_eur`.
- else `ok`.

A ~2× inflation clears none of these gates → `ok` → `amount_eur` takes `COALESCE(current_value, signing_value)` (`normalize-raw.sql:818-830`), so the doubled value is summed everywhere. Pinned by `packages/db/src/value-flag-annex-step-sql.test.ts` (the 5× floor is the smallest firing case; 4.9× stays `ok`).

**Downstream consumers currently inflated** (all via the shared `amount_eur` base — `precompute.sql:16-19`): contract-list totals/sort/buckets and CSV export (`queries/contracts.ts:318,61-62,432,475`); `company_totals.won_eur`, `authority_totals.spent_eur`, `home_totals.value_eur` (`precompute.sql:42-60`); the contract detail value strip and the **amendment timeline**, which reads `amendments.value_after` unrepaired (`queries/details.ts:451-460,670-684`). *(The `/anomalies` #239 and `/overruns` #171 signals named in the issue are not on `main` yet — they will inherit the fix once they land.)*

---

## 3. Detection

The correction hinges on classifying each price-raising annex as **increment** vs **total**. Layer the signals; never rely on free text alone.

1. **Arithmetic gate (necessary, cheap, high-recall / low-precision):** `value_before > 0 AND value_after ≥ 2 × value_before` (equivalently `value_delta ≥ value_before`). A single annex whose *increment* is ≥ the entire prior value is implausible; a double-count always lands here. Catches the 686. Does **not** catch the sub-100% blind spot (out of scope for v1, documented).
2. **Text confirmation (raises precision):** the основание free-text carries a number equal to `value_delta` in a *total* context — keywords `обща|общата|крайна|краен|възлиза|става` near the figure (the issue found 355 such records). Available fields at the raw/derive stage: `raw_amendments.description` (`changeDescription`), `reason` (`changeReason`), `circumstances` (`changeReasonDescription`) — see §5 note. Parse Bulgarian number formats (`1 234 567,89` / `1234567.89`), compare to `value_delta` within a small relative tolerance.
3. **Currency-change tell (special-case, very high precision):** exactly-+100% rows whose text mentions `евро|валута|EUR|лева в евро` are currency re-denominations with the total doubled (e.g. 189325). Treat as confirmed total.

Classification:
- **Confirmed total** = gate (1) AND (text (2) or (3)). → correct (Tier 2) and/or flag.
- **Suspected total** = gate (1) only (no text confirmation). → flag-only (Tier 1); do not silently rewrite the value.

---

## 4. The fix

Two tiers. Ship Tier 1 first (safe, immediate); Tier 2 is the higher-value correction and needs the text heuristic hardened by tests.

### Tier 1 — Flag and exclude from aggregates (minimal, safe, ships first)
Mirror the `annex_suspect` machinery so the ~475M/€ inflation leaves every rollup immediately, without trusting any text parse.
- Add a new `value_flag` verdict, e.g. **`annex_total_suspect`**, in `scripts/normalize-raw.sql` (and the `refresh-slice.sql` mirror + its reconciliation re-flag), placed **before** the `ELSE 'ok'`: fires when the contract's current-value-driving annex satisfies the arithmetic gate (§3.1) and the source-consistency check (`value_after ≈ value_before + value_delta`).
- Route it through the existing suspect fallback: `amount_eur`/`trusted_native` fall back to `signing_value` (`normalize-raw.sql:818-830`) and `precompute.sql:36` NULLs `current_value_eur` — so these contracts drop out of totals/CSV/pages exactly like `annex_suspect`.
- Emit a diagnostic count (like #286's diagnostics) so the flagged volume is observable in the ETL log.
- **Per-amendment flag (the issue's specific gap):** the contract flag does not fix the timeline row. Add a per-amendment marker so `queries/details.ts` can render the row as "suspected re-stated total" and suppress its `+%`. Options: a `value_flag`/`total_restated` column on served `amendments` (schema migration + carry through `promote-amendments.sql`), or recompute the same predicate in the details query. Prefer the column (single source of truth, avoids duplicating the heuristic in TS).

### Tier 2 — Correct the value (higher value, needs text confirmation)
For **confirmed totals** (§3), restate the amendment at the **raw/derive stage** (where `value_before`, `value_delta`, and all three text fields coexist — see §5):
- Because the source is self-consistent, the correction is simply **`value_after := value_delta`** (the announced new total) and **`value_delta := value_after_old − value_before`** *no* — restate as: `corrected_after = value_delta_source` (the total); `corrected_delta = corrected_after − value_before` (the true increase). Keep the raw source values immutable in `raw_amendments`; write corrected values on the way to served `amendments` (a `promote`/derive transform), plus a `total_restated = 1` marker.
- `contracts.current_value` then derives from the corrected `value_after`, so headline value, deltas, and the timeline are all right — not merely excluded.
- Keep Tier-1 flagging for the **suspected-but-unconfirmed** set (gate only, no text) so nothing inflates while remaining un-restated.

### Fix location (decided)
Raw/derive stage, **not** ingest and **not** the served query layer:
- Ingest (`base.ts`) must stay a faithful mirror of the source (per `docs/etl.md` non-destructive-staging stance) — do not mutate `raw_amendments`.
- The correction/flag needs `value_before`, `value_delta`, and the основание text on one row, which is true in `raw_amendments` and consumed by `derive-amendments.sql` / `normalize-raw.sql` / `promote-amendments.sql`. Implement there; keep `derive-amendments.sql` and `refresh-slice.sql` in lockstep (a drift guard already exists for the #286 bridge block — extend the pattern).

---

## 5. Schema / data note (blocking for Tier 2)
Only `description` survives to served `amendments`; `reason` and `circumstances` are dropped at `promote-amendments.sql:9-11` (served DDL `0000_init.sql:169-182`). The text heuristic therefore must run at the **raw/derive** stage where all three exist (`work-staging-schema.sql:178-180`). If any per-row flag or corrected value must be *visible* to the app, add the column(s) to the served `amendments` table (migration) and carry them through `promote-amendments.sql` + the `refresh-slice.sql` amendments promotion.

---

## 6. Testing — proving the fix
1. **Unit — number/keyword parser** (`packages/ingest` or a new `packages/db` SQL-driven test): Bulgarian number formats; total-context keywords vs increment phrasing; the currency-change tell. Fixtures from the real examples (145652 "възлезе на 539 240.00 лв."; 189325 currency change; a genuine >100% *increment* that must NOT be corrected).
2. **End-to-end SQL** (extend `packages/db/src/refresh-slice.test.ts` / a new `amendments-total-suspect.test.ts`): run the real `derive-amendments.sql → normalize-raw.sql → promote-amendments.sql` and assert: (a) a confirmed-total annex is restated (`value_after = value_delta`, `current_value` correct, `total_restated = 1`); (b) a suspected-only annex is flagged `annex_total_suspect` and excluded from `amount_eur`; (c) a genuine >100% increment stays `ok` and untouched (guard against false positives); (d) the exactly-+100% currency case restates to no real growth.
3. **Flag-coverage regression**: assert the new verdict count on a seeded corpus, and that `value-flag-annex-step-sql.test.ts`'s existing cases are unchanged.
4. **Real-corpus before/after**: rebuild the 2020→2026 corpus (local work-DB, then optionally ship), and report flagged/corrected counts + the EUR removed from `company_totals`/`authority_totals`/`home_totals`. Target: the 686 (≥100%) restated or flagged, headline totals drop by the double-counted amount, zero genuine-increment regressions.

---

## 7. Scope boundaries & risks
- **In scope:** EOP annexes (the sole driver — OCDS rows carry `value_after = NULL` and never drive `current_value`, per #286).
- **Blind spot (out of scope for v1, must be documented):** double-counts where the new total is *lower* than the old value (growth < 100%) — not detectable by the arithmetic gate. Text-only detection could reach them but at higher false-positive cost; defer.
- **False-positive risk (the main hazard):** a genuine annex that legitimately more-than-doubles a contract. Tier 1 only *flags* (reversible, excludes from aggregates); Tier 2 *rewrites* and must require text confirmation + be unit-tested against a real >100%-increment fixture. When uncertain, prefer flag over rewrite.
- **Adjacent / not this:** #299 (`c44a7ee`) and #248 handle the ≥10×/≥5× mis-keying case (kept); #245 (EUR double-conversion) and #304/#247 (стотинки) are separate. This defect is the sub-5× band those cannot reach.
- **Consumer follow-through:** once `/anomalies` (#239) and `/overruns` (#171) land, confirm they read a value base that already excludes/corrects these (they will, if they use `amount_eur` + `value_flag`).
