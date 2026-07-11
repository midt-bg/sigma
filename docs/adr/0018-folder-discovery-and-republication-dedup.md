# ADR-0018: Discover declaration-set folders from the register index; dedup republications by ControlHash

- Status: Accepted
- Date: 2026-07-05
- Deciders: lb, Claude
- Related: [ADR-0012](0012-crawler-and-persistence-architecture.md), [ADR-0013](0013-two-declaration-templates.md); `scripts/cacbg/fetch.mjs`, `scripts/cacbg/extract.mjs`, `scripts/cacbg/guard.mjs`

## Context

The first crawler assumed one folder per year and enumerated `register.cacbg.bg/<year>/list.xml` over a
hard-coded `CANDIDATE_YEARS` list (2017–2026). A 404 was read as "no data for that year". This was wrong:
the register's own root index (`https://register.cacbg.bg/`) lists **35** declaration-set folders whose
names do **not** follow `folder == year`:

- **Filing sets** — bare year plus suffixed variants: `2015 2016 2017 2018 2018f1 2018h 2019 2019f1
  2019f2 2020 2020f1 2021_nc 2021_nonc 2021f1 2022 2022f1 2023 2023y3 2023y4 2024 2024f1 2025`. The
  suffixes are compliance-check result sets (`_nc`/`_nonc` — по чл. 43/58 ЗПКОНПИ/ЗПК, приключила с/без
  несъответствие), institution or follow-up batches (`f1`/`f2`/`h`), and local elections.
- **End-of-year publication sets** — `2015y … 2025y`, `2023y2`, `2019e` (публикуване в края на годината).

The year-only guess fetched ~8 folders. It silently dropped **all of 2021** (which exists only as
`2021_nc`/`2021_nonc`/`2021f1`, never a bare `/2021/`), 2015–2016, every compliance/institution variant,
and the entire end-of-year corpus — tens of thousands of declarations. The "2021 and 2026 are missing"
claim was an artifact of the assumption, not a property of the source (2026 genuinely does not exist yet;
2025 declarations are filed in 2026).

## Decision

1. **Discover, don't guess.** `fetch.mjs` parses the register root index for `href="<folder>/index.html"`
   and crawls every folder it finds. `guard.safeFolder` constrains a folder id to `20\d{2}` + up to 8
   `[A-Za-z0-9_]` chars, so a hostile index cannot inject a path segment. A `--folders a,b` override
   remains for targeted re-crawls. This is also correct for the cron refresh (ADR-0012): new folders
   (next year's filing set, new compliance sets) are picked up automatically.
2. **Dedup republications by ControlHash.** The same signed declaration is republished across sets (the
   filing set, its end-of-year `*y` copy, and often a compliance `nc/nonc` copy) carrying the **same
   ControlHash** (content hash). `extract.mjs` keeps a global `Set` of seen ControlHashes and emits each
   declaration once (first folder wins; filing folders sort before their `*y` republication). A *corrected*
   re-filing carries a *different* ControlHash and is legitimately kept — the loader aggregates per
   (person → company) link, so distinct filings reinforce one link rather than inflating counts.

## Consequences

- The corpus expands from ~8 folders to 35, recovering 2021, 2015–2016, the compliance/election variants,
  and the end-of-year sets, without double-counting republished declarations.
- All downstream numbers (published-link counts, contract-value headlines) are recomputed on the complete
  corpus. Figures reported before this ADR were on a partial (~8-folder) dataset and are superseded.
- `extract.mjs` no longer restricts folders to the bare-year shape; it accepts the `safeFolder` shape and
  reports `dupSkipped` so the republication overlap is visible, not hidden.
- Provenance (`source_url`, folder) records the folder the retained copy came from — the primary filing
  set where possible.
