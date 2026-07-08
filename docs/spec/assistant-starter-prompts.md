# Assistant dock — dynamic weekly starter prompts (feed-following, zero-LLM)

Status: **plan v3 (locked)** · Owner: assistant · Related: [ai-assistant.md](./ai-assistant.md)

The dock empty state shows ~4 starter questions. Today they are hardcoded. This feature refreshes
them **weekly** with **dynamic, data-driven** questions that follow what the EOP feed has recently
delivered — **without any LLM**: a scheduled job runs deterministic SQL over D1 and fills Bulgarian
sentence templates.

## Data path & placement

EOP feed → `sigma-etl` (6h, existing) → D1 → **`sigma-etl` weekly cron (new, deterministic)** →
`assistant_prompts` table → `apps/web` loader → dock.

Home = **`apps/etl`** (the scheduled-only worker): it shares the `sigma` D1, already runs crons, is
**not** deployed per-PR (so no preview-cron replication), and — because the design is zero-LLM — needs
no BgGPT/AI stack. `apps/web` stays cron-free; it only reads.

## Money policy (load-bearing decision, made explicit)

`home_totals.value_eur` is a raw `SUM(amount_eur)` over non-NULL rows with **no `value_flag` gate**
(`scripts/refresh-slice.sql:1341`). `value_flag` is advisory metadata the headline rollup ignores.

- **Sums (slots 2, 3): `amount_eur IS NOT NULL` only — reconcile exactly with `home_totals`/explorer.**
  We inherit the upstream `amount_eur` posture *by design*; a **reconciliation tripwire** makes a
  source-quality regression visible rather than silently propagated.
- **Named top-1 (slot 1):** consistent with the explorer's sort (`amount_eur IS NOT NULL`, minus
  `annex_suspect`) **plus an outlier guard** — a top-1 pick *amplifies* a single bad row a sum dilutes,
  and it carries a real authority's name.

## The 4 slots

Window: `signed_at ∈ (as_of−7d, as_of]`, `as_of = (SELECT as_of FROM home_totals WHERE id=1)`, **bound
via `?1`** (never interpolated). Labels name the **period with explicit dates**, never „нова/тази
седмица". **Display label ≠ send payload**: the chip shows rich data; on click it POSTs a
**server-authored** question with **no untrusted feed name**.

### Slot 1 · biggest signed contract (named display; outlier-guarded)
```sql
SELECT a.name authority, c.amount_eur, substr(t.cpv_code,1,2) div
FROM contracts c JOIN tenders t ON t.id=c.tender_id JOIN authorities a ON a.id=t.authority_id
WHERE c.amount_eur IS NOT NULL AND c.value_flag <> 'annex_suspect'
  AND c.signed_at > date(?1,'-7 day') AND c.signed_at <= ?1
ORDER BY c.amount_eur DESC LIMIT 5;   -- top-5 so the job can sanity-check the distribution
```
- **Outlier guard:** suppress the **name** if `top.amount_eur ≥ K × second-or-p95(window)` (K≈10,
  tunable) or past an absolute sanity ceiling. On trip → emit slot 1 as the number-free fallback. Log
  the pick (`amount`, `value_flag`, ratio).
- label: *„Най-голяма поръчка, подписана {from}–{to}: {amount} — {authority*} ({sector})"*
- send (no name): *„Покажи най-голямата поръчка, подписана в периода {from}–{to}."*

### Slot 2 · top CPV division by signed spend (sector label = controlled vocab, safe in send)
```sql
SELECT substr(t.cpv_code,1,2) div, SUM(c.amount_eur) eur, COUNT(*) n
FROM contracts c JOIN tenders t ON t.id=c.tender_id
WHERE c.amount_eur IS NOT NULL AND t.cpv_code<>''
  AND c.signed_at > date(?1,'-7 day') AND c.signed_at <= ?1
GROUP BY div ORDER BY eur DESC LIMIT 1;
```
- label: *„Сектор с най-много средства {from}–{to}: {sector} — {eur} по {n} договора"*
- send: *„Кои изпълнители спечелиха най-много в {sector} за периода {from}–{to}?"*

### Slot 3 · activity in window (aggregate; structurally non-empty)
```sql
SELECT COUNT(*) n, COALESCE(SUM(c.amount_eur),0) eur
FROM contracts c
WHERE c.amount_eur IS NOT NULL
  AND c.signed_at > date(?1,'-7 day') AND c.signed_at <= ?1;
```
- label: *„Подписани {from}–{to}: {n} договора за {eur}"* · send: *„Покажи договорите, подписани в периода {from}–{to}."*

### Slot 4 · single-offer share (known-offer denominator + exclude synthetic + sample floor)
```sql
SELECT SUM(CASE WHEN c.bids_received=1 THEN 1 ELSE 0 END) single, COUNT(*) total
FROM contracts c JOIN tenders t ON t.id=c.tender_id
WHERE c.amount_eur IS NOT NULL
  AND c.bids_received IS NOT NULL AND c.bids_received >= 1
  AND t.procedure_type <> 'неизвестна'
  AND c.signed_at > date(?1,'-7 day') AND c.signed_at <= ?1;
-- emit ONLY if total >= 20; else widen, else DROP slot 4
```
- label: *„{single} от {total} договора с известен брой оферти ({pct}%) са с една оферта, {from}–{to}"*
- send: *„Какъв е делът на договорите с една оферта, подписани в периода {from}–{to}?"*

