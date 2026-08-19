# Implementation Plan: #167 — „Седмицата в пари" (Weekly Automated Digest)

## Executive Summary

- **Ticket**: [#167](https://github.com/midt-bg/sigma/issues/167) — fixed-template weekly review of public spending, auto-generated every Monday for the prior week (Mon–Sun), published at `/weeks/{ISO}` + archive `/weeks`.
- **Spec**: `~/Downloads/weekly-digest.md` (Bulgarian). This plan is the English engineering translation.
- **Goal**: A server-authored, immutable `ResolvedReport` per settled week — numbers 100% from SQL, AI produces only the connective narrative, gated by the existing prose-number validator + verifier, rendered SSR from an R2 artifact with **no LLM/D1 at serve time**.
- **Complexity**: High (cross-worker reuse + net-new persistence/render layer).
- **Time Estimate**: MVP ≈ 6–8 working days *after prerequisites merge* (see §Dependencies). Not startable end-to-end today.
- **Risk Level**: High — mostly **dependency & architecture** risk, not algorithmic. The spec assumes reuse of components that (a) live on an unmerged branch or (b) do not exist yet, and (c) are not importable from the worker that needs them.
- **Branch**: `feat/weekly-digest` (already created off `main`).

---

## 🚨 CRITICAL DEPENDENCY FINDING (read first)

The spec's opening line is correct and load-bearing: *"стъпва върху работата по AI асистента … Не бива да се внедрява преди тях"* (builds on the AI-assistant work; must not ship before it). Ground-truth of the actual tree makes this concrete:

| Reuse target the spec names | Exists on `main` (this branch's base)? | Where it actually is |
|---|---|---|
| `bindReport`, `findProseNumbers`, `sanitizeProse/Cell`, `asNumber`, block schema (`Emit*`/`Resolved*`) | ✅ `apps/web/app/lib/assistant/report-schema.ts` | main |
| `entityHref`, `formatCell`, `validateEmitShape` | ✅ `render-format.ts`, `emit-report-schema.ts` | main |
| `verifier.ts` (supported/unsupported/uncertain, RISK_STEMS) | ❌ | **unmerged** `feat/ai-assistant-contracts` |
| ETL cron scaffold: `crons.ts`, `suggested-prompts.ts`, `crons.test.ts` | ❌ | **unmerged** `feat/ai-assistant-contracts` |
| ADR-0007 (settled-period gate) | ❌ | **unmerged** `feat/ai-assistant-contracts` |
| `is_synthetic` flag / migration `0002_contracts_is_synthetic` | ❌ | **unmerged** `feat/ai-assistant-contracts` |
| `persistReport()`, `StoredReport` type, R2 write of a report | ❌ **nowhere** (only a fixture `fixtures/r2-report-object.fixture.json` sketches the shape) | must be built |
| Report-serving SSR route, `ReportBlockRenderer`, `ReportAiWatermark` | ❌ **nowhere** | must be built |

Two structural blockers the spec does not mention:

1. **The ETL worker cannot run the pipeline.** `apps/etl/wrangler.toml` binds only `DB` (D1) and `REFRESH` (Queue) — **no `AI`, no `REPORTS` R2, no AI Gateway**. The digest needs all three.
2. **The pipeline is not importable from ETL.** `bindReport` et al. live *inside the `@sigma/web` app* (`apps/web/app/lib/assistant/`). `@sigma/etl` depends only on `@sigma/ingest`. Apps must not import from other apps. So "reuse `persistReport()`" from a cron is impossible until the primitives are **extracted into a shared workspace package**.

**Consequence**: the plan front-loads a prerequisite gate (§Dependencies / Phase 0) and an extraction refactor (Phase 1) before any digest-specific logic. Attempting the digest without these produces duplicated, drift-prone validators — a direct violation of the spec's §2 ("не пишем нов валидатор") and of `AGENTS.md`.

---

## Dependencies & Sequencing Gate (Phase 0 — not code)

**Blocking prerequisite**: `feat/ai-assistant-contracts` must merge to `main`. It brings `verifier.ts`, the ETL cron scaffold (`crons.ts` + `suggested-prompts.ts` as the canonical template), ADR-0007, and migrations `0002_contracts_is_synthetic` + `0003_assistant_prompts`.

Actions:
1. Confirm merge status of `feat/ai-assistant-contracts`. **Do not start Phase 2+ until merged.**
2. After merge, rebase `feat/weekly-digest` onto the new `main`.
3. **Resolve migration numbering**: the digest migration becomes `0004_weekly_digests.sql` (main will already hold 0000–0003 post-merge). Do **not** author it as `0002` on the pre-merge base — guaranteed collision.
4. Re-verify that `persistReport()` and the report-serving route are still absent post-merge (they may land as "assistant Phase 2"). If the assistant team is about to build them, **co-design** — the digest and the chat share these exact seams (§6 of spec). Building them twice is the biggest waste risk.

Open question to resolve with maintainers before Phase 1: **who owns `persistReport()` + `ReportBlockRenderer` + report-serving route — the assistant epic or this one?** Recommendation: build them in the shared package here (Phase 1/3) and let the assistant consume them, since the digest is the first consumer that actually persists.

---

## Current State Analysis

### What exists and is directly reusable (on `main`)
- **Report block model** — `apps/web/app/lib/assistant/report-schema.ts`:
  - `EmitBlock = EmitText | EmitCallout | EmitTotals | EmitFacts | EmitTable | EmitBar | EmitFlows | EmitTimeseries`; resolved counterparts `ResolvedBlock`; `ResolvedReport { title, question, blocks, watermark: 'ai-generated' }`.
  - **Values-by-reference**: `CellRef {resultId/handle,row,col}`; `QueryResult { handle:'R1', columns, rows, truncated? }`; `resultHandle(i)` → `R${i+1}`.
  - `bindReport(input, results, opts?): BindResult` — fills references from `QueryResult[]`, returns `{ok:true,report}` or `{ok:false,errors}`.
  - Gates: `findProseNumbers(text): string[]` (rejects unbound material numbers in prose), `gateProse` (2000-char ReDoS cap), `sanitizeProse`/`sanitizeCell` (linear `stripTags`, scheme defang), `asNumber` (strict decimal coercion — no hex/scientific).
  - `validateEmitShape` (`emit-report-schema.ts`), `finalizeReport(input, ctx)` orchestrator (`tools.ts:222`) = emit→validateShape→bind.
- **Entity links** — `render-format.ts`: `entityHref(kind,id)`, `formatCell(value, format)`. `EntityKind = 'company'|'authority'|'contract'`.
- **LLM plumbing** — `agent.ts`: `buildModel(env)` (BgGPT via AI Gateway), `streamText` with `maxOutputTokens:4096`, `maxRetries:1`, tool loop `stepCountIs`. Chat currently returns the report to the dock **in memory** — it is **not persisted**.
- **DB** — `packages/db/src/queries/*` (`home.ts`, `trend.ts`, `companies.ts`, `contracts.ts`, `methodology.ts`), identity helpers `hrefForEntity(kind,id)` + `authoritySlug/companySlug/contractSlug`. `data_freshness` + `home_totals` defined in `0000_init.sql`.
- **Web/UI** — React Router v7, file-based routes; loaders get bindings via `context.cloudflare.env.{DB,CSV_CACHE,REPORTS}`. Reusable components: `TotalsStrip`, `RankedBars`, `StackedBar`, `SingleOfferPortion`, `TrendChart`, `SankeyDiagram`, `DataTable` (sr-only `<caption>`), `Section`, `PageHeader`, `Breadcrumbs`, `Callout`, `publicCache(maxAge, swr)` in `lib/cache.ts`.
- **R2** — `apps/web/wrangler.jsonc` already declares buckets `CSV_CACHE` (`sigma-csv-cache`) and `REPORTS` (`sigma-reports`). Resource-route precedent for serving from R2: `contracts.csv.tsx` + `lib/csv-export.ts` (`bucket.get()`, ETag, range).

### Schema facts that constrain the queries (`0000_init.sql`)
- `contracts(id 'c:'+row, tender_id, bidder_id, signed_at ISO 'YYYY-MM-DD' nullable, amount_eur REAL nullable, bids_received INT, eu_funded, value_flag ok|review|value_low|value_suspect|annex_suspect)`. **Money rule**: `SUM(amount_eur) WHERE amount_eur IS NOT NULL`.
- `tenders(id 't:'+УНП, authority_id 'auth:'+bulstat, cpv_code 8-digit nullable, procedure_type)`. Sector = `substr(cpv_code,1,2)`.
- `bidders(id 'eik:'+eik | 'name:'+name, eik_normalized, eik_valid)`. **Companies can be name-keyed** — see caveat below.
- `authorities(id 'auth:'+bulstat)`.
- ISO week: `strftime('%G-W%V', signed_at)` (Mon–Sun), guard `signed_at IS NOT NULL`.

### Gaps / problems to fix (net-new work)
1. No `persistReport()` / `StoredReport` / R2 report write (only a fixture of the intended shape).
2. No verifier on `main` (arrives via prerequisite merge).
3. No report-serving SSR route, no `ReportBlockRenderer`, no `ReportAiWatermark`.
4. Report primitives not extractable from ETL (packaging boundary).
5. ETL worker missing `AI` + `REPORTS` bindings.
6. One net-new chart: weekly bars with "ghost" prior-week bars (extends `TrendChart` pattern).

### ⚠️ Spec inaccuracy to correct in implementation
Spec §6.1 links **company → `/companies/{ЕИК}`** and **authority → `/authorities/{ЕИК}`**. But bidder ids may be **name-keyed** (`name:<name>` → slug `n<base64url>`), so a raw-ЕИК URL is wrong for those. **Always route through `entityHref('company', id)` / `hrefForEntity`**, never format ЕИК into a URL by hand. Authorities are always `auth:bulstat` → ЕИК slug. Keep ids in `links`, display text in `cells` (the schema already enforces this separation).

---

## Target Architecture

### The pivotal decision: extract a shared `@sigma/report` package
The digest cron (ETL worker) and the chat (web worker) must run the **same** emit→bind→validate→verify→persist→render pipeline. Today that code is trapped in `@sigma/web`. Recommendation:

**Create `packages/report` (`@sigma/report`)** — pure, worker-agnostic, no React, no Cloudflare-specific imports:
- Move (with git history) the pure logic: block schema types, `bindReport`, `validateEmitShape`, `sanitizeProse/Cell`, `findProseNumbers`, `asNumber`, `entityHref`, `formatCell`, and the merged-in `verifier`.
- Add **new** here: `StoredReport` type, `persistReport(bucket, key, report, provenance)`, `readStoredReport(bucket, key)`. R2 access via an injected `R2Bucket` param (no binding names baked in) so both workers pass their own.
- `@sigma/web` keeps its React renderer + re-exports the primitives from `@sigma/report` (thin shim so existing imports/tests keep passing — update import paths in one mechanical pass).
- `@sigma/etl` adds `"@sigma/report": "workspace:*"`.

**Alternative considered — ETL → web service binding** (ETL POSTs to an internal web endpoint that emits+persists): rejected for a cron. Adds a network hop, an auth surface, and still needs the shared pipeline; harder to test deterministically. Keep it noted as fallback only if extraction proves too invasive pre-merge.

### Data flow (identical to chat, per spec §6)
```
Monday 07:00 UTC cron (after 06:00 refresh)
  → read data_freshness.as_of  (anchor)
  → GATE 1 settled week (ADR-0007): as_of >= week-end Sunday, else skip+reissue later
  → run weekly queries a–h  → QueryResult[]
  → GATE 2 zero rows: 0 contracts ⇒ NO artifact, NO LLM, /weeks/{ISO} stays 404
  → reconciliation tripwire: SUM(amount_eur) vs home_totals.value_eur → log on drift
  → emit blocks (references only) + LLM narrative (BgGPT via AI Gateway)
  → bindReport() fills numbers from results
  → validate: findProseNumbers() gate + schema  → regenerate (max N)
  → verifier: strip unsupported claims (never inserts text)
  → still invalid ⇒ FALLBACK to AI-free template (numbers only, no narrative)
  → persistReport() → immutable JSON at weeks/{ISO}.json in REPORTS R2
  → UPSERT digest row to D1 (iso_week PK, as_of, refreshed_at, status)
  → structured JSON log; kill-switch consulted before publish
SSR: GET /weeks/{ISO} → readStoredReport(REPORTS, 'weeks/{ISO}.json') → ReportBlockRenderer (no LLM, no D1)
```

### Key design choices
- **Deterministic R2 key** `weeks/{ISO}.json` (vs chat's random `report/{id}.json`) so it is addressable by route + archive. Re-issue on late data writes a new version with `refreshed_at` (auto-correction, §10.4).
- **Immutability + cache**: settled week ⇒ `Cache-Control: public, s-maxage=31536000, immutable`. Archive index shorter TTL via `publicCache`.
- **Gates precede spend** — settled-week + zero-row gates run before any query cost or LLM call (§5).
- **Kill switch** — config flag (KV or `vars`) checked in the cron dispatch; when off, compute+log but do not publish.
- **Charts server-rendered** to static SVG (existing components already emit `role="img"` SVG + sr-only `<table>`); reused in-page, in social card, in email later.

### Compliance validation
- **Spec §2 golden rule** honored: every number bound from SQL via values-by-reference; `findProseNumbers` is the *same* gate — no new validator.
- **AGENTS.md**: single logical change per PR (this plan slices into stacked PRs), conventional commits, no `Co-Authored-By`, no secrets/`.dev.vars`. Cloudflare + pnpm + turbo stack respected; new package uses `workspace:*`.
- **ADR-0007**: settled-period gate reused verbatim as GATE 1.
- **Accessibility (`docs/accessibility.md`)**: every chart keeps the paired sr-only `<table>`; WCAG AA.

---

## Implementation Phases

> TDD is mandatory (`AGENTS.md` + global rules): each task writes tests first. Stack the work as small PRs, each one logical change, conventional-commit titled.

### Phase 1 — Extract `@sigma/report` shared package (foundation) — ~2 days
Unblocks cross-worker reuse. No behaviour change to chat.

**1.0 Tests first**: copy the existing `report-schema.test.ts`, `render-format.test.ts`, `emit-report-schema.test.ts`, `verifier.test.ts` into `packages/report/src/*.test.ts`; they must pass unchanged after the move (proves no behaviour drift).

**1.1** Scaffold `packages/report` (`@sigma/report`, `workspace:*`, its own `tsconfig`/`vitest`). No React, no `cloudflare:*` imports.

**1.2** `git mv` the pure logic from `apps/web/app/lib/assistant/` → `packages/report/src/`: block schema types, `bindReport`, `validateEmitShape`, `sanitizeProse/Cell`, `findProseNumbers`, `asNumber`, `entityHref`, `formatCell`, `verifier`. Preserve history.

**1.3** `apps/web` re-exports from `@sigma/report` (barrel shim at old paths) so routes/tests keep importing the same specifier. Mechanical import-path pass; run web test suite.

**1.4** Add **new** persistence primitives in `packages/report/src/persist.ts`:
- `interface StoredReport { schemaVersion: number; id: string; createdAt: string; report: ResolvedReport; provenance: Provenance }` where `Provenance = { sources: {handle,sql}[]; snapshot: QueryResult[]; freshness: {source,as_of}[]; model: string; promptVersion: string }` (matches `fixtures/r2-report-object.fixture.json`).
- `persistReport(bucket: R2Bucket, key: string, stored: StoredReport, opts?: {immutable?: boolean}): Promise<void>` — `bucket.put` with `httpMetadata` content-type + cache; idempotent.
- `readStoredReport(bucket: R2Bucket, key: string): Promise<StoredReport | null>`.
- Validate against the fixture in a unit test.

**Verify**: `pnpm --filter @sigma/report test && pnpm --filter @sigma/web test && pnpm --filter @sigma/web typecheck` all green.

### Phase 2 — DB migration + weekly queries (`packages/db`) — ~1.5 days
**2.0 Tests first**: `packages/db/src/queries/weekly.test.ts` against real SQLite fixture (mirror `home.test.ts` / `suggested-prompts.sql.test.ts`) — assert exact aggregates on a seeded Mon–Sun week, ISO-week boundary correctness, `amount_eur IS NOT NULL` handling, and **zero-row** returns.

**2.1** Migration `packages/db/migrations/0004_weekly_digests.sql` — table `weekly_digests(iso_week TEXT PRIMARY KEY, payload TEXT, as_of TEXT, refreshed_at TEXT, status TEXT)`. (Number confirmed post-merge; see Phase 0.)

**2.2** `packages/db/src/queries/weekly.ts` — one exported fn per spec indicator a–h, each `async (db: D1Database, isoWeek: string) => …`, `.prepare(sql).bind(isoWeek).all<Row>()`, money guarded by `WHERE amount_eur IS NOT NULL`. Indicators: a totals, b counts, c largest+outlier-guard, d single-bid % (≥20 sample floor), e WoW delta, f top-10 contracts (⋈ tenders⋈bidders⋈authorities, ids for links), g sectors `substr(cpv_code,1,2)`, h top authorities. Return typed `WeeklyDigestData`.

**2.3** Reconciliation helper: compare `SUM(amount_eur)` for the week vs `home_totals` scope (log-only tripwire, mirror suggested-prompts).

**Verify**: `pnpm --filter @sigma/db test`; apply migration to a local D1 and eyeball one week.

### Phase 3 — Report renderer + serving route (`apps/web`) — ~2 days
Shared with assistant Phase 2 (co-own per Phase 0 open question).

**3.0 Tests first**: `ReportBlockRenderer.test.tsx` — golden render for each `ResolvedBlock` type from a fixture `StoredReport`; `weeks.$iso` loader test asserting 404 on missing artifact and no D1/LLM call on hit.

**3.1** `ReportBlockRenderer` (`apps/web/app/components/`) — maps `ResolvedBlock[]` → existing components: totals→`TotalsStrip`, bar→`RankedBars`, table→`DataTable` (+`entityHref` links), timeseries→`TrendChart`, flows→`SankeyDiagram`, text/callout→prose (`sanitizeProse` already applied at bind). Each chart keeps its sr-only `<table>`.

**3.2** `ReportAiWatermark` — the §7 disclaimer ("Генерирано с изкуствен интелект… Проверявайте важни данни от първичен източник.") + „данни към {as_of}" + model + source links. Rendered whenever `report.watermark === 'ai-generated'`.

**3.3** `WeeklyGhostBars` (the **one** net-new chart) — variant of `TrendChart`: vertical bars for the week's daily spend + lighter "ghost" bars for the prior week; `role="img"` + paired `DataTable`.

**3.4** Routes: `weeks.$iso.tsx` (loader `readStoredReport(env.REPORTS,'weeks/'+iso+'.json')`; 404 if null; `Cache-Control: public, s-maxage=31536000, immutable` for settled; render via `ReportBlockRenderer` — **no D1, no LLM**). `weeks._index.tsx` archive (lists only weeks with an artifact; sparkline of weekly totals; shorter `publicCache`).

**Verify**: `pnpm --filter @sigma/web test typecheck`; local `pnpm dev`, drop a fixture artifact into local R2, load `/weeks/2026-W25` and `/weeks`.

### Phase 4 — ETL generation job + cron wiring (`apps/etl`) — ~2 days
**4.0 Tests first**: `weekly-digest.test.ts` (gates: settled-week, zero-row short-circuit, fallback-on-invalid) + `weekly-digest.sql.test.ts` (real SQLite) + extend the cron-guard test for `DIGEST_CRON`.

**4.1** ETL bindings — add to `apps/etl/wrangler.toml`: `[ai] binding="AI"`, `[[r2_buckets]] binding="REPORTS" bucket_name="sigma-reports"`, AI Gateway config, and the kill-switch `var`. Update `scripts/wrangler-render.mjs` to substitute the bucket/IDs. Add `"@sigma/report": "workspace:*"` + `"@sigma/db": "workspace:*"` to `apps/etl/package.json`.

**4.2** `apps/etl/src/crons.ts` — `export const DIGEST_CRON = '0 7 * * 1';` (Mon 07:00 UTC, after 06:00 refresh). `wrangler.toml` `[triggers] crons` append (order matches cron-guard).

**4.3** `apps/etl/src/weekly-digest.ts` — mirror `suggested-prompts.ts`: read `data_freshness.as_of` anchor → **GATE 1** settled-week (ADR-0007) → **GATE 2** zero-row short-circuit (no LLM, no artifact) → queries a–h → reconciliation tripwire → build `EmitBlock[]` (references only) → LLM narrative (BgGPT/AI Gateway) → `bindReport` → `findProseNumbers` gate → regenerate (max N) → `verifier` strip → invalid ⇒ **AI-free fallback template** → assemble `StoredReport` (provenance: sources+snapshot+freshness+model+promptVersion) → `persistReport(env.REPORTS,'weeks/'+iso+'.json',stored,{immutable:true})` → UPSERT `weekly_digests` → structured JSON log.

**4.4** `apps/etl/src/index.ts` `scheduled()` — `if (controller.cron === DIGEST_CRON) { if (killSwitchOff) {log; return;} ctx.waitUntil(generateWeeklyDigest(env).catch(logErr)); }`.

**4.5** Digest system prompt + glossary (reuse `describe-schema.ts` terminology; neutral-tone lexicon; "сигнали, не присъди").

**Verify**: `pnpm --filter @sigma/etl test`; `wrangler dev --test-scheduled` locally trigger; confirm artifact lands in local R2 and `/weeks/{ISO}` renders it.

### Phase 5 — Safe degradation, kill switch, observability — ~0.5 day
**5.1** Kill-switch flag end-to-end test (off ⇒ compute+log, no publish). **5.2** Sanity gates on data (`total≥0`, largest≤total, plausible WoW delta) as hard blockers before persist. **5.3** Every artifact carries „данни към {timestamp}"; late-data re-issue writes `refreshed_at` + „коригирано" note. **5.4** Structured log of the `WeeklyDigest` object + validation result per run (audit).

### Phase 6 (fast-follow, out of MVP scope)
„На радара" anomaly signals (code-generated, reuse `anomaly-report.md` p95-by-CPV), social card (server SVG→PNG), YoY context, mini-flows top-5. Tracked separately.

---

## Testing Strategy

- **Unit** (`@sigma/report`): moved suites must pass unchanged (drift proof); new `persist.ts` validated against the R2 fixture. `findProseNumbers`/`verifier` behaviour re-asserted in the new package.
- **DB** (`@sigma/db`): real-SQLite fixture with a seeded Mon–Sun week + boundary days (Sun 23:59 vs Mon 00:00) to prove ISO-week bucketing; zero-row week returns empty; `amount_eur IS NULL` excluded from SUM; single-bid sample floor (≥20).
- **ETL** (`@sigma/etl`): gate matrix — (a) unsettled week ⇒ skip, (b) 0 contracts ⇒ no artifact + no LLM (assert LLM mock **not** called), (c) invalid narrative after N regens ⇒ fallback template persisted, (d) kill-switch off ⇒ no `put`. Cron-guard extended for `DIGEST_CRON`.
- **Web** (`@sigma/web`): `ReportBlockRenderer` golden per block type; `weeks.$iso` loader → 404 on missing artifact, **no D1/LLM** on hit; entity links route through `entityHref` (name-keyed company does not produce a ЕИК URL).
- **Golden render**: one committed `StoredReport` fixture → full-page snapshot for `/weeks/{ISO}`.
- Per `AGENTS.md`: run only the minimal per-filter suites during dev; assert exact values, one behaviour per test, no branching in tests.

## Risk Assessment

| Risk | Sev | Mitigation |
|---|---|---|
| Prerequisite branch not merged ⇒ nothing to build on | High | Phase 0 hard gate; do not start Phase 2+ until merged; rebase. |
| Duplicated pipeline in ETL (drift from chat) violates spec §2 | High | Phase 1 extraction to `@sigma/report`; forbid copy-paste of validators. |
| `persistReport`/renderer built twice (assistant + digest) | Med | Co-own decision in Phase 0; build once in shared package. |
| Migration number collision across branches | Med | Number after merge (`0004`); never `0002` on pre-merge base. |
| Wrong/defamatory number reaches a public page | High | Values-by-reference + `findProseNumbers` + verifier + sanity gates; AI-free fallback; immutable audit provenance. |
| ETL missing AI/R2 bindings at deploy | Med | Phase 4.1 wrangler + render-script change; deploy-gate note like existing REPORTS bucket gate. |
| Name-keyed company mis-linked (§6.1 spec bug) | Med | Always `entityHref`/`hrefForEntity`; test asserts no hand-built ЕИК URL. |
| "Boring week" over-dramatized | Low | Neutral-tone lexicon + verifier strips unsupported; honest small numbers. |
| Late data correction confuses cache | Med | `refreshed_at` + „коригирано" note; immutable only for settled week. |

## Rollout Plan

- **Pre-deploy**: `sigma-reports` R2 bucket exists (already gated in web wrangler); ETL wrangler renders AI + REPORTS bindings; migration `0004` applied (blue-green per ADR-0005); kill-switch **off** for first deploy.
- **Deploy order**: `@sigma/report` → `@sigma/db` (migration) → `@sigma/web` (routes render, 404 until artifacts exist — safe) → `@sigma/etl` (cron). 
- **First run**: manually trigger `--test-scheduled` for a known-good past week; inspect artifact + `/weeks/{ISO}`; then flip kill-switch on.
- **Post-deploy**: watch first Monday run logs (reconciliation drift, gate outcomes); verify archive lists only weeks with artifacts; confirm immutable cache headers.

## Multi-Agent Review (analytic synthesis)

Four parallel exploration agents mapped the report pipeline, ETL crons, DB schema, and web/render layers; findings drove the dependency table and architecture. Review lenses applied:

- **Architecture**: The only way to satisfy "reuse, don't reinvent" across two Workers is the `@sigma/report` extraction (Phase 1). Without it the plan silently duplicates validators. Rated the extraction the top structural risk and sequenced it first. Service-binding alternative documented and rejected for cron use.
- **Security**: Public, unattended output ⇒ the validator chain *is* the editor. Kept the existing linear `stripTags`/`sanitizeProse` (ReDoS-hardened per review #80), the `findProseNumbers` gate, and the AI-free fallback as the safe-degradation floor. No new sanitizer. Kill-switch + immutable provenance for audit.
- **Performance**: Serve path is pure R2 read + SSR (no D1/LLM), `immutable` CDN cache for settled weeks; gates run before any query/LLM spend. Charts stay server-SVG.
- **Database**: Confirmed money rule (`amount_eur IS NOT NULL`), ISO-week via `strftime('%G-W%V')`, sector via `substr(cpv_code,1,2)`, id conventions; flagged the name-keyed company link bug in spec §6.1; migration numbering.
- **Testing**: TDD per phase; gate matrix asserts the LLM is *not* called on zero-row/kill-switch paths — the cheapest place these guarantees can regress.

Consensus: proceed, but **only behind Phase 0/1**. The spec is sound; its unstated assumptions (unmerged deps, cross-worker packaging, non-existent persist/render) are what this plan makes explicit.

## Success Criteria

- [ ] Prerequisite branch merged; `feat/weekly-digest` rebased; migration numbered `0004`.
- [ ] `@sigma/report` extracted; chat suites pass unchanged; ETL imports the shared pipeline.
- [ ] `persistReport`/`readStoredReport`/`StoredReport` implemented + fixture-validated.
- [ ] Weekly queries a–h correct on seeded SQLite (ISO boundaries, money rule, sample floor).
- [ ] Monday cron: settled-week gate, **zero-row short-circuit (no LLM, no artifact)**, reconciliation tripwire, UPSERT, structured log.
- [ ] AI narrative gated by `findProseNumbers` + verifier; AI-free fallback on failure; never publishes an unvalidated number.
- [ ] `/weeks/{ISO}` renders from R2 with no D1/LLM; 404 for weeks without artifacts; immutable cache for settled weeks.
- [ ] `/weeks` archive lists only weeks with artifacts.
- [ ] All entity links via `entityHref` (name-keyed companies safe); every chart has sr-only `<table>` (WCAG AA).
- [ ] Kill-switch verified; late-data re-issue writes `refreshed_at` + „коригирано".
- [ ] Conventional commits, no `Co-Authored-By`, no secrets; each phase a scoped PR.

---

## Validation Refinements (2026-07-15)

Post-plan self-validation re-verified every load-bearing claim against the tree. All file references, patterns, and the dependency table are **accurate** (persist/StoredReport absent repo-wide; `verifier` on the unmerged branch not `main`; migrations `0000–0003` occupied ⇒ digest = `0004`; primitives are React-free ⇒ extractable; all 7 reused components + `publicCache` + CSV resource-route precedent exist; `home_totals.value_eur` / `data_freshness.as_of` are real tables; §6.1 name-keyed-company bug confirmed via `identity.ts`). Four refinements to fold in during implementation:

1. **ISO-week derivation is net-new** — no `%G-W%V`/`iso_week` helper exists anywhere. Add a tiny pure util (prior-week ISO label + Mon 00:00 / Sun 23:59 date bounds, computed in JS) consumed by both the ETL job (which week to generate) and the queries (`strftime('%G-W%V', signed_at)` filter). Put it in `@sigma/report` or `@sigma/shared` with unit tests on year-boundary weeks (W52/W53/W01).
2. **D1 `weekly_digests` = index, not a second copy of the report** — R2 holds the immutable rendered `StoredReport`; the D1 row is the **archive index** (`iso_week`, `as_of`, `refreshed_at`, `status`, + a small total for the `/weeks` sparkline). `/weeks` lists from this table (cheap) rather than R2 LIST. Do not duplicate the full report `payload` in D1 — avoid two sources of truth. (Refines Phase 2.1 column intent.)
3. **Reconciliation counts caveat** — `0000_init.sql` documents that `home_totals.contracts` is `COUNT(*)` over *all* contracts while `value_eur` is `SUM(amount_eur)` over *clean* rows only ("the two do NOT cover one set"). The tripwire must compare **value vs `value_eur`** and must not equate the corpus count with the value-bearing count. (Refines Phase 2.3 / 4.3.)
4. **`@sigma/report` is not a zero-dep leaf** — it will depend on `@sigma/db` (`hrefForEntity` via `identity.ts`) and `@sigma/shared` (`money/count/pct/date`). Both are pure TS packages, so this is fine, but wire the `workspace:*` deps explicitly in Phase 1.1.

**Estimate note**: phase sum is ~8 days; treat 8 (not 6) as the realistic figure — Phase 1 touches many import sites in `@sigma/web` and can overrun.

**Verdict**: APPROVED WITH REVISIONS. Plan is technically accurate and internally consistent; the four items above are clarifications, not corrections. The one true blocker (Phase 0 prerequisite merge) is already captured. Safe to implement **once `feat/ai-assistant-contracts` merges**.

---
**Status**: Validated — approved with revisions; awaiting maintainer decision on Phase 0 open questions (prerequisite merge timing; ownership of `persistReport`/renderer)
**Created**: 2026-07-15
**Validated**: 2026-07-15 (main-agent re-verification of all subagent claims)
**Approved By**: _pending_
