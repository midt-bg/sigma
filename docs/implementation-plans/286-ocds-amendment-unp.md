# Implementation Plan: #286 — OCDS amendments don't link to any contract (OCID instead of УНП)

## Executive Summary

| Field | Value |
|---|---|
| Ticket | [midt-bg/sigma#286](https://github.com/midt-bg/sigma/issues/286) — labels `data-quality`, `etl`, `priority: high` |
| Problem | OCDS-sourced rows in `amendments` store the **OCID** (`ocds-e82gsb-245534`) in `unp` instead of the **УНП** (`00044-2022-0146`), so **none** of them join to a contract. Measured live on `sigma-dev`: 4,800 OCDS rows, **0 linked**. |
| Root cause | `packages/ingest/src/ocds.ts` sets `unp: rel.ocid`. The УНП is **not present anywhere structured** in the OCDS feed — it must be recovered by bridging OCDS `tender.id` → EOP `tenderId` (`raw_tenders.tender_id` / `tenders.eop_tender_id`) → УНП (`source_id`). |
| Approach | (1) Ingest captures `tender_ext_id` + fixes value semantics; (2) SQL bridge rewrites the OCDS `unp` from the existing lots-bridge pattern; (3) prefer-EOP dedup so twins don't double-count and the value trap can't fire. |
| Complexity | Medium — small code, but the correctness traps (value semantics + cross-source dedup) are the whole point. |
| Risk | Medium — touches the value pipeline that feeds headline `current_value`; a naive fix understates contracts by millions (issue's €5.8M case). Mitigated by parts 2+3 shipping together and a real-corpus before/after. |
| Status | **Draft — validated against the live `sigma-dev` corpus.** |

> **The two halves are inseparable.** Fixing the join key *without* fixing the OCDS value semantics is worse than the bug: once linked, the stale OCDS "before" value competes with the correct EOP value on the same `published_at` and the tiebreak can pick it. Key-alignment **and** value-correctness land in the same PR.

---

## 1. Problem, verified on real data

The УНП is genuinely absent from the OCDS releases. Pulling the real feed
`storage.eop.bg/open-data-2026-03-05/…OCDS.json` and walking all 28
`contractAmendment` releases: the `NNNNN-YYYY-NNNN` УНП pattern appears **zero
times** as a structured field (once, incidentally, in free-text `rationale`). A
real release carries only:

- `ocid: "ocds-e82gsb-425867"` and `tender.id: "425867"` (the EOP internal
  procedure id = the OCID suffix)
- `contracts[].id: "180821"` (the contract number)
- `buyer.identifier.id: "000024948"` (authority EIK)
- `contracts[].value` — the **pre-amendment** value

The EOP base "договори" feed, by contrast, carries **both** join anchors:
`uniqueProcurementNumber` (→ `unp`, the УНП) **and** `tenderId` (→
`tender_ext_id`, the same id space as OCDS `tender.id`).

### Reproduction on `sigma-dev` (live)

| check | count |
|---|---|
| `amendments` rows with `source LIKE 'ocds:%'` | 4,800 |
| …with `unp LIKE 'ocds-%'` | 4,800 (all) |
| …that link via `contracts.tender_id = 't:' \|\| unp` | **0** |
| `eop:%` rows that link | 174,635 |

### The value trap (contract 90029, live)

| source | unp | value_before | value_after | published_at |
|---|---|---|---|---|
| `eop:annexes` | `00044-2022-0146` | 21,602,081.98 | **27,435,415.31** | 2026-03-05 |
| `ocds:` | `ocds-e82gsb-245534` | null | **21,602,081.98** | 2026-03-05 |

`ocds.ts:378-379` writes `value_after = c.value.amount` (the *before* value) and
`value_before = null`. `derive-amendments.sql:42-50` selects `current_value` as
the latest non-null `value_after` with `ORDER BY published_at DESC, natural_key
DESC`. Same date ⇒ the tiebreak can pick OCDS's 21.6M and drop €5.8M. Twin
samples confirm OCDS values are generally stale/partial (e.g. contract 188980:
OCDS 111,163 vs EOP 217,416), so the OCDS value is never trustworthy as an
"after".

---

## 2. Why the bridge is the right recovery (proven in-repo + on data)

The exact bridge already exists for OCDS **lots** —
`scripts/normalize-raw.sql:1110-1133`:

```
-- The bridge is OCDS tender.id -> EOP tenderId (raw_tenders.tender_id) -> UNP -> domain lots.
-- ocid is a surrogate and is never treated as the UNP.
JOIN raw_tenders rt ON rt.tender_id = rl.tender_id
```

OCDS **amendments** never got the same treatment: `releaseToAmendments` doesn't
read `rel.tender.id`, even though `raw_amendments.tender_ext_id` already exists
as a column (`work-staging-schema.sql:183`) and EOP amendments populate it
(`base.ts:300`).

Read-only validation of the bridge against `sigma-dev` (all OCDS `unp` are
`ocds-e82gsb-<tender.id>`; `tenders.eop_tender_id` maps to `source_id`/УНП):

| step | count |
|---|---|
| OCDS amendments whose `tender.id` bridges to a tender (УНП recovered) | 4,797 / 4,800 |
| …that link to a contract with matching `contract_number` | **4,782** |
| …that have an **EOP twin** for the same `(unp, contract_number)` | 4,741 (~99%) |
| genuinely **OCDS-only** annexes (net-new) | ~41 |

So ~99% of OCDS amendments duplicate an existing EOP annex. Linking them without
dedup would ~double `annex_count` on those contracts and arm the value trap.
Per-annex twin matching is unreliable (twin dates and values differ), so dedup is
done at the contract level: **prefer EOP; use OCDS only where EOP has no annex.**

---

## 3. The fix (three parts, one PR)

> **Shipped implementation — where it diverged from the plan below (this section is the original
> planning snapshot).** Part 2's bridge landed in `scripts/derive-amendments.sql` (mirrored in
> `scripts/refresh-slice.sql`), **not** `normalize-raw.sql` — `derive-amendments.sql` is the *first*
> consumer of `raw_amendments` on every path, so the rewrite has to happen there or its own rollup still
> joins on the OCID. Part 3's dedup shipped as a `DELETE FROM raw_amendments` (not an inline
> `WHERE NOT EXISTS` filter), and `promote-amendments.sql` is unchanged. On the incremental path the
> slice dedup additionally reconciles against the cumulative served `amendments` table (full path rebuilds
> it wholesale, so it needs no equivalent). See the review thread on the PR for the reasoning.

