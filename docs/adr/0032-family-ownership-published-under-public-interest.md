# ADR-0032: Close-relative (family) ownership is published on the named surface, on a public-interest basis — never the relative's name

- Status: Accepted
- Date: 2026-07-31
- Deciders: Todor (maintainer), Claude
- Supersedes: [ADR-0030](0030-family-ownership-withheld-nameless-aggregate.md)
- Related: [ADR-0007](0007-scope-and-certainty-bar.md), [ADR-0010](0010-pii-posture.md), [ADR-0022](0022-public-surface-private-ownership-only.md), [ADR-0023](0023-anonymized-family-ownership-surface.md), [ADR-0031](0031-suppressions-version-controlled-fingerprinted.md); `scripts/cacbg/parse.mjs`, `scripts/cacbg/load.mjs`, `packages/db/src/queries/related-persons.ts`, `apps/web/app/routes/conflict*.tsx`

## Context

ADR-0030 withdrew family-ownership links from the named surface. Its reasoning was that the surface promised
anonymity it could not deliver, and that a materiality threshold would not help because value and harm coincide
in the same rows. Two of the three premises turned out to be wrong on measurement, and the framing itself was
wrong. This ADR reverses the outcome and replaces the justification.

**1. The value/harm coincidence does not exist.** ADR-0030 asserted that excluding sole-owner companies removes
the strongest cases. Measured on the resolved corpus, the opposite holds: family stakes in multi-member
companies carry €3.65M, €2.86M, €419k, €383k …, while every sole-owner (ЕООД) case is small — €127k, €97k, €51k,
€26k. The claim came from ADR-0023's worked example, not from the distribution.

**2. Hiding identifiers does not work, because our own product defeats it.** Any intermediate design — generic
company label, banded amounts, withheld declaration link — is undone within our own pages:

- The per-contract list returns `contract_number` (`LINK_CONTRACTS_SQL`). A contract number is a public key: it
  resolves to the winner in ЕОП and on our own contract page. Showing the contracts names the company.
- Amounts do **not** identify: `money()` already rounds to two significant figures, and each rendered bucket
  holds dozens of companies on the served base (127 хил. → 31, 97 хил. → 39, 51 хил. → 121, 26 хил. → 122).
  The identifying power sits in the combination with the legal form and the contract count, not in the sum.

A measure that looks protective but is defeated in one click is worse than no measure: it adds a false promise
to the underlying disclosure, and we answer for the promise as well.

**3. The real protection is elsewhere, and it holds.** What **C-184/20** actually forbade was publishing
*name-specific data* about a spouse/cohabitee/close relative, and it named the less restrictive alternative:
a generic designation plus the relevant interest. We already do exactly that — the relative's name never enters
staging, the database or the DTO (`parse.mjs` records only `holderRelation`), and we assert no relationship
type. Not naming the relationship also keeps us clear of the Art. 9 inference that drove much of that judgment.

**4. The source publishes more than we do — verified, not assumed.** Sampling the machine-readable register
directly: of 400 declarations carrying a holder column, 196 contain a full three-part name of the holder; ЕГН is
empty in 0 of 300. The state has already drawn the redaction line, and it drew it at the national ID, not at
names. Our surface therefore publishes strictly less than its lawful public source.

**5. There is a domestic basis for the re-publication.** ЗДОИ чл. 41и, ал. 4 — the presence of personal data
cannot ground a refusal of re-use where the information forms part of a publicly accessible register; § 1, т. 6
ДР ЗДОИ defines the overriding public interest as *revealing corruption and increasing transparency*; the
declaration law itself orders publication of **all** declaration data in real time, in an open machine-readable
format. КЗЛД has applied чл. 41и, ал. 4 to a civic platform aggregating registry data. ECtHR *Wypych v Poland*
(2428/05) upheld online publication of declarations **including marital property**, precisely because it
discourages concealing assets in a spouse's name — the exact signal this surface carries.

**6. The distinguishing factor is selection, not volume.** ECtHR *Satakunnan Markkinapörssi* (931/13, GC) held
that public accessibility does not license mass dissemination of raw data "without any analytical input". Our
publication is the intersection of a declared household stake with a company that actually won public
contracts — a targeted, reasoned subset, not a register copy.

## Decision

