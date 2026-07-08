# AI асистент — имплементация

Наша имплементация на [`docs/spec/ai-assistant.md`](../../../../../docs/spec/ai-assistant.md),
включително хардунирането от **§9** (PR #79). Backend-ът на асистента е **опроводен от край до край в
кода**: чистите тествани модули → tool registry → agent loop → ресурс route-а `/assistant/chat`.
Остават потребителските части (dock UI, renderer на справките и `/reports/:id`, глас) и provisioning-ът
(`ASSISTANT_API_KEY` + bindings) — виж „Какво остава".

## Какво има (имплементирано)

| Файл                        | Роля                                                                         | Спец.        | Проверка  |
| --------------------------- | ---------------------------------------------------------------------------- | ------------ | --------- |
| `report-schema.ts`          | Block речник + **сървърно обвързване на стойностите**                        | §4, §9.1, §7 | unit      |
| `sql-guard.ts`              | Read-only структурен guard + LIMIT + byte cap                                | §7, §9.4     | unit      |
| `sql-ast-guard.ts`          | AST guard: read-only + table allowlist + no-cross-join + LIMIT               | §9.4         | unit      |
| `describe-schema.ts`        | Куриран речник на данните с капаните                                         | §9.2         | unit      |
| `rag.ts`                    | Vectorize + Workers AI RAG (grounding + semantic search)                     | _добавка_    | unit      |
| `system-prompt.ts`          | emit-report политика, values-by-reference, data-trust, скелет                | §4/§7/§9.10  | unit      |
| `tool-results.ts`           | D1 редове → хендълнат `QueryResult`                                          | §7           | unit      |
| `eop-fetch.ts`              | `eop_fetch` — валидация + fixed base (no SSRF) + cap                         | §9.7         | unit      |
| `source-link.ts`            | Официални линкове (ЦАИС ЕОП) за цитиране                                     | §3           | unit      |
| `emit-report-schema.ts`     | Структурна валидация + model-facing JSON Schema                              | §4           | unit      |
| `render-format.ts`          | format-by-hint + entity-ref линкове                                          | §4           | unit      |
| `tools.ts`                  | Tool registry (SDK-агностичен) + `finalizeReport`                            | §2/§3        | unit      |
| `agent.ts`                  | Vercel AI SDK glue: чат моделът (BgGPT/mamay) през AI Gateway + `streamText` | §2/§9.5      | typecheck |
| `routes/assistant.chat.tsx` | Stateless chat ресурс route                                                  | §2/§5        | typecheck |

**Проверено:** `pnpm --filter web typecheck` → 0; **150 теста** преминават; `pnpm audit --audit-level=high`
чист; Prettier чист. Чистите модули са unit-тествани и deploy-независими; agent loop-ът и route-ът са
typecheck-проверени, но **не са runtime-проверени** (няма `ASSISTANT_API_KEY` / облачни bindings в тази среда).

## Ключово решение: стойностите се владеят от сървъра (§9.1)

Сърцето на интегритета. Моделът **не пише числа** — `emit_report` блоковете _референцират_ хендъли към
резултатни множества, които сървърът реално е изпълнил, а `bindReport()` пре-свързва реалните стойности.
Таблиците взимат редовете изцяло от резултата, така че моделът не може да инжектира измислен ред или да
напише „12 млрд." вместо „1,2 млрд." — векторът за клевета от
[architecture.md](../../../../../docs/architecture.md) §3. Само `text`/`callout` носят авторска проза и
са markdown-санитизирани (без raw HTML → затваря stored-XSS на публичния `/reports/:id`).

## RAG — добавка спрямо спецификацията

Спецификацията е **text→SQL агент с инструменти, БЕЗ векторно извличане.** RAG е добавен нарочно на двете
места с най-голяма полза при слаб 27B: (1) **grounding на схемата** — извлича най-релевантните trap-правила
и примерни заявки за конкретния въпрос в системния prompt (retrieval-augmented формата на §9.2); (2)
**`semantic_search`** — допълва FTS за парафрази/синоними. Пада обратно до статичния `describeSchema()`,
ако се реши, че RAG е извън v1.

## ⚠️ Provisioning gate — необходими Cloudflare ресурси (трябва да предхождат `wrangler deploy`)

Chat имплементацията свързва (`apps/web/wrangler.jsonc`) редица Cloudflare ресурси, които трябва да
**съществуват преди deploy** — иначе `wrangler deploy` пада и блокира CD за целия екип (ревю #80). Всяка
от услугите по-долу се осигурява **за всяка среда** (dev/preview, staging, prod). Докато не са налице,
`/assistant/chat` връща контролирано **503** (fail-safe); отделно мастер launch gate-ът `ASSISTANT_ENABLED`
държи маршрута тъмен независимо от provisioning-а (§8, `assistantEnabled()`).

| Услуга (Cloudflare)              | Ресурс / binding                                            | Роля                                                                                            | Създаване                                             |
| -------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **AI Gateway**                   | gateway `sigma-assistant` (`AI_GATEWAY_ID`)                 | Единна точка за целия model трафик (LLM + RAG embeddings), §9.5 — задължителен                  | dashboard/API                                         |
| **AI Gateway → Custom Provider** | slug **`bggpt`**, base_url `https://api.mamay.ai`           | BgGPT (mamay.ai) не е вграден провайдър → wired като Custom Provider; upstream за chat моделите | dashboard/API                                         |
| **Workers AI**                   | binding `AI` (модел bge-m3, 1024 dims)                      | RAG embeddings (grounding + `semantic_search`)                                                  | account capability (включи Workers AI)                |
| **Vectorize**                    | индекс `sigma-assistant` (`VECTORIZE`)                      | Схема-grounding + семантично търсене                                                            | `wrangler vectorize create`                           |
| **R2**                           | bucket `sigma-reports` (`REPORTS`)                          | Неизменни справки-артефакти (§5)                                                                | `wrangler r2 bucket create`                           |
| **KV**                           | namespace `sigma-dedup-<env>` (`DEDUP_KV`)                  | Freshness-validated дедуп кеш (Lane F, L0–L2.5)                                                 | `scripts/ensure-kv-namespace.mjs` (CI, идемпотентно)  |
| **Durable Objects**              | `ReportSingleFlight` (`REPORT_SINGLE_FLIGHT`, SQLite)       | Single-flight координатор — колабира еднакви въпроси в 1 генерация                              | `[migrations]` tag v1 (при deploy)                    |
| **Durable Objects**              | `BgGptCircuitBreaker` (`BGGPT_CIRCUIT_BREAKER`)             | Акаунт-широк RPM circuit-breaker (#135)                                                         | `[migrations]` tag v2 (при deploy)                    |
| **Turnstile**                    | widget → `TURNSTILE_SITE_KEY` (public) + `TURNSTILE_SECRET` | Bot gate на `/assistant/chat` (§7/§8); prod fail-closed без secret                              | dashboard                                             |
| **Rate Limiting**                | `ASSISTANT_RATE_LIMITER` (namespace_id 1005, 10/60s)        | Per-IP throttle (акаунт-scoped)                                                                 | wrangler `unsafe` binding (при deploy)                |
| **D1**                           | база `sigma` (`DB`, read-only path)                         | Сервираните procurement данни                                                                   | виж [`docs/deploy.md`](../../../../../docs/deploy.md) |
| **Workflows (ETL)**              | `sigma-refresh` (`REFRESH`, в `sigma-etl`)                  | Cron refresh — поддържа rollup-ите/`is_synthetic`                                               | `[[workflows]]` в `apps/etl`                          |

**Секрети** (`wrangler secret put`, никога в source): `ASSISTANT_API_KEY` (BgGPT/mamay ключ → `Authorization: Bearer`
upstream), `TURNSTILE_SECRET`, по избор `ASSISTANT_HMAC_KEY` (за отложения §9.3 подпис на съобщения). CI ползва и
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SIGMA_D1_ID`, `SIGMA_DEDUP_KV_ID`.

**Публична конфигурация** (`vars`): `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_ID`, `ASSISTANT_MODEL`, `BGGPT_RATE_LIMIT_RPM`,
`D1_ROWS_READ_BUDGET`, `RUN_SQL_TIMEOUT_MS`, `TURNSTILE_SITE_KEY`, `BUILD_ID`, `ASSISTANT_ENABLED`.

```bash
# Веднъж на средата, ПРЕДИ `wrangler deploy` (иначе deploy-ът пада и блокира CD на целия екип):

# 1) Vectorize индекс — ЗАДЪЛЖИТЕЛНО 1024 dims / cosine (bge-m3); грешни размери чупят RAG.
wrangler vectorize create sigma-assistant --dimensions=1024 --metric=cosine

# 2) R2 bucket за справките.
wrangler r2 bucket create sigma-reports

# 3) KV namespace за дедупа (CI го прави идемпотентно; ръчно за локална/нова среда). id → SIGMA_DEDUP_KV_ID.
node scripts/ensure-kv-namespace.mjs sigma-dedup-dev

# 4) Секрети (интерактивно; никога не се комитват).
wrangler secret put ASSISTANT_API_KEY                     # BgGPT/mamay ключ
wrangler secret put TURNSTILE_SECRET                      # bot gate; prod fail-closed без него

# 5) AI Gateway + Custom Provider (dashboard/API). BgGPT НЕ е вграден провайдър, затова се добавя като
#    Custom Provider със slug `bggpt` и base_url https://api.mamay.ai. Gateway-ът ползва само ORIGIN-а на
#    base_url и добавя пътя след `custom-bggpt/`, затова `/v1` живее в AI_GATEWAY_BASE_URL — OpenAI SDK-то
#    после резолвва `<base>/chat/completions` до https://api.mamay.ai/v1/chat/completions.
#      AI_GATEWAY_BASE_URL=https://gateway.ai.cloudflare.com/v1/<account>/sigma-assistant/custom-bggpt/v1
#      AI_GATEWAY_ID=sigma-assistant   # slug-ът; през него минават и Workers AI embeddings-ите
#      ASSISTANT_MODEL=bggpt-gemma4-31b-it-bg-gptq-w4a16

# 6) Turnstile widget (dashboard) → site key-а в var TURNSTILE_SITE_KEY, secret-а през `wrangler secret put` (стъпка 4).

# 7) Без отделна команда: `AI` (Workers AI) е account capability (само включи Workers AI за акаунта);
#    Durable Objects (ReportSingleFlight, BgGptCircuitBreaker) и ASSISTANT_RATE_LIMITER се създават от самия
#    deploy през [migrations]/unsafe bindings.

# 8) След като Vectorize индексът съществува, еднократно напълни схема-корпуса:
#    indexSchemaCorpus(env.AI, env.VECTORIZE)
```

Докато бекендът не е напълно осигурен, `/assistant/chat` връща контролирано **503**, а грешка по време на
streaming се показва като четим текст — не като счупена връзка или 500 (graceful degradation, §7).

**Блокиращо преди прод ключ:** route-ът изпълнява `run_sql` в момента, в който `ASSISTANT_API_KEY` е наличен,
а D1 binding-ът все още е read-write. Затова НЕ задавайте прод `ASSISTANT_API_KEY`, докато (1) `run_sql` не
работи срещу read-only D1 binding/реплика и (2) не е наложен глобален budget/circuit-breaker
(`BGGPT_RATE_LIMIT_RPM` е деклариран, но още не се чете). Двуслойният SQL guard е defense-in-depth, не
единствената бариера пред write достъп (ревю на #80). Самите две мерки остават launch-gate follow-up.

## Сигурност — затворено по ред-тийма на #80

AST table-allowlist + забрана на comma cross-join/`WITH RECURSIVE` + AST-достоверен LIMIT
(`sql-ast-guard.ts`, §9.4); guardrail **E2** (детерминистична проверка „без едри числа в прозата");
санитизация на data-cells (не само проза); fix на `eop_fetch` byte-cap-а (отказва вместо да парсва);
**per-IP rate-limit** на `/assistant/chat`; cap на история/тяло + `abortSignal` + явни
`maxRetries`/`maxOutputTokens`; entity-link id-та в bound-натите редове; + low-ове (`encodeURI` на href,
embed cap + проверка за брой, без raw D1 грешка към модела). Подробности: коментарите на #80.

**Denial-of-Wallet на `run_sql` (#122):** `LIMIT` ограничава върнатите, не сканираните редове, а D1
таксува по прочетени — затова `run_sql` натрупва `meta.rows_read` за хода и отказва по-нататъшни
заявки при надхвърляне на `D1_ROWS_READ_BUDGET` (per-ход бюджет, tunable var). raw огледалата
(`raw_*`) са изрично извън table-allowlist-а, така че неиндексираните им full-scan-ове са недостъпни.

## Какво остава

- **Фаза 2 — потребителски слой:** глобален dock (`useChat`); renderer `emit_report` → компонентите на
  сайта + нов `timeseries`; `/reports/:id`, chat карти, индекс `/reports`; воден знак „AI-генерирано,
  неофициално" + показан въпрос (§9.12); достъпни таблици-алтернативи за SVG блоковете (§9.6).
- **Фаза 2 — XSS бариера (gating за renderer PR-а):** markdown renderer-ът на `/reports/:id`/dock-а
  ЗАДЪЛЖИТЕЛНО allowlist-ва URL схемите (`urlTransform` → само http/https/mailto) и НЕ ползва
  `dangerouslySetInnerHTML` за проза/data-cells. `sanitizeProse` е само defense-in-depth и нарочно
  непълна (не хваща whitespace-разделени схеми, напр. `java<TAB>script:`) — allowlist-ът е
  **авторитетната** бариера (ревю #80).
- **Фаза 2 — устойчивост:** глобален budget + circuit-breaker / exponential backoff пред BgGPT
  (per-IP rate-limit и graceful degradation вече са налице — остава глобалният таван).
- **Фаза 3:** глас (`/assistant/transcribe` → Whisper).
- **`semantic_search` — `ns: 'entity'` е празен** докато не се добави entity indexer (ETL pipeline,
  Фаза 2). Инструментът е регистриран и работи, но ще връща 0 попадения за всяко запитване, докато
  pipeline-ът не напълни Vectorize с имена на компании/договори/възложители.
- **`eop_fetch` връща само БРОЙ редове на ден, не самите данни** (днес): инструментът сваля, капва и
  парсва файла, но връща „N реда" и не пуска `QueryResult` в `ctx.results`, така че моделът НЕ може да
  обвърже EOP стойност в `emit_report`. Засега е probe за наличие/свежест, не източник на данни (ревю #80).
- **Freshness не е свързан:** route-ът извиква `runAssistant` без `freshness`, така че редът за свежест в
  системния prompt не се появява. Да се подаде `data_freshness` (по източник) — follow-up, не в това PR.
- **Втвърдяване:** read-only D1 data path + неотменяем per-query timeout за `run_sql` (§9.4 — AST guard-ът
  и allowlist-ът вече са налице); HMAC-подпис на сървърните съобщения (§9.3); memoize
  `(sql_hash, freshness)` + дедуп на справки (§9.8); golden-report CI, вкл. adversarial prompt-injection
  (§9.9); launch gate (Turnstile).