### Part 1 — Ingest (`packages/ingest/src/ocds.ts`, `apps/etl` re-exports)
- Add `tender_ext_id` to `AmendmentStagingRow` and `AMENDMENT_STAGING_COLS`.
- In `releaseToAmendments`, set `tender_ext_id: clean(rel.tender?.id)`.
- Value semantics: store the release value as `value_before`; leave
  `value_after = null`. OCDS cannot know the after-value, so it must never drive
  `current_value`. (Verify `contractUpdate` separately before treating it the
  same as `contractAmendment`; default to the conservative before-only mapping.)
- Unit tests updated in `packages/ingest/src/ocds.test.ts`.

### Part 2 — SQL bridge (`scripts/normalize-raw.sql`)
- Before `derive-amendments.sql` / `promote-amendments.sql`, rewrite OCDS
  amendment `unp` from the bridge, mirroring the lots block:
  ```sql
  UPDATE raw_amendments
  SET unp = (
    SELECT rt.unp FROM raw_tenders rt
    WHERE rt.tender_id = raw_amendments.tender_ext_id AND rt.unp IS NOT NULL
  )
  WHERE source LIKE 'ocds:%'
    AND tender_ext_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM raw_tenders rt WHERE rt.tender_id = raw_amendments.tender_ext_id AND rt.unp IS NOT NULL);
  ```
  Fallback to `raw_contracts.tender_ext_id` where a tender row is absent. `ocid`
  stays only as a surrogate, never a key. Mirror the same step in
  `scripts/refresh-slice.sql` (the scoped slice path).

### Part 3 — Prefer-EOP dedup (`derive-amendments.sql` + `promote-amendments.sql`)
- Include an OCDS amendment only when no EOP amendment exists for the same
  `(unp, contract_number)`:
  ```sql
  AND NOT (source LIKE 'ocds:%' AND EXISTS (
    SELECT 1 FROM raw_amendments e
    WHERE e.source LIKE 'eop:%' AND e.unp = raw_amendments.unp
      AND e.contract_number = raw_amendments.contract_number))
  ```
  This kills the double-count and the value trap in one move while still
  surfacing the ~41 OCDS-only annexes. OCDS-only rows keep `value_after = null`,
  so they increment `annex_count` and become visible/linked without inventing a
  `current_value`.

---

## 4. Testing — proving we solved the real problem

1. **Unit** (`packages/ingest/src/ocds.test.ts`): realistic fixture with
   `tender.id` + value asserts `tender_ext_id` captured, `value_before` set,
   `value_after` null.
2. **End-to-end SQL** (`packages/db/src/refresh-slice.test.ts` harness runs the
   *actual* `normalize-raw → derive-amendments → promote-amendments` scripts via
   the sqlite3 CLI). New case seeds:
   - an EOP tender+contract (УНП `X`, `tenderId T`) with one EOP annex,
   - an OCDS twin (`ocds-…-T`, same `contract_number`),
   - an OCDS-only annex (`tenderId T2`, no EOP annex).
   Assert: OCDS-only links & counts once; twin is dropped; the 90029 scenario
   keeps `current_value = 27.4M` (never 21.6M).
3. **Repro regression**: encode the issue's SQL (`ocds:%` linked rows > 0,
   no contract understated) as assertions.
4. **Real-corpus before/after**: rebuild a local slice from the public feeds and
   run the repro queries; optionally dry-run-validate the bridge against
   `sigma-dev` read-only. Expected: linked OCDS rows 0 → ~41 net (4,782 matched,
   4,741 deduped), zero contracts understated.

---

## 5. Scope boundaries

- **Out of scope:** OCDS *contracts* also store the OCID in `unp`
  (`ocds.ts:323`); whether they reach the served domain at all is a separate
  question — note it, don't fold it in.
- **Adjacent:** #248 (annex plausibility) and PR #285 (`value_delta` sign) touch
  the same table but are independent defects.
- **Migration:** none — `raw_amendments.tender_ext_id` already exists; the change
  is ingest + ETL SQL + tests only.
