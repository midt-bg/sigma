# ADR-0017: A globally non-unique name cannot ride the name-distinctive tier — even with a certain ЕИК

- Status: Accepted
- Date: 2026-07-05
- Deciders: lb, Claude
- Related: [ADR-0009](0009-name-uniqueness-guard-and-publish-tiers.md), [ADR-0016](0016-free-text-entity-resolution.md); `scripts/cacbg/load.mjs`, `scripts/cacbg/audit.mjs`

## Context

The adversarial audit of the published set (`scripts/cacbg/audit.mjs`, which rebuilds the
name-key → ЕИК map from scratch over the live bidder table and re-asserts the libel invariant per
link) surfaced one hard finding: a link published as `B_distinctive` whose name key
„ВОДОСНАБДЯВАНЕ И КАНАЛИЗАЦИЯ ЕАД" maps to **two** valid ЕИК (812115210 and 121411430 — different
towns). BG trade names are nationally unique in principle (ЗТРРЮЛНЦ чл.21 т.7), but empirically this
does **not** hold for generic municipal utilities (В и К, Водоснабдяване и канализация).

The link's ЕИК was itself *correct*: the official wrote „…, ЕИК 812115210" in the declaration and the
`declared_eik` cross-check passed. The defect was not the resolution — it was the **tier**. The
`declared_eik` and `extracted_name` fallbacks (ADR-0016) resolve straight to a specific ЕИК and so
bypass the resolver's own single-name-key → single-ЕИК guard (which only fires on the `exact_name_key`
path). `nameDistinctiveness()` is a string-shape heuristic (does the key carry a legal form + a
distinguishing token) — it cannot see that the *string* is shared by two different companies. So a
certain-ЕИК match behind a colliding name was mislabelled as safe-to-show-by-name.

## Decision

Global name-uniqueness is now a precondition of the name-distinctive tier, enforced at tier
assignment for **every** match method:

- Before computing the tier, `load.mjs` checks `nameGloballyUnique(key)` — does this name key back
  exactly one valid winner ЕИК across the whole bidder set?
- If not, distinctiveness is forced to `generic` regardless of the string's shape. The link can then
  publish **only** if the declared seat disambiguates it (`A_seat`), otherwise it is `C_hold` — held,
  not published.

This holds even when the ЕИК is certain (`declared_eik`). `B_distinctive`'s premise is "the name alone
identifies the company"; a name shared by two ЕИК violates that premise no matter how the ЕИК was
obtained. The resolution certainty is preserved in `match_method` and the link still exists as `held`,
so a future display layer that renders ЕИК + town (rather than the bare name) can promote it safely.

## Consequences

- The В и К link moved published → held; published count 114 → 113. No accuracy loss — the held link is
  correct, just not safe to render name-only. The seat-confirmed sibling case *is* publishable as
  `A_seat` (the town disambiguates the collision), so the gate is not blanket suppression.
- `scripts/cacbg/audit.mjs` is retained as a standing CI guard: it exits non-zero on any published
  link whose name key does not resolve to exactly one valid ЕИК == the published one. The invariant is
  also locked in `load.test.mjs` (a `declared_eik` match behind a colliding name → held; the same with a
  confirming seat → `A_seat`).
- Fail-closed remains the rule: certainty about the ЕИК never overrides ambiguity in the published
  surface.