1. **Family-ownership links are published on the named surface, identically to self-ownership links** — office
   holder named, company named with ЕИК, contract facts, per-contract list, declaration link. No special case
   for sole-owner (ЕООД/ЕТ/ЕАД) companies. The only difference is the relation label: „дялово участие" for a self
   stake, „деклариран дял на свързано лице" for a family one (`RELATION_LABEL` in `apps/web/app/lib/conflicts.ts`). **One narrowing:** where the same official already
   has a published *self* stake in the same winner, the *family* row is redundant and collapses away (see the
   implementation note) — the self row already names the official on that company, so the family row would add
   no signal, only a de-anonymization path.

2. **The relative is never named and the relationship is never asserted.** `parse.mjs` keeps recording only
   `holderRelation: 'self' | 'related' | 'unknown'`; no name reaches staging, the DB or any output. We do not
   say „съпруг", „дете" or any other relation — we do not know it, and claiming it would both exceed the data
   and invite the Art. 9 problem.

3. **Scope is limited to persons whose asset declaration is public at source.** § 2, ал. 3 ПЗР makes only the
   *interests* part public for administrative staff; the company-holdings tables sit in the asset part. For
   those persons family stakes are **not** published — publishing them would exceed the source, which is the
   load-bearing premise of this whole ADR.

4. **Publication requires a procurement nexus.** Only companies that actually won public contracts appear. A
   declared stake with no public money behind it is not published.

5. **Accuracy is a precondition, not an aspiration.** Since the claim now touches people who hold no public
   office, the following must be in place before this surface goes live:
   - three-state holder attribution (`self | related | unknown`), so a reordered or abbreviated own name cannot
     become a phantom relative;
   - divest-to-zero handling, so a filing that declares no material stake retires the link;
   - the correction path of [ADR-0031](0031-suppressions-version-controlled-fingerprinted.md), actually wired
     (list gate + `SUPPRESSION_SALT` bound in CI).

6. **`noindex` stays** on the conflict routes for now. Under C-184/20 the number of persons with access is an
   explicit proportionality factor; findable by someone researching a named official, not pushed by search
   engines to a passer-by.

7. **The balancing assessment is written down**, not left in review threads — `docs/spec/related-persons-lia.md`,
   to be sent for legal review in parallel with launch rather than as a blocker.

## Consequences

- The strongest previously-invisible part of the map returns: in the reviewed corpus, family stakes account for
  ~€8.4M against companies that won public contracts, roughly 97% of it in multi-member companies.
- We stop claiming anonymity. The methodology says plainly that the source document names the relative, that we
  neither reproduce nor store that name, and that we do not point at the relation. This is a weaker promise than
  ADR-0023 made and a true one.
- We accept a contestable element knowingly: for a sole-owner company the relative is identifiable by
  cross-referencing the Търговски регистър. The fallback if challenged is a single filter (withhold sole-owner
  family links), not a shutdown of the surface.
- Accuracy defects become launch blockers rather than follow-ups. On the evidence so far the likelier and more
  expensive failure is a wrong company match, not the publication decision itself.
- ADR-0030's nameless aggregate is removed. A count that mixes phantom relatives into a public figure is worse
  than either publishing the links or not collecting them.

## Implementation note (redundant-family collapse)

A self and a family stake can be declared in the **same** winner by the **same** official. Publishing both
would (a) double-count that company's contract money on the aggregate figures — the /conflicts headline
`conflictHeadline` and the officials search-index amount in `precompute.sql`/`refresh-slice.sql` — and (b) open
a Търговски-регистър de-anonymization path: the self row already names the official on that winner, so the
family row adds no public-interest signal, only a second, relative-shaped pointer at the same company.

Therefore, wherever a **published self stake** (`private_ownership`) exists on an `(official, ЕИК)`, the
redundant **family** row (`family_ownership`) is **dropped** — and, critically, only when that self stake is
`published`: if it is held/withdrawn/suppressed it never surfaced, so the family link is the sole public signal
and survives. The gate is `NOT_REDUNDANT_FAMILY` (`packages/db/src/queries/related-persons.ts`, applied
read-side in `LINK_SELECT` and `LINK_CONTRACTS_SQL`) and is duplicated verbatim in the officials index block of
`precompute.sql`/`refresh-slice.sql` (a drift-guard test holds those two byte-identical). The search badge in
`search.ts` deliberately does **not** apply the collapse and does not need to: `has_conflict` is a per-company
existence check, and a collapsed family row always coexists with a published self row on the same ЕИК, so the
self row alone already sets the badge. A **standalone** family stake — no published self stake on that winner —
still publishes in full. Net effect: at most **one** surfaced link per `(official, ЕИК)`, so the money cannot
double-count and the self↔family de-anonymization vector cannot arise. This narrows decision 1 for the
redundant case only — Todor's review on PR #226.
