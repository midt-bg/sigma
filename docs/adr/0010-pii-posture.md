# ADR-0010: PII posture

- Status: Accepted
- Date: 2026-07-05
- Deciders: lb, Claude
- Related: spec §8; КЗЛД guidance; GDPR Art. 6(1)(c)/(f), Art. 85

## Context

Declarations sit next to sensitive personal data: the declarant's ЕГН, address, passport, phone, and —
critically — **third-party** data (spouse/children in asset declarations; declared "related persons"
and conflict-contract counterparties in interests declarations). КЗЛД: an official's own declared facts
are publishable with a source link, but third-party data is publishable only where the law explicitly
provides; the declarant's consent does not extend to third persons.

## Decision

1. **Officials' own declared facts** (their name, position, institution, the companies they hold/manage)
   — lawful to republish with provenance. This is the product.
2. **EGN** — already stripped upstream in the register; the parser additionally asserts it empty and
   surfaces a boolean flag if ever present, never storing the value. (Phase-0: 0 EGN values seen.)
3. **Addresses / passport / phone** — never extracted by the parser.
4. **Family holdings** (asset decl, holder ≠ declarant) — counted, but the family member's name is never
   retained.
5. **Declared related persons & conflict-contract counterparties** (interests decl tables 21/22) — third
   parties. Extracted into a **separate `related.jsonl`, INTERNAL-only**, never merged into the published
   holdings and never published as-is. Feeds only the internal graph, masked on every output format.
6. **Spike storage.** Raw declaration XML is cached only under `scratch/` (git-ignored, enforced by a
   refuse-to-run guard) and deleted post-spike. The structured staging persists only public fields.

## Consequences

- The published dataset contains only officials' own declared facts + public company/ЕИК data.
- Any future surfacing of family/related-person data is hard-gated on the natural-person masking work
  (incl. the `.data` twin) and stays out of v1.
- The parser is the single PII boundary: tests assert address/family-name/EGN never leak into output.
