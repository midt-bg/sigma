# AI Assistant — Lane F: Report dedup, single-flight & dock UX

Status: spec frozen 2026-06-24 · Owners: BE (F1/F2), FE (F3, in flight) · Relates to #97 (reconciliation/no-divergence gate)

## 0. Purpose & master invariant

The assistant is stateless; reports are immutable, public R2 artifacts at `/reports/:id` (LLM-free, D1-free to serve). Lane F makes identical requests **not** regenerate, collapses concurrent identical generations to one, and tells the dock "already generated — open existing."

Dedup here is **not** primarily a cost optimization — it is the mechanism that **guarantees two people asking the same fixed-period question can never see different numbers**. It is a consistency guarantee that directly serves #97.

**Master invariant (fail toward regeneration):** a cache entry is valid **iff** its embedded freshness token equals the current one **and** its R2 artifact still exists. Any doubt — missing/mismatched token, KV or parse error, absent artifact — is a **miss → regenerate**. Stale never serves.

## 1. Freshness token

Composite, reusing the existing data-version signal — do **not** invent a new epoch:

```
freshness = `d:${normalize(home_totals.refreshed_at)}|c:${BUILD_ID}`
//   d = data version  — same derivation csv-export.ts:176 already uses:
//                        refreshed_at.replace(/[^a-z0-9]/gi, '')
//   c = code/config version — build constant; busts cache when CPV taxonomy,
//                             FX logic, or report shape ship without a data change.
```

`d` covers all data and FX (precompute recomputes `amount_eur` and stamps `refreshed_at` **atomically** — one global version). `c` covers code/config changes that alter report shape without a data change. The token folds into every data-dependent layer key.

> Assumption: precompute writes one `refreshed_at` per run atomically (it does — single script rebuilding all rollups). If ETL ever refreshes tables independently, `d` must become per-table. Document any such change here.

## 2. F1 — `dedup.ts` (pure module, KV-backed, unblocked)

