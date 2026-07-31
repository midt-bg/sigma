# ADR-0030: Close-relative (family) ownership is withheld from the named surface — nameless aggregate only

- Status: Superseded by [ADR-0032](0032-family-ownership-published-under-public-interest.md)
- Date: 2026-07-29
- Deciders: Todor (maintainer), lb, Claude
- Supersedes: [ADR-0023](0023-anonymized-family-ownership-surface.md)
- Superseded by: [ADR-0032](0032-family-ownership-published-under-public-interest.md)
- Related: [ADR-0007](0007-scope-and-certainty-bar.md), [ADR-0010](0010-pii-posture.md), [ADR-0019](0019-private-interest-vs-ex-officio-classification.md), [ADR-0022](0022-public-surface-private-ownership-only.md); `scripts/cacbg/load.mjs`, `packages/db/src/queries/related-persons.ts`, `apps/web/app/routes/conflict*.tsx`

> **Superseded (2026-07-31).** [ADR-0032](0032-family-ownership-published-under-public-interest.md) reverses this
> decision: family-ownership links are now **published** on the named surface, identically to self stakes, on a
> public-interest basis — the relative still never named, the relationship never asserted. Two of the three
> premises below were found wrong on measurement (value/harm do not coincide; hiding the identifier is defeated
> by our own `contract_number` links). Retained for the historical record.

## Context

ADR-0023 put a close relative's declared stake on the public surface in **anonymized** form: the office-holder
and the winning company were named, the relative shown only as „свързано лице". On an independent end-to-end
review of the full corpus (8 746 declarations resolved against the 193 024-contract served base), the
maintainer found the anonymization does not hold in practice, and that the family attribution itself is weaker
than the surface implies:

1. **The heuristic asserts more than it knows (ADR-0007).** Family attribution rests entirely on one text
   comparison in the declaration's holder-name cell: a holder name that does not match the declarant is read as
   „свързано лице". We know neither that the person is a relative nor what the relationship is. In the reviewed
   corpus this is 1 449 of 6 172 stakes (23%); in ~1% of checked declarations the "mismatch" is the declarant's
   **own** name written more briefly — a phantom relative (the same failure the `nameKey` thread records).

2. **Anonymity is defeated by the rest of the card.** The card names the office-holder, the company, the exact
   ЕИК and links to the Търговски регистър. For a sole-owner company (ЕООД) the registry names the owner in one
   click. Under GDPR — data re-identifiable by reasonably available means is personal data (cf. **C-37/20**) — we
   would be promising anonymity we do not deliver.

3. **A materiality threshold does not help.** Excluding sole-proprietor companies removes exactly the strongest
   cases — ADR-0023's own worked example is an ЕООД. Value and harm coincide in the same rows.

4. **Consistency with a prior call.** By the same reasoning (a register public in law, but general re-publication
   disproportionate — C-37/20) the project already declined to surface the beneficial-owners registry. A named
   family-ownership surface is functionally the same disclosure.

5. **The legal precondition is unmet.** ADR-0023 itself keeps the public route `noindex` until legal sign-off on
   going public. That sign-off does not exist.

## Decision

**Family (close-relative) ownership links are collected and audited but never surfaced by name in v1.** They
are treated like `ex_officio_board` / `management_role`: computed, stored, gate-checked — but withheld from every
named surface.

- `scripts/cacbg/load.mjs`: `family_ownership` drops from the `surfaces` predicate, so a family link that passed
  every gate is stored with `status='internal'` (not `published`). Held / withdrawn / suppressed still take
  precedence.
- `packages/db/src/queries/related-persons.ts`: every read query filters `interest_class = 'private_ownership'`
  — an **independent** gate from status. `family_ownership` never reaches the leaderboard, official page, company
  page, per-link contracts route, or the search projection. The former family-source-NULL `CASE` and the
  redundant-family collapse are moot and removed.
- Family is reported **only as a nameless aggregate** (`getWithheldFamilyAggregate`): a scalar count of officials
  and total winner value — never a person/company row, so nothing re-identifiable reaches the loader payload (the
  public `.data` twin). It excludes family links redundant with the official's own published stake in the same
  winner (already counted, already on the board).
- UI copy is inverted accordingly: the family cards, the „в т.ч. N чрез свързано лице" counter, the three route
  ledes, the `conflicts.ts` label and methodology §2 no longer promise a named family surface — the methodology
  now explains what we deliberately do **not** show, and why. For a transparency tool this is a feature.

The raw traces remain available to journalists on request, under their editorial responsibility.

## Consequences

- The public signal survives ("N office-holders declared a close relative's stake in companies that won €X")
  without naming any private individual.
- No named surface can be turned into a re-identification vector for a relative; the whole class of de-anon bugs
  (source_url leak, existence-oracle drill-down, ТР cross-reference) is closed by construction, not by predicate.
- The `nameKey` phantom-relative defect (a self stake misread as a relative's) degrades from a false public
  statement to an unshown link — a follow-up, no longer a libel risk.

## Reconsider for v2 when all three hold

1. a **confirmed** relationship, not one inferred from a name mismatch;
2. a real signal for a **terminated** stake (a sold stake must not read as current);
3. **legal sign-off** on the sole-proprietor-company re-identification question.
