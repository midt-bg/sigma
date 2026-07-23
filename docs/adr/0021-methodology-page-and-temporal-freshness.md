# ADR-0021: Public methodology/corrections page (E10) + temporal freshness & divestment expiry (E11)

- Status: Accepted
- Date: 2026-07-06
- Deciders: lb, Claude
- Related: [ADR-0007](0007-scope-and-certainty-bar.md), [ADR-0019](0019-private-interest-vs-ex-officio-classification.md), [ADR-0020](0020-conflict-explorer-surface-posture.md); spec §5/§8/§9; `scripts/cacbg/load.mjs`, `apps/web/app/routes/conflict.methodology.tsx`, `packages/db/src/queries/related-persons.ts`

## Context

The conflict-explorer surface (B5, ADR-0020) is built but two spec gates block public exposure. **§9** requires a
plain-language methodology page as part of the libel defence — a reader must see exactly how a link is made and be
able to re-derive it. **§8/§6.7 (E11)** requires that withdrawn/amended declarations and officials leaving office
expire stale `interest_link`s, else a link asserts a *current* conflict that has ended — a live accuracy defect.
A declaration is a point-in-time snapshot (§5): a stake sold mid-year still shows in the prior year's filing.

## Decision

**E10 — `/conflicts/methodology` (indexable, names no individual).** A static page covering the §9-mandated
sections verbatim: sources + legal basis (ЗПКОНПИ/КПКОНПИ public declarations; procurement register), what is and
isn't shown (own declared holdings only; family internal; ЕГН/addresses never), the matching rule word-for-word
(exact full-name incl. legal form → national uniqueness → single-ЕИК guard; ambiguous excluded/human-confirmed),
certainty & framing („модел за проверка, не обвинение"; a floor, not hidden ownership), temporal meaning,
known gaps, corrections & appeal, and refresh/validity. Unlike the individual-naming routes (noindex, ADR-0020),
this page **is** indexed — it is the credibility anchor and names nobody. All conflict routes' disclosure links
now point at its `#contest` anchor.

**Corrections workflow — designed, not just named.** Contest via the impressum contact with (page URL, ЕИК +
name, grounds); review target **7 working days**; a valid contest suppresses the link **immediately** and it
**survives every re-import** (`link_suppressions` is loaded first in `load.mjs` and shipped first — ADR-0009).
The 7-day target is a proposed default to confirm operationally.

**E11 — two mechanisms:**

1. **Temporal dating (surface, effective now).** Every link carries `first/last_declared_year` on the DTO and the
   UI dates each row („деклариран 2019–2023 г."). No link is ever presented as *current* — the claim is "declared
   as of YEAR", which is a dated historical fact and cannot go stale. This is the always-correct core of E11.

2. **Divestment expiry (pipeline gate).** In `load.mjs`, an **ownership** link (`owns`/`owns+manages`) whose
   company is absent from the person's **latest ownership filing** (a later `shares`/`participation` declaration
   year exists without it) is marked `status='withdrawn'` — excluded from the published surface, like held/
   suppressed. Scoped to ownership only: management/board filing cadence is unverified (spec §6), so those links
   are dated but not divestment-expired. Direction of error is safe: a false hold is a recall miss (never a false
   accusation), and taking the later declaration at face value is the defensible reading.

## Consequences

- E10 and E11 are the two §E gates that stood between B5 and public exposure; both are now built. Flipping the
  individual pages from `noindex` to indexable remains a **deliberate go-live decision** (legal sign-off + the
  user's call), not an automatic consequence of this ADR — prod is public.
- `withdrawn` is a new `interest_links.status` value (no CHECK constraint to change); the query layer already
  filters `status='published'`, so withdrawn rows are invisible to every read path with no query change.
- The divestment gate re-runs with the next full pipeline build (`related-persons-data.yml`); the current shipped
  corpus keeps its counts until then. Temporal dating works against the current data immediately (the columns
  already exist on shipped `interest_links`).
- **Documented blind spots** (surfaced on the methodology page, not hidden): a divest-to-**zero** filing produces
  no holdings row, so full divestment isn't auto-caught — the row's dating is the residual mitigation; and
  "official left office" is not yet an expiry signal (no reliable tenure source — the ЕРИК/office leg, spec §3.2,
  is parked). Both are recall gaps, not false-accusation risks.
- Locked by tests: `load.test.mjs` (a 2019 stake superseded by a 2022 filing → `withdrawn`; the current stake →
  `published`), and the query layer (a `withdrawn` row is excluded from the company view, declared span carries
  through) in `related-persons-sql.test.ts` + `related-persons.test.ts`.