Lives in `apps/web/workers/assistant/dedup.ts` — the team backend lane (same dir as Lane E), **not** `app/lib/assistant` (nedda76's lane). Pure module over an injected KV namespace; buildable and unit-testable today without the orchestrator.

Each layer key is `SHA-256(<canonical field encoding>)` — reuse the **length-prefixed field-encoding pattern** from Lane E's `transcript-hmac.ts:107` (`canonicalBytes`) to avoid field-boundary collisions. Note: `canonicalBytes` is typed to `TranscriptMessage`, so generalize the pattern (a small `encodeFields(string[])`), don't call it directly. No HMAC (keys are not secret). **Lane E is PR #3, not yet merged into `feat/ai-assistant` — see §6 merge order.**

| Layer | Keyed on | Purpose | Folds freshness | TTL |
|---|---|---|---|---|
| L0 client idempotency | `clientRequestId` (uuid per submit) | same submission retried / double-click | hit validates stored report's token | 24h |
| L1 prompt-hash (optional fast-path) | `normalize(prompt) + filterContext` | catches verbatim-identical prompts pre-SQL | yes | 7d |
| **L2 resolved-SQL (primary key)** | `canonicalSql + canonicalParams` | same query plan → same report; the workhorse | yes | 7d |
| **L2.5 result-fingerprint (strongest)** | stable hash of result rows (canonical, sorted) | different SQL/prompt → identical data → dedups the LLM compose step | yes | 7d |
| L3 tool-memo | `toolName + canonicalArgs` | memoize tool calls within/across a run | yes | 10m |

**Global, keyed on L2/L2.5** — not on conversation, not on user. Two differently-phrased questions that resolve to the same SQL with the same absolute params yield one shared report. L1 is demoted to an optional fast-path; the robust global key is the resolved query, not the wording.

### API

```ts
freshnessToken(refreshedAt: string, buildId: string): string
dedupKey(layer: DedupLayer, payload: unknown, freshness: string): string
lookup(kv: KVNamespace, layer: DedupLayer, key: string, freshness: string)
  : Promise<{ reportId: string; createdAt: string } | null>   // freshness-validated; any error → null
record(kv, layer, key, reportId, freshness, ttlSeconds): Promise<void>
resolveReport(kv, signals, freshness): Promise<Hit | null>     // tries L0 → L2 → L2.5; first valid wins
```

Stored value: `{ reportId, freshness, createdAt }`. On `lookup`, miss unless `stored.freshness === currentFreshness`. Every error path returns `null` (regenerate). Adds one KV binding to `wrangler.jsonc`.

### Upstream requirement (enforced by the planner, not by F1)

The planner **must resolve relative date windows to absolute dates before the L2 key is computed** (e.g. "last 30 days" → `BETWEEN '2026-05-25' AND '2026-06-24'`). Otherwise a relative phrase caches to the wrong period. F1 keys on whatever SQL/params it is handed; correctness of the window resolution is the planner's promise.

## 3. F2 — `ReportSingleFlight` Durable Object

Addressed `idFromName(L2key)` → one coordinator per query. The fast path (KV hit + R2 exists) **bypasses the DO entirely**; only first-generation funnels through it, so the DO is cold once a report exists.

Single-flight is a **correctness** requirement: two concurrent generations for the same key could diverge, which is forbidden. The DO guarantees exactly one generation per key.

State machine per key:

```
idle
  → resolveReport hit? → R2 HEAD exists? → serve (data-dedup duplicate)
  → miss: state=generating, register waiters, call injected generator()
      → done:   cache {reportId, freshness}; emit data-report-ready to all; wake waiters
      → failed: clear state (next request regenerates — fail toward regeneration)
```

- **R2-exists check lives here** (the "R2-exists on F1" item): a KV hit whose artifact was GC'd is treated as a miss. Keeps F1 pure (no R2 dependency).
- **Generator is injected**: `() => Promise<{ reportId: string; freshness: string }>`, supplied by the orchestrator/chat route once it exists. F2 is specced and testable against a mock generator (miniflare DO).
- **Concurrent waiters** receive a **coarse progress** stream (`data-progress`) that resolves to the shared report — never a second generation. Token-level fan-out of one generation to N viewers is **deferred** (rare herd case; build only if metrics justify).
- Adds a DO binding + migration to `wrangler.jsonc`. **Coordinate binding names with F1's KV edit up front** so the two additive `wrangler.jsonc` edits don't collide.

## 4. F3 — dock UX contract (FE, in flight)

The dedup check runs **before the agent loop**. On a hit the server emits one stream part and ends the stream — **no LLM call at all** (the cost win). Streaming-first otherwise, like Claude/ChatGPT.

Stream parts (AI SDK v6 custom `data-*` parts; `data-report-ready` is defined in the assistant-contract PR (`feat/ai-assistant-contracts`, not yet merged — see §6) as `{ reportId, title }`; F2 emits it on completion):

```ts
data-dedup        { kind: 'duplicate'; reportId; url; createdAt; layer? }   // instant hit → stream ends (url = /reports/${reportId})
data-progress     { phase: 'planning' | 'querying' | 'composing' | 'binding'; label }  // coarse; drives waiter UX
data-report-ready { reportId; title }                                        // terminal — bound & persisted; url derived = /reports/${reportId}
```

| State | Dock behavior | BG string |
|---|---|---|
| `data-dedup` duplicate | "open existing" card, suppress spinner; button opens `url` | „Този отчет вече е генериран (на {createdAt})." · бутон „Отвори съществуващия отчет" |
| `data-progress` (waiter / driver) | coarse spinner with phase label | „Планирам заявката" → „Извличам данните" → „Съставям отчета" → „Свързвам стойностите" |
| `data-report-ready` | render report + confirmation bar | „Това ли е отчетът, който търсехте?" · „Да, изтегли" / „Не, уточни въпроса" |

**FE → server request** carries `clientRequestId` (uuid per submit, reused on retry → L0), prompt, and filter context. `/reports/:id` returns `200` ready / `202` pending (for any poll fallback).

**Confirmation, not reroll.** „Не, уточни въпроса" routes the user to **rephrase** the question (→ a different query, legitimately a different report) — never a silent re-roll of the same query. For a fixed past period the same resolved SQL is deterministic and **values-by-reference binding** makes the figures identical regardless of LLM phrasing, so "generate again" for the same question is a structural no-op (L2.5 returns the same report). There is **no `bypassDedup` / force-reroll**: it would change nothing for the same question, and a different question is a rephrase.

## 5. Two load-bearing guarantees (upstream of Lane F)

Global dedup is only correct if both hold. Name them in this spec so they cannot silently regress:

1. **Planner resolves relative → absolute dates before the L2 key** (§2). Without it, a relative window caches to the wrong period.
2. **Values-by-reference binding makes report figures deterministic** (the model emits refs; the server binds via `bindReport`). Without it, two compositions of the same data could differ.

If either regresses, global dedup can serve divergent data — a #97 violation.

### Merge-order dependencies (this spec PRs into `feat/ai-assistant`)

Two pieces this spec reuses live on **unmerged** branches, not on the `feat/ai-assistant` base:

- **Lane E (PR #3, `feat/integrity-anti-injection`)** — the `transcript-hmac.ts:107` `canonicalBytes` encoding pattern. F1 is "unblocked" for the *key-derivation logic*, but to literally reuse the encoder it must wait for PR #3 to land, **or vendor a local `encodeFields` helper** (a few lines). Pick the latter if F1 starts before #3 merges.
- **assistant-contract PR (`feat/ai-assistant-contracts`)** — the `data-report-ready` stream part (`{ reportId, title }`). Phases 3–4 depend on it; until merged, F3 builds against a mocked stream emitting the part shape above.

## 6. Phase plan

| Phase | Scope | Owner | Depends on |
|---|---|---|---|
| 0 Contract freeze | this document | done 2026-06-24 | — |
| 1 F1 `dedup.ts` | L0/L2/L2.5 keys (+ optional L1/L3), freshness token, KV binding, adversarial tests | BE | Phase 0; encoder from PR #3 **or** vendor `encodeFields` (§5) |
| 2 F2 single-flight DO | one generation per key, R2-exists check, coarse progress to waiters, injected generator, DO binding/migration | BE | Phase 1 |
| 3 Wire request path | chat route: resolve → hit short-circuits LLM; miss → DO → stream → `data-report-ready` | BE | **orchestrator** + planner/values-by-ref guarantees (§5) + Phase 2 |
| 4 F3 dock UX | the 3 stream parts + confirmation bar | FE | **Phase 0 only** — starts now against a mocked stream |
| 5 Telemetry | hit-rate, layer-hit distribution, stale-bust counter, divergence canary (assert identical reportId for identical L2 key) | BE | Phase 3 |

Phase 0 unblocks Phase 1 (BE) and Phase 4 (FE) **in parallel** — the reason to freeze the contract now. Phase 3 is the only orchestrator-gated piece.

## 7. Test obligations (adversarial)

- F1: freshness mismatch → miss; KV error → miss; no key collision across layers (canonical serialization); each layer round-trips; global L2 key stable across two differently-phrased prompts resolving to identical SQL. **Canonical value encoding is injective over its domain** (JSON values + `Date`): distinct `Date`, `NaN`, `±Infinity`, `undefined`, `-0`, and `bigint` params each yield distinct keys — never the `JSON.stringify` collapse (`Date`→`{}`, `NaN`/`undefined`→`null`, `-0`→`0`, `bigint` throws). A collision here would serve one question's numbers for another (#97).
- F2: exactly one `generator()` call under N concurrent requests for one key; R2-absent hit → regenerate; generator throw → next request regenerates; **failed cache write swallowed → next request regenerates (numbers never diverge)**; **`r2Exists` throw treated as miss → regenerate**; **cross-isolate: a second instance dedups on the first's KV record**; waiter receives the driver's `reportId`.
- Cross-cutting divergence canary (Phase 5): identical L2 key ⇒ identical `reportId`, asserted in CI; feeds #97.
