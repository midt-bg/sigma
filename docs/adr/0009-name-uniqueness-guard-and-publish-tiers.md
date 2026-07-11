# ADR-0009: Name-uniqueness is not absolute → single-ЕИК guard + publish tiers

- Status: Accepted
- Date: 2026-07-05
- Deciders: lb, Claude
- Related: spec §5; refines [ADR-0008](0008-deterministic-name-to-eik-resolution.md)

## Context

ADR-0008 assumed a normalized full name maps to exactly one ЕИК (national trade-name uniqueness).
Phase 0 measured this on the real 17,669-winner corpus and found it **partly false**: 53 normalized
keys map to >1 real ЕИК. Two causes, neither a normalizer fault (true normalizer over-merges = 0):
- **Genuinely shared generic names** — e.g. „Водоснабдяване и канализация" ЕООД / „В и К" ООД are
  separate per-region municipal monopolies registered under the same bare name.
- **Source ЕИК typos** — one-digit-off ЕИК for the same фирма in the EOP data.

A single-key match on such a name could attribute a stake to the wrong company = a false accusation.

## Decision

The deterministic rule is **single-key AND single-winner-ЕИК**, not single-key alone. On top of it,
each match gets a **publish tier** (`scripts/cacbg/classify.mjs`):

- **Quarantine** — key maps to 0 or >1 valid ЕИК → never deterministic, never published.
- **Tier A — seat-confirmed** — declared seat == winner `settlement` (both present) → same entity proven
  even for generic names. Fully deterministic. Publishable.
- **Tier B — distinctive name** — single ЕИК + a structurally distinctive name (contains a digit, a
  Latin/brand token, or ≥3 content words) → collision-improbable. Publishable; the distinctiveness test
  is a **disclosed heuristic** that only ever withholds, never asserts.
- **Tier C — generic name, no seat proof** — HELD pending a **TR-wide name-uniqueness census** (or a
  leg-2 per-ЕИК confirmation). Not published.

## Consequences

- In the Phase-0 corpus the single-ЕИК guard quarantined all 53 collisions — 0 leaked into the published
  set. The residual risk (a generic name with exactly one *winner* namesake that is not globally unique)
  is closed by Tier C + the Phase-1 TR census.
- Adds a Phase-1 requirement: a one-time TR name-frequency census to promote Tier-C matches safely.
- `settlement` becomes useful after all (Tier A), though sparse (~28% of winners) — a bonus, not a
  dependency.
- The distinctiveness heuristic is documented on the methodology page and stored as a field on each match.
