# ADR-0012: Crawler + persistence architecture

- Status: Accepted
- Date: 2026-07-05
- Deciders: lb, Claude
- Related: spec §7; `scripts/cacbg/fetch.mjs`, `extract.mjs`

## Context

The CACBG register is ~135k+ declaration XMLs across yearly folders (2017–2025; 2021 and the current
year absent). The source is **immutable per year** (a closed year's files never change; only the current
year gains new filings). We need a repeatable, resumable ingest that is polite to a state server, keeps
PII contained, and fits SIGMA's existing Cloudflare ETL rather than bolting on new infrastructure.

## Decision

**Two-stage: fetch (I/O) → extract (parse), separated.**

- `fetch.mjs` — pure I/O. Discovers folders, fetches `list.xml` + every declaration into a git-ignored
  **raw cache** (`scratch/cacbg/raw/<year>/`). Resumable by file existence (immutable source ⇒ skip if
  present), polite (concurrency ≤6, 403/429/5xx exponential backoff, circuit breaker, jitter), and
  404-tolerant (listed-but-unpublished files are source gaps, not errors). Path-sanitizes every `xmlFile`.
- `extract.mjs` — no network. Re-parses the raw cache into structured staging, so the parser can evolve
  without re-fetching. Splits public holdings from internal third-party data (ADR-0010).

**Production mapping (rides the existing pipeline, no new store type):**
- Immutable raw XML → **R2**, keyed by `xml_file`, ETag-tagged (mirrors the local raw cache).
- Structured domain (`persons`, `declarations`, `declared_interests`, `interest_links`) → **D1**, built
  by the same `normalize-raw.sql` → `precompute.sql` → `ship-domain` → `assertIntegrity` path.
- Natural key `xml_file` + `control_hash` makes re-import idempotent (zero drift).

**Refresh = scheduled Cron Worker**, not a manual re-run. Closed years live permanently in R2 and are
never re-fetched; the trigger (Queue fan-out) pulls only the **current-year delta** via the ETag/skip
set — a few hundred fetches, not the whole corpus. Stale links (official left office, declaration
withdrawn/amended) must be expired, else a stale link implies a *current* conflict that has ended.

## Consequences

- Re-parsing is instant; re-crawling is only ever the current-year delta.
- New infrastructure is honestly acknowledged: a rate-limited cached crawler, a JS resolver pass, a
  suppression/correction store, and upstream-schema-drift monitoring — none of which the base ETL had.
- The raw cache is ~3 GB locally (git-ignored, deleted post-spike); in production it is R2, retained.
