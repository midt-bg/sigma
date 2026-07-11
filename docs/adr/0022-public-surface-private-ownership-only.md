# ADR-0022: Public conflict surface shows ONLY declared private ownership

- Status: Accepted — amended by [ADR-0023](0023-anonymized-family-ownership-surface.md)
- Date: 2026-07-06
- Deciders: lb, Claude
- Amended by: [ADR-0023](0023-anonymized-family-ownership-surface.md) — the public surface also shows **anonymized family** ownership (the „private ownership only" scope below now means private + anonymized close-relative stakes, never ex-officio/management)
- Supersedes (display only): [ADR-0019](0019-private-interest-vs-ex-officio-classification.md)
- Related: [ADR-0007](0007-scope-and-certainty-bar.md), [ADR-0020](0020-conflict-explorer-surface-posture.md); `packages/db/src/queries/related-persons.ts`, `apps/web/app/routes/conflict*.tsx`

## Context

ADR-0019 classified each link as `private_ownership` / `ex_officio_board` / `management_role` and the first UI
(B5) showed private ownership as the headline **plus a second, separately-labelled list of ex-officio board
roles**. On review that second list was judged **noise that borders on defamation**: placing an appointed
office-holder next to „управлява дружество X, спечелило €Y" implies impropriety where there is none — the person
is performing a statutory duty. A separate label („служебен борд") was not sufficient mitigation; the safe course
is not to surface it at all. The certainty bar (ADR-0007) is about *what is true*; this is about *what is fair to
publish* even when true.

Two adjacent defects were fixed in the same pass: the UI used **„официал(и)"**, which is not the Bulgarian noun
for a public office-holder (it is a sports term / an Anglicism — verified against usage: „официален" is only the
adjective); and UI copy referenced internal ADR numbers.

## Decision

1. **The public surface shows ONLY `interest_class = 'private_ownership'`** — links where the person declared an
   actual ownership stake. `ex_officio_board` and `management_role` links are **never surfaced** on any public
   route (leaderboard, office-holder page, winner page). The query layer filters them out; there is no second
   list. Management/board roles without a declared stake are simply not published.
2. The `interest_class` classification (ADR-0019) is **retained in the data**, but its job flips from *"drive a
   separate display list"* to *"gate the public surface"* — it is how the query excludes non-ownership. The
   pipeline still computes it (it also feeds ex-officio reasoning and could inform internal analysis).
3. **Terminology:** „длъжностно лице / длъжностни лица" everywhere, never „официал".
4. **No internal identifiers in UI copy** — ADR numbers and the like live in code comments and docs, never in
   rendered text.

## Consequences

- The raw €2.3 B / private €330.5 M distinction (ADR-0019) is moot for the UI: only the €330.5 M private set is
  ever shown. The methodology page states plainly that management/board roles without a declared stake are not
  published.
- DTOs simplified: `ConflictLink` drops `interestClass`; `getConflictLeaderboard` returns `ConflictLink[]` (one
  list); `OfficialConflicts` is `{ official, links }`; `InterestClass`/`ConflictLeaderboard` types removed.
- ADR-0019's *display* decision (separate ex-officio list) is superseded; its *classification* decision stands.
  ADR-0020/0021 still hold (interest_links-only read model, noindex-until-go-live, temporal dating, divestment
  expiry) — they are orthogonal to which interest classes are shown.
- Locked by tests: the query layer surfaces only `private_ownership` (ex-officio rows excluded even on the
  winner's own page — `related-persons-sql.test.ts`), and the Playwright suite asserts the single list, the
  absence of „официал"/the second list, and the dated rows.
