# ADR-0023: Anonymized close-relative (family) ownership surface

- Status: Accepted
- Date: 2026-07-07
- Deciders: lb, Claude
- Related: [ADR-0007](0007-scope-and-certainty-bar.md), [ADR-0010](0010-pii-posture.md), [ADR-0019](0019-private-interest-vs-ex-officio-classification.md), [ADR-0022](0022-public-surface-private-ownership-only.md); `scripts/cacbg/parse.mjs`, `scripts/cacbg/load.mjs`, `packages/db/src/queries/related-persons.ts`, `apps/web/app/routes/conflict*.tsx`

## Context

The CACBG asset declaration's company-holdings tables carry a **holder column** („Име: собствено, бащино и
фамилно") that identifies whether a declared stake is the declarant's own or a **close relative's** (the
declaration covers the declarant, spouse/cohabitant and minor children jointly). The Phase-1 extractor
(`parseAssets`) detected relative-held stakes and then **discarded them** (`familyHoldingCount++`).

Measured against the source corpus (222,352 asset declarations, deduped by ControlHash, 2026-07-07): of 26,209
closely-held (ООД/ЕООД) stakes, **12,876 are a close relative's** — roughly half the map. Matched to procurement
winners with the production normalizer + single-ЕИК guard, family stakes yield **382 raw / 110 published**
winner links (€66M), including officials who declared a relative owns 100 % of a company that then won millions
(e.g. `Еврострой РН ЕООД`, €12.28M). This is the highest-signal, previously-invisible part of the corruption map.

ADR-0010 kept third-party (related-person) data **internal-only** — it is PII. But the *link* here does not
require the relative's identity: the match is company-name → ЕИК, and the fact that a relative holds the stake
comes from the **official's own lawful public declaration** (ЗСП/ЗПКОНПИ publication obligation). The tension is
between surfacing a real conflict signal and protecting a private individual (the relative).

## Decision

Surface family-ownership links on the **public** свързани-лица routes, **anonymized**:

- **Shown:** the official (named — a public office-holder, from their own public declaration), the company
  (named — a public procurement winner), the contract facts (public), and that the holder is a „свързано лице".
- **Never stored or transmitted:** the relative's name or relationship. The PII rail holds *at the parse
  boundary* — `parse.mjs` records only `holderRelation: 'self' | 'related'`, never the holder name; the
  relative's identity never enters staging, the DB, or the DTO.
- **Materiality gate (deterministic):** only closely-held forms (ООД/ЕООД/ЕТ/КД/СД…) reach the surface; listed
  АД/ЕАД/АДСИЦ securities and management-only roles never become an ownership link (supersedes the „11 listed
  shares → €88M" defamation trap; ADR-0022). Table-type + legal-form, not a post-hoc heuristic.
- **Class + relation:** `interest_class='family_ownership'`, `relation='related'`. Same publish tiers (A_seat /
  B_distinctive / C_hold), same E11 divestment expiry, same certainty-1.0 libel gate as self ownership.
- **Ranking:** NEXUS-first (own-institution → contemporaneous → value), never company revenue — so a €250k stake
  in a company that sold to the official's OWN institution outranks a €50M stake with no institutional tie.

The public route stays `noindex` until legal sign-off (prod is live/public); the exact Bulgarian framing was
reviewed with lb before the surface was made reachable.

## Consequences

- Half the conflict map — family-held winner stakes — becomes visible for the first time, without naming any
  private individual. The claim asserted is factual and public: „в декларацията на X е посочен дял на свързано
  лице в Y (изпълнител)".
- The relative-name PII rail is preserved and now *structurally* enforced (the name is dropped at parse, not
  merely filtered downstream). `related_persons_internal` remains internal-only and untouched by this surface.
- Consistent with ADR-0007 (certainty 1.0) and ADR-0022 (fair-to-publish ≠ merely-true): a family link is only
  as strong as its publish tier and is dated, divestment-expired, and nexus-ranked like any other.
