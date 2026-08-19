# ADR-0013: Two declaration templates — shares + participation + management + related persons

- Status: Accepted
- Date: 2026-07-05
- Deciders: lb, Claude
- Related: spec §3–4; `scripts/cacbg/parse.mjs`

## Context

The register mixes two XML templates, discovered during Phase 0:
- `<PublicPerson>` — the **asset declaration** (декларация за имущество, annual). Company **shares** live
  in the „Дялове/Прехвърляне на дялове в дружества" tables (company name in column 4).
- `<PublicPersonDekl2>` — the **interests declaration** (декларация за интереси, at appointment). Much
  richer: participation in companies, **being управител / member of a management-or-control body**,
  sole-trader activity, conflict-contracts, and **declared related persons** (column 2).

An early single-template parser silently returned empty for interests declarations — so an entire,
high-value declaration type (including *control without ownership* and the "свързани лица" data the
project is named for) was being missed.

## Decision

The parser detects the root element and handles both templates, emitting a unified `interests[]` with a
`kind`:
- `shares` (asset decl tables 10/11) — ownership stake.
- `participation` (interests tables 15/18) — declared company participation (current / 12-months-prior).
- `management` (interests tables 16/19) — **управител / board / control role** — a conflict signal
  independent of ownership.
- `sole_trader` (interests tables 17/20) — ЕТ activity.

Third-party people (interests tables 21/22 — conflict-contracts and declared related persons) go to a
**separate `relatedPersons[]`**, INTERNAL-only per ADR-0010. Column semantics are learned from each
table's header `@_Description`, with fixed fallbacks per template — robust to column reordering.

## Consequences

- The matcher gains the **management/control** dimension: officials who *run* a winner, not only own it —
  often the more egregious conflict.
- The свързани-лица graph (issue #60 territory) gets its declared-related-persons feed, held internal.
- Both templates share one deterministic name→ЕИК resolver (ADR-0008/0009); no per-template match logic.
- Parser tests cover both templates plus the PII split (related names never enter `interests`).