**Widen rule:** slots 1/2/4 empty (or slot 4 < 20) → retry 14d → 30d; still empty → number-free label +
generic send. `{from}/{to}` always reflect the *actual* window. Slot 3 never empties.

`*` Authority name **sanitized at generation**: NFC-normalize, strip zero-width/bidi-override
(U+200B–200F, U+202A–202E, U+2028/U+2029), collapse whitespace, cap ~80 chars. (React escapes already;
this is defence-in-depth + layout safety.)

## Data-soundness guards

1. **Reconciliation tripwire.** A unit test asserts `SUM(amount_eur WHERE NOT NULL) == home_totals.value_eur`
   on a seeded D1; the cron also compares at runtime and logs `etl_prompt_reconcile_mismatch` on a
   mismatch beyond ε (non-fatal — still writes prompts).
2. **Slot-1 outlier guard** (above).
3. **Documented assumption** in the job header: sums reconcile with `home_totals.value_eur` by design;
   soundness depends on the upstream `amount_eur` derivation, guarded by the reconciliation check +
   slot-1 outlier guard.

## Data model — committed, etl-owned

`packages/db/migrations/0003_assistant_prompts.sql`:
```sql
CREATE TABLE assistant_prompts (
  slot INTEGER PRIMARY KEY,          -- 1..4
  label TEXT NOT NULL,               -- display (escaped at render; may include sanitized authority name)
  send_query TEXT NOT NULL,          -- server-authored question POSTed on click — NEVER a raw feed name
  signal TEXT NOT NULL,
  as_of TEXT NOT NULL, window_from TEXT, window_to TEXT,
  refreshed_at TEXT NOT NULL
);  -- etl-owned: ONE writer (sigma-etl weekly cron), ONE reader (apps/web loader)
```
The etl job **UPSERTs only** (`ON CONFLICT(slot) DO UPDATE …`); **no lazy `CREATE TABLE`** at cron
time. Dev/preview seed runbooks (`docs/dev-environments*.md`) must apply `0001` after `0000_init`.

## Job (`apps/etl`)

- `wrangler.toml` → `crons = ["0 */6 * * *", "0 6 * * 1"]`.
- `index.ts` `scheduled(controller, env, ctx)` → branch on `controller.cron`: `PROMPTS_CRON` →
  `generateSuggestedPrompts(env.DB)`; `REFRESH_CRON` → existing `env.REFRESH.create()`; else → log
  `etl_unknown_cron` (defensive default, never silently misroute).
- **Routing safety:** the two cron strings are named constants (`REFRESH_CRON = '0 */6 * * *'`,
  `PROMPTS_CRON = '0 6 * * 1'`) used in the branch, and a **guard test** parses `wrangler.toml`'s
  `crons` and asserts they equal those constants — so a typo fails CI instead of silently misrouting.
- New `apps/etl/src/suggested-prompts.ts`: read `as_of`; reconciliation check (log on mismatch);
  per-slot bound queries (widen / slot-4 floor / slot-1 outlier guard); BG-format; CPV label via
  `@sigma/config CPV_SECTORS`; sanitize name; UPSERT. Per-slot `try/catch` → leave prior row on error;
  log success/failure counts.
- Add `@sigma/config` (`workspace:*`) to `apps/etl/package.json`.

## Serving (`apps/web`)

`app/routes/assistant.prompts.tsx` (GET, public) — loader reads `assistant_prompts ORDER BY slot` via
`withDbRetry`; returns `data({ prompts: {label,send}[], asOf, window }, { headers: { 'Cache-Control':
'public, max-age=900, stale-while-revalidate=86400' } })`; error/missing/empty → `{ prompts: [], asOf:
null }` (no 500/stack). `root.tsx` untouched.

## Dock (`apps/web`) — depends on the dock (PR #5)

- `AssistantEmptyState.tsx`: `PROMPTS` → `FALLBACK_PROMPTS: {label,send}[]`; add `prompts?:
  {label,send}[]` defaulting to it. Render `label` as a React text child; `onPick` sends `send`.
- `AssistantDock`/`useAssistantChat`: best-effort `fetch('/assistant/prompts')` on mount → non-empty
  `prompts` else fallback. „обновено към {asOf}" + window line. Renders N chips (4, or 3 if slot 4
  dropped).

## Guardrails (final)

sums `amount_eur IS NOT NULL` (reconcile + tripwire) · slot 1 also excludes `annex_suspect` +
outlier-guarded · `as_of`-anchored & bound windows · recency = `signed_at`, honest period labels +
visible dates · no `deadline_at` · slot-4 `≥20` floor + known-offer denominator + synthetic excluded ·
send payload server-authored (no feed name) · display name sanitized · escaped text only.

## Never-empty

widen 7→14→30 → number-free label → static `FALLBACK_PROMPTS`. Slot 3 structurally non-empty. Loader
missing-table → `[]` → fallback (covers the deploy/migrate lag).

## Cadence & phasing

Weekly `0 6 * * 1` (one-line to tighten). **Phase 1a** (backend, independent of PR #5): migration + etl
job + loader + tests. **Phase 1b** (on the dock branch / after the dock merges): the
`AssistantEmptyState` split-payload refactor + fetch-on-mount. **Phase 2:** optional slot-2 rotation
(sector ↔ most-active-authority) on an ISO-week key.
