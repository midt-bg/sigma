# ADR-0015: TR name-uniqueness census (promoting tier-C generic-name matches)

- Status: Accepted (design; implemented as a Phase-1 pipeline step)
- Date: 2026-07-05
- Deciders: lb, Claude
- Related: [ADR-0009](0009-name-uniqueness-guard-and-publish-tiers.md); spec §5

## Context

ADR-0009 holds back "tier C" matches — a *generic* company name (e.g. „В и К" ООД) with exactly one
*winner* namesake — because the winner set alone cannot prove the name is **globally** unique in the
Trade Register. Phase 0 left 63 such matches unpublished. To promote them safely we need a global
name→ЕИК multiplicity check, from a lawful, deterministic, public source.

## Decision

Use the **Commercial Register open-data dump** published on `data.egov.bg` (provided by the State
e-Government Agency) as the census source:

- It is **public open data** and **DPA-safe** — ЕГН/ЛНЧ are hashed out; company name + ЕИК are retained.
  Using it to compute a name-frequency index is an internal uniqueness check, not third-party republication.
- Build a **`companyNameKey(name) → {distinct ЕИК}`** index over all entities (same normalizer, ADR-0008,
  so the census key space is identical to the matcher's).
- **Promotion rule (deterministic):** a tier-C match promotes to publishable iff its name-key has
  **exactly one** entity in TR **and** that ЕИК equals the matched winner ЕИК. Key count > 1 → the name
  is genuinely shared → stays held (or routes to seat/other disambiguation). No heuristic in the promotion.

## Confirmed source shape (2026-07-06, verified against the live export)

The earlier "daily full snapshots" assumption was wrong. Verified reality:
- The dataset (`data.egov.bg`, uuid `2df0c2af-…`) publishes one file **per day**, each ~12 MB JSON / 18 MB
  XML — a **daily delta** of the deeds that changed that day, *not* a full snapshot. Structure:
  `Message[].Body[].Deeds[].Deed[]`, each deed carrying `$: { CompanyName, LegalForm, UIC, DeedStatus }`.
- `CompanyName` is **bare**; `LegalForm` is a **code** (`EOOD`, `OOD`, `AD`, `EAD`, `ET`, `KD`, `SD`, …).
  The census must reconstruct «CompanyName + Bulgarian(LegalForm)» before keying, or every lookup misses.
  `tr-census.mjs` does this (`LEGAL_FORM` map); validated — 130 bidder names aligned to the key space from
  just 3 days of data, and a dry-run promotes 0 (correctly conservative on a partial window).
- **Consequence for execution:** a *sound* national census needs the **full delta history** ingested and
  reduced to current state (dedup by ЕИК, honor deletions) — ~tens of GB, an ingest-pipeline job, not a
  one-shot download. A **partial** census must **never** promote: an un-ingested namesake would make a
  false "globally unique" claim = the exact libel the certainty bar forbids. `tr-census.mjs --dry-run`
  exists to validate on partial data without mutating.

## Consequences

- Closes the last residual libel surface for generic names with a purely deterministic, public check.
- Cost: a full delta-history download + reduce-to-current index build; it rides the same fetch→extract→R2
  pattern as CACBG (ADR-0012), refreshed on the same cron cadence by pulling each new daily delta (TR
  changes daily; a stale census can wrongly promote).
- Scope guard: the TR dump is used **only** for the name-multiplicity index and per-ЕИК owner lookups
  (leg 2) — never bulk-republished, per the TR reuse constraints noted in the spec.
- Until the census runs, tier-C stays unpublished — fail-closed, never a guessed publish.
