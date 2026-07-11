# ADR-0016: Free-text entity resolution (declared ЕИК + prose company extraction)

- Status: Accepted
- Date: 2026-07-05
- Deciders: lb, Claude
- Related: [ADR-0008](0008-deterministic-name-to-eik-resolution.md), [ADR-0009](0009-name-uniqueness-guard-and-publish-tiers.md); `scripts/cacbg/extract-companies.mjs`

## Context

Many officials do not type a clean фирма in the company field. They write a sentence
("2 дружествени дяла на „ЕН-ФРЕШ" ООД, прехвърлени нотариално…"), append the town
("„Кристална вода" АД София"), or write the ЕИК inline ("„ТРАНСПОМЕД" ЕООД, ЕИК 101677351").
The whole-string normalizer then keys the entire prose and misses a real winner — a recall loss.
~530 declared entries are prose; the signal is recoverable **without** sacrificing the certainty bar.

## Decision

Extend the resolver with two deterministic fallbacks, tried after the clean-name match, strongest first:

1. **`declared_eik`** — pull 9/13-digit ЕИК numbers from the text (a 10-digit run is an ЕГН/date shape,
   excluded). Match against the winner ЕИК set **only if the winner's own name also appears in the text** as
   an extracted „NAME"-ФОРМА candidate that normalizes (companyNameKey) exactly to that winner — this
   cross-check blocks a typo'd ЕИК from pointing at the wrong company. The confirmation is boundary-safe by
   construction: a bare `key.includes(winnerName)` substring leg was **removed**, because a winner name
   embedded mid-token in an unrelated фирма („СТРОЙ 1" inside „МЕГАСТРОЙ 15") would falsely confirm it and
   attach the wrong winner's contracts — a fabricated conflict. This is the *strongest* signal: the official
   stated the id directly.
2. **`extracted_name`** — pull „NAME"-ФОРМА company substrings from the prose; a candidate is accepted
   only if it normalizes (same companyNameKey, ADR-0008) to **exactly one** winner ЕИК.

Both feed the *same* single-key + single-ЕИК guard and publish tiers (ADR-0009) — they only change *which
string* is resolved, never the certainty rule. Each link records its `match_method` for provenance, and
the tier is computed on the resolved winner's name, not the prose.

## Consequences

- Recovered 7 additional deterministic links / 7 officials / ~€5M in the Phase-1 corpus, and resolved 3
  formerly-ambiguous entries — with **0 loss of accuracy** (every recovery is a unique, cross-checked ЕИК).
- Extractors are pure and unit-tested (incl. the negative cases: bare words → no candidate; 10-digit ≠ ЕИК).
- A prose entry that yields no unique candidate stays `noMatch` — fail-closed, never a guess.
