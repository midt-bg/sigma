# ADR-0014: Match output layers and interpretation caveats

- Status: Accepted
- Date: 2026-07-05
- Deciders: lb, Claude
- Related: spec §5; `scripts/cacbg/analyze.mjs`, `classify.mjs`; builds on [ADR-0009](0009-name-uniqueness-guard-and-publish-tiers.md), [ADR-0013](0013-two-declaration-templates.md)

## Context

The deterministic match (official ↔ winner ЕИК) is a raw overlap. On its own it is neither publishable
nor the actual conflict story. Phase 0 measured what extra layers are available deterministically, and
what must be a disclosed heuristic, to turn the overlap into a defensible lead list.

## Decision

`analyze.mjs` aggregates each match per `(official, ЕИК)` and annotates it with layered, separately-
labelled signals — deterministic unless marked heuristic:

1. **Interest kind — ownership vs control.** `owns` (shares/participation) is separated from
   `manages` (управител / board / control body, from the interests declaration). Management is reported
   as its own headline because control without ownership is often the more serious conflict.
2. **Publish tier** (ADR-0009): A seat-confirmed / B distinctive-name / C held-for-census. Only A+B are
   publishable. (Empirically tier A rarely fires — winner `settlement` is ~28% populated — so tier B
   carries most publishable matches; disclosed.)
3. **Temporal validity.** Asset declarations are annual snapshots; a match is `contemporaneous` only when
   a contract year falls within the declared-holding year span. `after_last_decl` / `before_first_decl`
   are *not* claimed as current conflicts.
4. **Own-institution overlap** — the strongest lead. Authority names are sometimes `;`-joined framework
   blobs, so each is split into components. Verdict, strongest-wins: `exact` (deterministic name equality)
   > `name_contains` (disclosed heuristic — a ≥12-char institution name that is a normalized substring of
   an authority component, e.g. „Горна Малина" ⊂ „ОБЩИНА ГОРНА МАЛИНА") > `locality` (disclosed same-town
   heuristic) > `none`. Only `exact` is presented as proof; the rest are labelled candidates.
5. **Contract facts (deterministic quantification).** Each link carries the linked winner's
   `contract_count`, `contract_value_eur` (SUM of `amount_eur`, the safe-to-sum canonical value;
   value_suspect excluded), and contract-year span; a per-authority breakdown (`interest_link_authorities`)
   records which public bodies bought, how much, and which is the official's own. This turns a bare link
   into "official manages a company that won €X across N contracts, €Y of it from their own institution."

**Interpretation caveat (must ride with every published lead):** a match is a *declared, factual* link,
NOT a finding of wrongdoing. Some are legitimate **ex-officio** roles (e.g. a central-bank official on
the board of a bank-owned entity that contracts with the bank). The data is accurate; the conflict
inference requires human context. We publish leads with full provenance and a contest/correction path,
never verdicts.

## Consequences

- Headline is reported in honest layers: raw overlap → publishable (tier A/B) → contemporaneous →
  own-institution (deterministic vs heuristic) → managing-vs-owning. No single inflated number.
- `analyze.mjs` supersedes the Phase-0 `match.mjs` (removed); the libel gate stays wired as an executable
  exit-code check.
- Ranking surfaces the strongest leads first (manages + own-institution + contemporaneous + publishable).
