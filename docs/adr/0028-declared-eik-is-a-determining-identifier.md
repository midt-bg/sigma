# ADR-0028: Declared ЕИК is a determining identifier — tier `A_eik`, exempt from the TR census

- Status: Accepted
- Date: 2026-07-11
- Deciders: lb, Claude
- Related: [ADR-0009](0009-name-uniqueness-guard-and-publish-tiers.md), [ADR-0015](0015-tr-name-uniqueness-census.md), [ADR-0016](0016-free-text-entity-resolution.md); `scripts/cacbg/load.mjs`, `scripts/cacbg/classify.mjs`

## Context

The publish-tier gate (ADR-0009) decides identity certainty from the **name**: a distinctive single-winner
name publishes (`B_distinctive`); a generic name is held (`C_hold`) until the Trade-Register name census
(ADR-0015) proves it nationally unique. A seat match rescues a generic name deterministically (`A_seat`).

The tier was assigned purely from name-distinctiveness + seat, **regardless of match method** — so a
`declared_eik` match (ADR-0016: the official wrote the ЕИК inline **and** the winner's фирма also appears
in the text, a name+ЕИК double-lock) whose name happened to be generic was filed `C_hold` and held. That
is a category error. The ЕИК is the national unique identifier (ЗТРРЮЛНЦ) — it resolves the company
deterministically **on its own**, independent of how generic the name is or how many namesakes exist. A
held `declared_eik` link was the system's *most certain* match being withheld on a criterion (name
genericness) that its certainty does not depend on, while lower-certainty name-only matches published.

Measured over the real backfill: 8 links ever resolve via inline ЕИК; 7 were held. Promoting them moves
**3 links / 2 companies (АТЕЛИЕ ДУО ЕООД, Файнанс Консулт ЕООД), ≈€33k** onto the public surface (the other
4 are АД/ЕАД management/board roles that never surface anyway — ADR-0022). Small in headline terms, but a
correctness fix, not a volume one.

## Decision

A `declared_eik` match is assigned a new tier **`A_eik`** in `load.mjs`, bypassing the name/seat gate: the
declarant-provided ЕИК is the identity, so the link publishes on its own basis (subject to the usual
interest-class / materiality gates — ex-officio/management still resolve to `internal`). `A_eik` is at
least as certain as `A_seat`; where both apply (declarant wrote the ЕИК *and* a confirming seat), the ЕИК
is the primary resolver, so the link is labelled `A_eik`.

Consequently, `declared_eik` links are **exempt from the TR census** (ADR-0015): the census exists to prove
name-uniqueness, which the ЕИК already renders moot. The census continues to gate only name-resolved
`C_hold` links. Name-only methods (`exact_name_key`, `extracted_name`) are unchanged — they still ride the
distinctiveness/seat gate, because their certainty *is* the name.

This is libel-safe even behind a winner-colliding name: the ЕИК picks the exact winner, so the attribution
("official owns the company with this ЕИК, which won €X") is true. The displayed name is that company's
registered name; a namesake at a different ЕИК is never attributed anything. A colliding name already
appears on the surface via `A_seat` (ADR-0016), so `A_eik` introduces no new display posture.

## Consequences

- **Positive:** the system's strongest matches are no longer over-held; the tier now reflects the true
  basis of certainty (ЕИК vs seat vs name). Deterministic, needs no external data, no TR wait.
- **Neutral:** tier column now takes four values (`A_eik | A_seat | B_distinctive | C_hold`). `load.mjs`
  (`C_hold` → held) and `tr-census.mjs` (`WHERE publish_tier='C_hold'`) treat `A_eik` correctly without
  change (publishable, census-exempt).
- **Audit gate updated (libel-critical):** `audit.mjs`'s invariant A ("a published name key resolves to
  EXACTLY ONE valid ЕИК") is legitimately violated by an `A_eik` link behind a winner-colliding name, so for
  `A_eik` it is replaced by two checks of equal strength: `A_eik_not_winner` (the published ЕИК must be a
  valid winner bearing that name-key, not a stray ЕИК) and `A_eik_no_provenance` (a declaration by the
  person must independently carry that ЕИК **and** the winner фирма — the double-lock re-proven, so a loader
  regression can't smuggle a fabricated attach past the gate). Name-based links keep the single-ЕИК rule
  unchanged. Verified: 133 published links audit clean, 0 hard findings.
- **Bounded scope:** does **not** address the ~395 held name-only links (332 officials, ≈€408M) that carry
  no inline ЕИК — those remain `C_hold`, blocked on the TR census (ADR-0015). CACBG cannot be their second
  leg; the declarations carry no ЕИК field, only free text where ~1% of officials happen to write one.
- **Follow-up:** if a `declared_eik`-published link ever carries a name shared by >1 *winner* (none in the
  current backfill), the surface should show the ЕИК/town to disambiguate for the reader.
