# ADR-0031: Link suppressions are a version-controlled, HMAC-fingerprinted list — not a served table

- Status: Accepted
- Date: 2026-07-29
- Deciders: Todor (maintainer), lb, Claude
- Related: [ADR-0007](0007-scope-and-certainty-bar.md), [ADR-0010](0010-pii-posture.md), [ADR-0030](0030-family-ownership-withheld-nameless-aggregate.md); `scripts/cacbg/suppressions.mjs`, `scripts/cacbg/link-suppressions.jsonl`, `scripts/cacbg/load.mjs`, `scripts/ship-related-persons.mjs`, `docs/runbooks/related-persons-suppression.md`

## Context

A contested/corrected свързани-лица link must stay removed across every refresh (ADR-0007's correction
path). The first implementation was a `link_suppressions` DB table: rows were curated by direct `INSERT` on
the work DB, preserved across a rebuild by load.mjs, and **shipped to the served D1** with the rest of the
domain. Two defects surfaced on review:

1. **The suppression signal shipped to prod.** Each row stored the raw `link_key` (`pid|eik`) + a `reason`
   (e.g. „family takedown", „contested") + `suppressed_by`. That is a record of *which named official
   contested their link to which company, and why* — exactly the defamation-sensitive fact the takedown
   exists to bury — sitting in the public-facing D1. Suppressing the link while shipping the suppression row
   leaks the same information one layer over.

2. **A fresh CI runner silently loses every suppression.** The data-ship runs on a clean runner that rebuilds
   the work DB from scratch. A suppression that lived only in a mutable DB table (never in git) is simply
   absent there, so the taken-down link **reappears** on the next ship. A libel takedown that survives only
   until the next CI run is not a takedown.

## Decision

**Suppressions live in a version-controlled list, keyed on a non-reversible fingerprint, applied at load —
never a served table.**

- `scripts/cacbg/link-suppressions.jsonl` (in git): one JSON object per line —
  `{ fp, reason, signal_ref, suppressed_at }`. Being in git makes a takedown reproducible on any runner,
  auditable in history, and reviewable.
- `fp` is `HMAC-SHA256(SUPPRESSION_SALT, link_key)`, **not** the raw `pid|eik`. The salt is a CI secret, so
  the git list never records who was taken down for which company — a repo reader (including fork/external
  contributors) cannot reverse a fingerprint to a person. Same reasoning as ADR-0030/C-37/20: a
  re-identifiable record IS the personal data.
- `scripts/cacbg/load.mjs` reads the list, computes each candidate link's fingerprint with the salt, and
  marks matches `status='suppressed'`. The served D1 stores only that status — never the salt, the list, or a
  `link_suppressions` table (dropped from the migration, the ship `TABLES`/`WIPE_ORDER`, and the loader).
- **Fail-closed:** a non-empty list with no `SUPPRESSION_SALT` aborts the build. Fingerprinting without the
  salt would match nothing and silently un-suppress every taken-down link; refusing to build is the safe
  failure. An empty/absent list needs no salt, so the common path stays friction-free.

## Consequences

- The prod D1 no longer carries the „who was taken down" signal — the leak is closed by construction.
- A takedown is now a reviewed, reproducible git change that any runner applies identically; it cannot be
  lost by a fresh-runner rebuild.
- Adding a suppression requires the salt (to compute the fingerprint) and a redeploy to take effect on the
  next ship. For an urgent case that cannot wait for a ship, the runbook documents a direct
  `UPDATE interest_links SET status='suppressed'` on the served D1 as the stopgap, with the git entry filed
  immediately after so the state is not lost on the next rebuild. See
  [`docs/runbooks/related-persons-suppression.md`](../runbooks/related-persons-suppression.md).
- The salt must be present in the CI ship environment whenever the list is non-empty; a rotated salt
  invalidates existing fingerprints and requires re-fingerprinting the list (runbook covers this).
