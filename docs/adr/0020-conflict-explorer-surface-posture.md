# ADR-0020: Conflict-explorer surface — read-model boundary, noindex-until-gated, provenance on every row

- Status: Accepted
- Date: 2026-07-06
- Deciders: lb, Claude
- Related: [ADR-0007](0007-scope-and-certainty-bar.md), [ADR-0010](0010-pii-posture.md), [ADR-0019](0019-private-interest-vs-ex-officio-classification.md); `packages/db/src/queries/related-persons.ts`, `apps/web/app/routes/conflicts*.tsx`

## Context

Block 5 ships the first **public-facing** свързани-лица surface: a leaderboard (`/conflicts`), an official
page (`/conflicts/official/:id`), and a winner page (`/conflicts/company/:eik`). Prod is live, public, and
unauthenticated, so this ADR fixes the posture the routes must hold — the pipeline's certainty guarantees
(ADR-0007/0019) protect *what* is a link, not *how* it is served. Two hazards are specific to the surface:
a served route could reach past the published links into third-party/family data (ADR-0010), and a page
naming an individual, indexed by search engines, is a stronger and more permanent exposure than the same
page reachable only on-site.

## Decision

1. **Read-model boundary — `interest_links` only.** Every conflict loader calls exactly one of
   `getConflictLeaderboard` / `getOfficialConflicts` / `getCompanyConflicts`, all of which read
   `interest_links` (+ `persons`/`bidders` for display names, + a `declarations.source_url` subquery for
   provenance) and filter `status='published'`. `related_persons_internal` (family/PII) is **never** joined
   on this path. The boundary is the query layer, not the component — the route cannot widen it.

2. **`noindex` on every conflict route.** All three routes emit `<meta name="robots" content="noindex">`.
   The links are publishable under the officials' own-declaration obligation (spec §8), but search-index
   exposure waits on the corrections/appeal page and legal sign-off (delivery plan §E10). Reachable on-site
   and via the nav today; indexed only after the E-gates land. Mirrors `company.tsx`, which already
   noindexes natural-person profiles.

3. **Provenance and framing on the surface, not just in the data.** Every row links to a representative
   declaration URL (or shows „—" when none resolved — never a fabricated source). Every page carries a
   disclosure: the link is derived from the official's *own* KPKONPI declaration, exact-matched by
   nationally-unique фирма name, means *declared interest* and **not** a legal violation, and points to
   Методология → Поправки. Private ownership leads; ex-officio board roles are a separate, labelled list
   (ADR-0019), never summed into the headline.

4. **`officialSlug`, not the raw key, in URLs.** The DTO exposes `officialSlug` = base64url(`person_id`)
   (`identity.personSlug`). `person_id` is uppercase-Cyrillic-with-spaces and feeds `link_key` as
   `person_id|eik`; the slug is URL-safe and never depends on that `|` separator.

## Consequences

- No conflict route can leak family/related-person data by construction — the only way in is the three
  published-links queries. A future family surface (spec §8, gated on #173) needs its own explicitly-masked
  read model; it cannot ride these loaders.
- The feature is fully built and testable now but stays out of search results until §E10; flipping to
  indexable is a one-line `meta` change per route once the gate clears, tracked in the delivery plan.
- 404 (not an empty page) when an official/winner has no published link — a bare page under someone's name
  reads as an unfounded accusation. Enforced by `getOfficialConflicts`/`getCompanyConflicts` returning null
  and the loader throwing 404 (covered by the query layer's null-on-empty tests).
- Presentation logic (BG relation/interest-class labels, hrefs, year ranges, the headline aggregate) lives
  in `apps/web/app/lib/conflicts.ts` and is unit-tested; the JSX stays a declarative shell, matching the
  repo convention of testing extracted logic rather than rendering components.
