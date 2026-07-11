# ADR-0019: Separate private financial interest from ex-officio public-board roles

- Status: Accepted (display superseded by [ADR-0022](0022-public-surface-private-ownership-only.md) — the ex-officio *list* is no longer shown; the classification stands and now gates the public surface to private ownership only)
- Date: 2026-07-06
- Deciders: lb, Claude
- Related: [ADR-0014](0014-match-output-layers-and-interpretation.md), [ADR-0007](0007-scope-and-certainty-bar.md); `scripts/cacbg/load.mjs`, `packages/db/migrations/0002_related_persons_foundation.sql`

## Context

On the complete corpus (35 folders, 285 published links), the raw headline "public contract value flowing
to companies officials declared an interest in" is **€2.30 B** — but that number is dominated by officials
who were **appointed to manage state-owned companies**. The top links are ИО „Информационно обслужване" АД
(€302.9 M), „Български пощи" ЕАД (€122.6 M), and „Фонд мениджър на финансови инструменти в България" ЕАД
(€108.9 M), each declared by multiple officials sitting on the company's board *ex officio*. Presenting that
as "conflict of interest" would defame civil servants performing their statutory duty — precisely the harm
the certainty bar (ADR-0007) exists to prevent. A management seat on a public body is categorically different
from a private person owning shares in a company that wins public money.

The underlying link (official X declared an interest in company Y with ЕИК Z) is certain in every case; what
was missing is an **interpretation layer** that says *what kind* of interest it is.

## Decision

Persist a deterministic `interest_class` on every `interest_link`, computed once in `load.mjs`:

- **`private_ownership`** — `relation` is `owns` or `owns+manages` (the official declared a *stake*). This is
  the genuine conflict signal and the **headline** category. You are not appointed to own shares.
- **`ex_officio_board`** — `relation` is `manages` **and ≥2 distinct officials declared the same company**.
  A rotating / multi-member board is the deterministic fingerprint of a public body: a private interest has
  one owner-declarant; a state company's board is declared by many. Excluded from the conflict headline.
- **`management_role`** — `relation` is `manages` with a single declarant. Ambiguous (a private owner-manager
  *or* a small board); shown as its own category, never folded into the private-ownership headline.

The load summary now reports `published_private_ownership_{links,value_eur}` as the headline figure
(**207 links / €330.5 M**) alongside the full `published_by_interest_class` breakdown, so the €2.3 B is never
presented as conflict. The classification is a presentation aid — it changes neither the certainty of a link
nor its publish tier (ADR-0009); a link's `interest_class` and its `publish_tier` are orthogonal.

## Consequences

- The published surface leads with private ownership; ex-officio board roles are a distinct, labelled
  category (user decision, 2026-07-06). The multi-declarant tell is deterministic and reproducible, not a
  manual state-company allowlist (the curated `ownership_kind` list covered only 46 firms and missed
  ИО/БЕХ/ФМФИБ entirely).
- `management_role` is deliberately *not* auto-labelled ex-officio: a single-declarant management entry could
  be a private manager (e.g. an owner who declared only the control role), so it stays in its own bucket
  pending ownership data (the TR census, ADR-0015) rather than being guessed either way.
- Edge case: two officials who genuinely co-own one private company surface as `owns`/`owns+manages` →
  `private_ownership`, correctly — the ex-officio class is gated on `manages`, so co-ownership is never
  misclassified as a board role.
- Locked by `load.test.mjs` (two managers of one company → `ex_officio_board`; a sole manager →
  `management_role`; an owner → `private_ownership`).
