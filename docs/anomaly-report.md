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
| **CPV-cohort outlier** | A priced contract whose `amount_eur` exceeds **25×** the p95 of its CPV-division cohort, for divisions with **≥12** priced contracts. Catches a single award far above everything comparable. |
| **Decimal shift** | A gross cohort outlier whose `amount_eur ÷ 10` or `÷ 100` lands back inside the cohort's normal band `[median/8, median×8]`. Catches the "valid number, wrong magnitude" loader artifact (e.g. €5,000,000 that should be €50,000) that `value_flag` passes. |

## Thresholds (`ANOMALY_DEFAULTS`)

| Knob | Default | Why |
|---|---|---|
| `minCohort` | 12 | A division needs enough priced rows before its distribution is trustworthy. |
| `cohortFactor` | 25 | Flag the *gross*, not the merely large — a high bar keeps the report's signal high so readers trust it. |
| `decimalRescaleMax` | 8 | How close a `÷10`/`÷100` rescale must land to the cohort median to read as a misplaced decimal. |
| `topExamples` | 20 | Caps examples per finding so the report (and any future notification) stays bounded. |

The thresholds are intentionally conservative: a flood of "big but legitimate"
contracts would train the reader to ignore the report. Tune against the observed
corpus — the detection logic is pure and unit-tested
(`packages/db/src/anomaly-report.test.ts`), so threshold changes are safe to
iterate.

## Relationship to other work

Complements, does not duplicate, the **#41** price-deviation risk flag: that is a
per-page UI badge for end users; this is an ETL-time corpus report for the
maintainer. A hit here is a prompt to inspect the source row — it is not asserted
as an error, and the value is still served (flagged by `value_flag` only if its
own row qualifies).
