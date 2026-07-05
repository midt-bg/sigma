# Anomaly report (per refresh)

The per-row [`value_flag`](etl.md) system catches a single contract's own defects
(`value_suspect` / `annex_suspect` / `value_low`). It cannot see **cross-row**
problems — a contract that is internally valid but grossly out of line with its
peers. The anomaly report (`scripts/anomaly-report.mjs`, issue #100) adds that
view and emits a human-readable summary on every refresh.

It **observes, it does not gate.** Unlike the reconciliation gate
([`integrity-gate.md`](integrity-gate.md), #97) which fails the import on numeric
drift, the anomaly report never fails the import — a detector bug or an unusual
corpus can only omit a line, never block a ship. It runs right after
`assertIntegrity` in both the full and slice derive paths.

## What it flags

| Finding | Heuristic |
|---|---|
| **CPV-cohort outlier** | A priced contract whose `amount_eur` exceeds **25×** the **leave-one-out p95** of its CPV-division cohort (the candidate is excluded from its own percentile), for divisions with **≥12** priced contracts. Catches a single award far above everything comparable. |
| **Decimal shift** | A contract **above** its cohort's normal band `[median/2, median×2]` (leave-one-out median) whose `amount_eur ÷ 10` or `÷ 100` lands back **inside** that band — i.e. only (5×,20×] median reads as ÷10 and (50×,200×] as ÷100. The band ratio must stay < 10, or the two windows tile contiguously and the check stops excluding anything. Catches the "valid number, wrong magnitude" loader artifact (e.g. €1,120,000 that should be €112,000) that `value_flag` passes. Deliberately **not** gated behind the 25× gross-outlier test: a typical ×10 shift sits at only ~8–10× its cohort, so requiring 25× first made the single misplaced decimal — the most common loader artifact — undetectable. Being outside the band *and* rescaling back into it is the signal. |

The headline `total` is **deduplicated by contract id** across findings — a
decimal-shift suspect is usually also a cohort outlier, and counting it in both
findings would ~2× inflate the number the reader is asked to trust. Per-finding
totals remain per-finding.

## Why p95 — and why leave-one-out

p95 is not robust in right-skewed divisions (construction, CPV 45): legitimate
large awards raise the anchor, and the 25× factor on top of it raises the bar
further. That is a deliberate trade — the report optimises for *precision*
(every line worth reading) over recall, and median/MAD anchors were considered
and rejected for now because in heavy-tailed divisions they flag too many "big
but legitimate" awards. Two mitigations make p95 defensible:

- **Leave-one-out:** each candidate is excluded from its own percentile
  (`percentileExcluding`). Without this, a lone gross outlier in a small cohort
  (12–20 rows) drags the interpolated p95 into itself and becomes invisible —
  exactly the "one contract far above its cohort" case the report exists for.
  With leave-one-out the anchor is the *rest* of the cohort at any size.
- The decimal-shift detector anchors on the (leave-one-out) **median**, which is
  robust to the tail, so the most common artifact class does not depend on p95
  at all.

If observed corpora show gross outliers hiding under skew-inflated p95, the
switch to median/MAD is a contained change: the anchors live in two pure
functions with unit fixtures.

## Thresholds (`ANOMALY_DEFAULTS`)

| Knob | Default | Why |
|---|---|---|
| `minCohort` | 12 | A division needs enough priced rows before its distribution is trustworthy. |
| `cohortFactor` | 25 | Flag the *gross*, not the merely large — a high bar keeps the report's signal high so readers trust it. Applies to the cohort-outlier finding only. |
| `decimalRescaleMax` | 2 | Half-width of the cohort's normal band `[median/2, median×2]`: the original must sit above it and the `÷10`/`÷100` rescale must land inside it to read as a misplaced decimal. Must keep the band ratio < 10 (see above). |
| `topExamples` | 20 | Caps examples per finding so the report (and any future notification) stays bounded. |

The thresholds are intentionally conservative: a flood of "big but legitimate"
contracts would train the reader to ignore the report. Tune against the observed
corpus — the detection logic is pure and unit-tested
(`packages/db/src/anomaly-report.test.ts`), so threshold changes are safe to
iterate.

## Scope and known limitations

- **Downward shifts are not detected.** The detector only looks above the cohort band, so a
  value that lost a digit (÷10 too *small*) passes silently — a possible future addition.

- The report runs in the **full** and **slice** derive paths (right after
  `assertIntegrity`). It does **not** run in the work-backfill path — so "every
  refresh" means every derive-refresh, not every write to the database.
- Issue **#100** also proposed a **"new this refresh"** detector (flag outliers
  only among rows added by the current refresh). This module defers that: it
  reports over the whole priced corpus each run. The PR is therefore *part of*
  #100, not a full close.

## Relationship to other work

Complements, does not duplicate, the **#41** price-deviation risk flag: that is a
per-page UI badge for end users; this is an ETL-time corpus report for the
maintainer. A hit here is a prompt to inspect the source row — it is not asserted
as an error, and the value is still served (flagged by `value_flag` only if its
own row qualifies).
