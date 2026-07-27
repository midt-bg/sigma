# #167B — Weekly Digest: Consumer (render · routes · UX)

**Parent**: [#167](https://github.com/midt-bg/sigma/issues/167) · **Plan**: [`docs/implementation-plans/167-weekly-digest.md`](../implementation-plans/167-weekly-digest.md)
**Owner**: Dev B (web / render) · **Est**: ~2.5 days · **Branch**: `feat/weekly-digest` (or stacked `feat/weekly-digest-consumer`)

## Scope
The consumer side: turn a `StoredReport` artifact into the public `/weeks` pages with reused components, one net-new chart, the AI watermark, and safe-degradation UX. You **render** what Dev A produces.

## ⛔ Blocked by / depends on
- Phase 0 prerequisite merge (see plan) applies here too.
- **Soft dep on Dev A T1**: needs the frozen `StoredReport` type. **Unblock immediately** by building against the existing fixture `apps/web/app/lib/assistant/fixtures/r2-report-object.fixture.json` and the `ResolvedReport` types already on `main`. Swap to the real `@sigma/report` import once T1 lands.

## Tasks

### T1 — Report renderer components (Plan Phase 3.1–3.3) ~1.5d
Shared with the assistant's own render layer — build to be reusable by both.
- `apps/web/app/components/ReportBlockRenderer.tsx`: maps `ResolvedBlock[]` → existing components: `totals→TotalsStrip`, `bar→RankedBars`, `table→DataTable` (+links via `entityHref`), `timeseries→TrendChart`, `flows→SankeyDiagram`, `text/callout→prose`. Prose is already `sanitizeProse`'d at bind time — do not re-sanitize, but never `dangerouslySetInnerHTML` raw model output.
- `apps/web/app/components/ReportAiWatermark.tsx`: §7 disclaimer ("Генерирано с изкуствен интелект… Проверявайте важни данни от първичен източник.") + „данни към {as_of}" + model + source links. Render when `report.watermark === 'ai-generated'`.
- `apps/web/app/components/WeeklyGhostBars.tsx` — **the one net-new chart**: variant of `TrendChart`; vertical bars for the week's daily spend + lighter "ghost" bars for the prior week. `role="img"` + paired sr-only `<table>` (WCAG AA, per `docs/accessibility.md`).
- **Entity-link rule (spec §6.1 bug)**: always route through `entityHref('company'|'authority'|'contract', id)` — never hand-format a ЕИК into a URL; name-keyed companies (`name:…`) must resolve via the helper.
- **Tests first**: golden render per `ResolvedBlock` type from the fixture; watermark renders iff flag set; ghost-bars accessible table matches bar data.

### T2 — `/weeks` routes (Plan Phase 3.4) ~0.5d
- `apps/web/app/routes/weeks.$iso.tsx`: loader `readStoredReport(context.cloudflare.env.REPORTS, 'weeks/'+iso+'.json')`; **404 if null**; render via `ReportBlockRenderer` — **no D1, no LLM at serve time**. `headers()` → `Cache-Control: public, s-maxage=31536000, immutable` for settled weeks (use `publicCache` for non-immutable cases).
- `apps/web/app/routes/weeks._index.tsx`: archive index; list weeks from the `weekly_digests` D1 index (cheap) — show **only weeks with an artifact**; sparkline of weekly `total_eur`; shorter `publicCache`.
- Follow the `contracts.csv.tsx` + `lib/csv-export.ts` resource-route precedent for R2 reads (ETag/`get()`).
- **Tests first**: loader returns 404 on missing artifact; **asserts no D1/LLM call** on hit; archive lists only artifact-backed weeks.

### T3 — Safe-degradation & provenance UX (Plan Phase 5, serve side) ~0.5d
- Render the AI-free **fallback template** cleanly (numbers-only, no narrative) when the artifact carries no verified prose — must look intentional, not broken.
- Footer provenance row: source (CC-BY 4.0 АОП/ЦАИС ЕОП), „данни към {timestamp}", „генерирано автоматично", link to archive `/weeks`.
- Surface „коригирано" note when `refreshed_at` is present.
- Golden full-page snapshot for `/weeks/{ISO}` from a committed `StoredReport` fixture.

## Definition of done
- [x] `ReportBlockRenderer` renders every `ResolvedBlock` type; reuses existing components; all entity links via `entityHref` (name-keyed companies safe).
- [x] `ReportAiWatermark` + footer provenance present; „данни към {as_of}", model, sources shown.
- [x] `WeeklyGhostBars` server-SVG with paired sr-only `<table>` (WCAG AA).
- [x] `/weeks/{ISO}` renders from R2 with **no D1/LLM**; 404 for weeks without artifacts; cached per the policy in Deviations below (bounded `private` + edge-cache bypass, not `immutable`).
- [x] `/weeks` archive lists only artifact-backed weeks. (The weekly-totals sparkline was dropped — see below.)
- [x] AI-free fallback renders cleanly; „коригирано" note on re-issue.
- [x] Golden render snapshot committed; conventional commits, no `Co-Authored-By`.

## Coordination
- Freeze the `StoredReport` contract jointly with Dev A on day 1; both code against the shared fixture.
- Report-serving route + `ReportBlockRenderer` are also the assistant's Phase-2 render layer — keep them generic (not digest-specific) so the chat can reuse them. Flag to maintainers if the assistant epic wants to co-own (plan Phase 0 open question).

## Deviations from this ticket (intentional)
- **Cache policy for `/weeks/{ISO}`.** T2 specified `immutable`. Shipped as `private, max-age=60` with the per-colo edge cache bypassed for `/weeks/:iso` (`apps/web/workers/app.ts`). Reason: the producer re-issues a **corrected** digest in place at the same R2 key (status „коригирано", spec §10.4); an `immutable`/long-lived shared cache keyed by URL+deploy-tag (not data-version) would keep serving the stale copy for its whole freshness+SWR window after a correction. The page is one small R2 GET, so rendering fresh is cheap and a correction shows immediately.
- **Archive source.** T2 said list `/weeks` from the `weekly_digests` D1 index. Shipped listing from R2 (`listStoredWeeks`) instead, keeping the serve path fully D1-free (spec §6/§11) and consistent with the per-week route. Trade-off: the archive's per-week total relies on R2 `customMetadata`.
- **Sparkline dropped.** T2 sketched a weekly-totals sparkline on `/weeks`. Removed: with most weeks lacking a stamped total (and one outlier dominating the y-axis) it degenerated into a near-flat divider line. The per-week total column already carries the numbers. Revisit once there's a steady backlog of weeks with totals (and normalize the outlier).

## Follow-ups (tracked, out of this PR)
- **Week-scoped „Разгледай сам" deep links** (#81 review, note 4): `DigestExplore` currently links to the full `/contracts` `/authorities` `/companies` `/flows` surfaces because the list loaders have no `?week=` filter. When a `week=<ISO>` filter lands on those loaders (parse in `filters.ts` + `strftime('%G-W%V', signed_at)` predicate in `@sigma/db` + add `week` to the cache-key allow-list), thread `iso` into `DigestExplore`'s hrefs so the links open the week's slice.
- **§3.8 stacked-procedure lane**: the competition section ships the single-bid concentration bar only; the stacked procedure-mix bar needs a weekly `procedure_type` grouping query + a stacked report block type.
- **`WeeklyGhostBars` daily vs weekly axis**: revisit if a future digest wants intra-day or multi-week series. The two series are paired by day LABEL (not array index), so a gap in one week no longer mispairs; the digest still feeds 7 fixed Mon..Sun slots via `getWeeklyDailySpend`.
- **react-router v8 upgrade** (GHSA-qwww-vcr4-c8h2): the advisory is CSRF in react-router's *unstable RSC* mode, which Sigma does not use (standard SSR via `createRequestHandler`), so it's ignored in `osv-scanner.toml`. The only fix is react-router 8.3.0, a **major** bump that migrates the app to the v8 RSC build architecture (`@vitejs/plugin-rsc`, `react-server-dom-webpack`) — do it as its own upgrade PR with full regression testing, then drop the `osv-scanner.toml` entry.
- **PII / natural-person masking** (#81 review): `/weeks/:iso` is `robots: noindex` (mirrors `company.tsx`) because the top-contracts table names winning bidders. The broader site-wide gap — `/flows` and `/competition` render the same names without noindex, and none of the list surfaces mask ЕТ/natural persons the way `company.tsx` noindexes their profiles — is a policy decision to settle once (mask in the shared render/query, or noindex the analytic surfaces).
