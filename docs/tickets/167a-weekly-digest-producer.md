# #167A — Weekly Digest: Producer (pipeline · data · generation)

**Parent**: [#167](https://github.com/midt-bg/sigma/issues/167) · **Plan**: [`docs/implementation-plans/167-weekly-digest.md`](../implementation-plans/167-weekly-digest.md)
**Owner**: Dev A (platform / data) · **Est**: ~5.5 days · **Branch**: `feat/weekly-digest` (or stacked `feat/weekly-digest-producer`)

## Scope
The generation spine: extract the shared report package, add persistence, build the DB layer, and the Monday ETL cron that writes an immutable digest artifact to R2. You **produce** the `StoredReport`; Dev B consumes it.

## ⛔ Blocked by (Phase 0)
- `feat/ai-assistant-contracts` must merge to `main` (brings `verifier.ts`, ETL cron scaffold, ADR-0007, migrations `0002`/`0003`). **Do not start until merged**, then rebase.
- Migration numbering: digest migration is **`0004`** (0000–0003 occupied post-merge).

## Interface contract (freeze first, jointly with Dev B — ~0.5d)
Nail the `StoredReport` shape before parallel work. Both sides code against `apps/web/app/lib/assistant/fixtures/r2-report-object.fixture.json`.
```ts
interface StoredReport { schemaVersion: number; id: string; createdAt: string;
  report: ResolvedReport; provenance: Provenance }
interface Provenance { sources: {handle,sql}[]; snapshot: QueryResult[];
  freshness: {source,as_of}[]; model: string; promptVersion: string }
```
R2 key: `weeks/{ISO}.json` (deterministic). Update the fixture to be the golden reference for both tickets.

## Tasks

### T1 — Extract `@sigma/report` (Plan Phase 1) ~2d
- Scaffold `packages/report` (`@sigma/report`, `workspace:*`); **deps**: `@sigma/db` (`hrefForEntity`) + `@sigma/shared` (`money/count/pct/date`). No React, no `cloudflare:*`.
- `git mv` pure logic from `apps/web/app/lib/assistant/`: block schema types, `bindReport`, `validateEmitShape`, `sanitizeProse/Cell`, `findProseNumbers`, `asNumber`, `entityHref`, `formatCell`, `verifier`. Preserve history.
- `@sigma/web` re-exports from `@sigma/report` (barrel shim at old paths); mechanical import-path pass.
- **New** `packages/report/src/persist.ts`: `StoredReport`/`Provenance` types, `persistReport(bucket: R2Bucket, key, stored, {immutable?})`, `readStoredReport(bucket, key)`.
- **New** ISO-week util (`isoWeekLabel(date)`, `weekBounds(iso)` → Mon 00:00 / Sun 23:59) — no helper exists in repo today.
- **Tests first**: moved suites pass unchanged (drift proof); `persist.ts` validated vs fixture; ISO-week util tested on W52/W53/W01 boundaries.

### T2 — DB migration + weekly queries (Plan Phase 2) ~1.5d
- `packages/db/migrations/0007_weekly_digests.sql`: table = **archive index**, `weekly_digests(iso_week TEXT PK, as_of TEXT, refreshed_at TEXT, status TEXT, total_eur REAL)`. **Do not** store the full report payload here (R2 is source of truth; avoid two copies).
- `packages/db/src/queries/weekly.ts`: one fn per indicator a–h, `async (db: D1Database, isoWeek: string) => …`, `.prepare().bind(isoWeek).all<Row>()`, money guarded `WHERE amount_eur IS NOT NULL`, sector `substr(cpv_code,1,2)`, single-bid `bids_received=1` (≥20 sample floor), largest-contract outlier guard, top-10 with ids for links.
- Reconciliation helper: compare week `SUM(amount_eur)` vs `home_totals.value_eur` (log-only tripwire). **Caveat**: `home_totals.contracts` is COUNT(*) over *all* rows ≠ the clean-amount count — compare value vs `value_eur`, never equate counts.
- **Tests first**: real-SQLite fixture with seeded Mon–Sun week + boundary days (Sun 23:59 vs Mon 00:00); zero-row week returns empty; NULL amounts excluded.

### T3 — ETL generation job + cron (Plan Phase 4 + 5) ~2d
- `apps/etl/wrangler.toml`: add `[ai] binding="AI"`, `[[r2_buckets]] binding="REPORTS" bucket_name="sigma-reports"`, AI Gateway config, kill-switch `var`. Update `scripts/wrangler-render.mjs` substitution. Add `@sigma/report` + `@sigma/db` deps to `apps/etl/package.json`.
- `apps/etl/src/crons.ts`: `export const DIGEST_CRON = '0 7 * * 1'`; append to `wrangler.toml` `[triggers] crons` (order matches cron-guard).
- `apps/etl/src/weekly-digest.ts` (mirror `suggested-prompts.ts`): read `data_freshness.as_of` anchor → **GATE 1** settled-week (ADR-0007) → **GATE 2** zero-row short-circuit (no LLM, no artifact) → queries a–h → reconciliation → emit blocks (refs only) → LLM narrative (BgGPT/AI Gateway) → `bindReport` → `findProseNumbers` gate → regenerate (max N) → `verifier` strip → invalid ⇒ **AI-free fallback template** → assemble `StoredReport` → `persistReport(env.REPORTS,'weeks/'+iso+'.json',…)` (no `immutable` — the object is overwritten in place on a re-issue, so an `immutable` cache-control would be a stale-serve trap) → UPSERT `weekly_digests` → structured JSON log.
- `apps/etl/src/index.ts` `scheduled()`: `if (controller.cron === DIGEST_CRON) { if killswitch off → log+return; ctx.waitUntil(generateWeeklyDigest(env).catch(logErr)) }`.
- Sanity gates before persist: `total≥0`, largest≤total, plausible WoW delta. Late-data re-issue writes `refreshed_at` + „коригирано".
- Digest system prompt + neutral-tone glossary (reuse `describe-schema.ts` terms).
- **Tests first**: gate matrix — unsettled ⇒ skip; 0 contracts ⇒ **assert LLM mock NOT called** + no `put`; invalid after N regens ⇒ fallback persisted; kill-switch off ⇒ no publish. Extend cron-guard for `DIGEST_CRON`.

## Definition of done
- [ ] `@sigma/report` extracted; chat suites pass unchanged; `@sigma/etl` imports it.
- [ ] `persistReport`/`readStoredReport`/`StoredReport` + ISO-week util implemented & fixture-validated.
- [ ] Migration `0004` applied (blue-green, ADR-0005); queries a–h correct on seeded SQLite.
- [ ] Monday cron: both gates, reconciliation, verifier, AI-free fallback, UPSERT, structured log; never persists an unvalidated number.
- [ ] ETL wrangler renders `AI` + `REPORTS` bindings; kill-switch verified.
- [ ] Conventional commits, no `Co-Authored-By`, no secrets; scoped PRs per task.

## Handoff to Dev B
Once T1 lands, publish the frozen `StoredReport` type + updated fixture. Dev B builds the renderer against the fixture in parallel; integrate on real artifacts after T3.
