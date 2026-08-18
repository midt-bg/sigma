# Implementation Plan: feat/assistant-large-data-summary — totals-headline nudge (prompt-only)

## Goal

For a list/breakdown report (`table`/`bar`/`flows`/`timeseries`), surface a meaningful headline
number in the dock's compact report chip instead of just a title. The chip's `leadStat`
(`report-projection.ts`) already reads the first `totals`/`facts` item — so the only gap is that the
model doesn't reliably emit a leading `totals` block. This nudges it to.

## Why prompt-only

- `leadStat` already surfaces a `totals` headline → no dock change needed.
- The golden suite replays fixed `emit_report` inputs and never calls `buildSystemPrompt` → a prompt
  change can't touch it (verified).
- E2 forbids currency/large numbers in prose, and VALUES_BY_REFERENCE forbids model-authored numbers,
  so the number MUST come from a server-bound `totals` block — a prompt nudge is the right lever.

## Change

1. `system-prompt.ts` — `HEADLINE_TOTALS_RULE` + wire into `buildSystemPrompt` after `EDITORIAL_SKELETON`.
2. `agent.ts` — bump `PROMPT_VERSION` (mandatory on any semantic prompt change; stamps StoredReport
   provenance).
3. `system-prompt.test.ts` — a `.toContain(HEADLINE_TOTALS_RULE)` presence test.

## Safety decisions (from multi-agent review)

The naive rule backfires on a public transparency tool; the shipped rule guards against it:

- **Never point `totals` at a list row.** A pressured 31B could ref row 0 of the list (R1); `bindReport`
  binds it happily and E2 doesn't catch it (it's a *bound* number) → the chip shows the top row's value
  labelled "Общо" — a misleading figure. The rule mandates a **dedicated COUNT/SUM aggregate query**.
- **Full-population aggregate**, not the shown/truncated rows (a truncated SUM understates).
- **Conditional, not mandatory** — skip when there's no single summarizing number: `flows`, or
  `timeseries` where "rows" are just periods; COUNT of *contracts*, not rows.
- **No `SUM() OVER()`** — window opcodes (`AggValue`/`AggInverse`) aren't in the L3 opcode allowlist, so a
  windowed headline would be false-denied. Use a separate aggregate query.
- **No spurious reconcile** — a full-population headline doesn't trigger `reconcile_rollup` unless it's a
  single grain a rollup covers (avoids a wasted step).

## Rejected: dock-side row-count fallback

Deriving `rows.length` as "N реда" when the model omits `totals` was rejected: the row count is only
meaningful for entity lists — for a sector breakdown (20 rows) or a 12-month timeseries it's a
misleading number. Better a title-only chip (the chat prose gives qualitative context) than a wrong
number. So there is no dock change.

## Accepted residuals

- Soft nudge — a 31B may still skip the `totals`; then the chip is title-only (acceptable; no wrong
  number manufactured).
- +1 aggregate step per list turn (latency); covered by `afc93d8`'s force-emit-near-budget safety net.

## Verification

`tsc -b` clean · `system-prompt.test.ts` green · full suite green aside from the pre-existing Node-24
SQLite tripwire · prettier clean. Test-safe confirmed by review (no prompt snapshot/length/order
assertions; nothing asserts `PROMPT_VERSION`).

---

**Status:** Implemented · **Created:** 2026-07-02 · **Approved by:** nmilenkov
