# ADR-0008: Deterministic name→ЕИК resolution via own bidder data + a conservative normalizer

- Status: Accepted (refined by [ADR-0009](0009-name-uniqueness-guard-and-publish-tiers.md))
- Date: 2026-07-05
- Deciders: lb, Claude
- Related: spec §5

## Context

CACBG declarations name the companies an official holds an interest in, but carry **no ЕИК** (the
company's unique registry id) — and no ЕГН. To join a declared holding to a contract winner we need
the ЕИК. Fetching it from the Trade Register in bulk is DPA-hostile and slow. We need a resolution
path that is both lawful and *deterministic* (per the certainty bar, ADR-0007).

## Decision

Resolve the ЕИК from **our own contract data**, not an external registry:

1. The ЦАИС ЕОП `raw_contracts` staging pairs `contractor_name ↔ contractor_eik` in the *same* source
   record — so for every company that ever won public money we already hold name→ЕИК.
2. Bulgarian trade names are nationally unique on the full фирма incl. legal form (ЗТРРЮЛНЦ чл.21 т.7 /
   ТЗ чл.7). So: normalize the declared full name → **exact-key match** against `bidders.name` → the
   paired `eik_normalized` is the company's ЕИК, deterministically → join to contracts.
3. The **sole libel surface is normalization**, not ambiguity. The declared string and the ЕОП name are
   typed independently, so "exact match" means exact *after conservative normalization*. The normalizer
   (`packages/shared/src/company-name-key.ts`) folds **only presentation** (case, whitespace, quote
   glyphs) and preserves every distinguishing token (legal form, ordinals). It must NOT transliterate
   Cyrillic↔Latin, fold и/&, or strip the form — each would merge distinct фирми = a false accusation.
4. It is the **single source of truth** and is production-grade + fully tested. Any code that needs the
   key imports it; no copies. Its test asserts **0 over-merge** on a labelled stratified sample.

## Consequences

- No external registry is on the critical path for resolution (TR is needed only for *owners*, a later leg).
- `settlement`/town is not needed for identity, so its sparseness is not a blocker.
- The normalizer's over-merge count is the empirically-measurable libel gate (bar 0), proven in Phase 0
  on both the labelled sample and the full 17.7k-winner corpus.
- The universal-uniqueness assumption in point 2 turned out **not to be absolute** for a class of generic
  municipal names — see ADR-0009, which adds the single-ЕИК guard and publish tiers on top of this.
