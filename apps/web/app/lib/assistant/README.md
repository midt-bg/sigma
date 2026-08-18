# AI асистент — имплементация

Наша имплементация на [`docs/spec/ai-assistant.md`](../../../../../docs/spec/ai-assistant.md), включително
хардунирането от **§9** (PR #79). Клонът носи **цялата функционалност** от край до край — чат и инструменти,
тристепенен read-only SQL guard, справки с обвързани стойности + дедуп, RAG, глас, dock UI и HMAC подпис на
транскрипта — не само backend милъстоуна. Единственото останало е **provisioning-ът** на Cloudflare
ресурсите (`ASSISTANT_API_KEY` + bindings; runbook: [`docs/deploy-assistant.md`](../../../../../docs/deploy-assistant.md))
плюс caveat-ите в „Какво остава".

## Какво има (имплементирано)

- **Чат + агент** — stateless route `/assistant/chat` → agent loop (`agent.ts`, Vercel AI SDK glue към
  BgGPT/mamay през AI Gateway, `streamText`) → tool registry (`tools.ts`, SDK-агностичен) с 9 инструмента:
  `run_sql`, `semantic_search`, `find_entity`, `eop_fetch`, `describe_schema`, `source_link`,
  `reconcile_rollup`, `emit_report`, `answer_directly`.
- **Тристепенен read-only SQL guard** (§9.4) — `sql-guard.ts` (L1 структурен + LIMIT + byte cap) +
  `sql-ast-guard.ts` (L2 AST: table-allowlist, забрана на comma cross-join/`WITH RECURSIVE`, AST-достоверен
  LIMIT) + `sql-opcode-guard.ts` (L3 EXPLAIN-opcode проверка на живия binding — физическа, не parser-trust).
- **Справки, владени от сървъра** — `report-schema.ts`/`emit-report-schema.ts`/`render-format.ts`;
  стойностите се обвързват сървърно (§9.1, виж по-долу), проза/data-cells markdown-санитизирани; неизменни
  артефакти в R2 + `/reports/:id` (`noindex`); дедуп + single-flight (`ReportSingleFlight` DO, ADR-0007/0010).
- **RAG** (ADR-0008) — `rag.ts`: schema-grounding (`ns: 'schema'`) + `semantic_search`, през Workers AI
  (bge-m3, 1024 dims) + Vectorize.
- **Глас** (ADR-0013) — `/assistant/transcribe` → BgGPT STT primary + Workers AI Whisper fallback;
  `useVoiceInput.ts`.
- **Dock UI** — `lib/assistant-dock/*`: глобален dock, renderer на `emit_report` → компонентите на сайта +
  `timeseries`, chat карти, воден знак „AI-генерирано, неофициално" + показан въпрос (§9.12).
- **Интегритет на транскрипта** — HMAC подпис (§9.3, ADR-0011/0012), fail-closed на prod/staging.
- **Abuse controls** — Turnstile bot gate (§7/§8); per-IP rate-limit (`ASSISTANT_RATE_LIMITER` 1005,
  `TRANSCRIBE_RATE_LIMITER` 1006); акаунт-широк RPM circuit-breaker (`BgGptCircuitBreaker` DO, ADR-0009);
  `RUN_SQL_TIMEOUT_MS` + `D1_ROWS_READ_BUDGET` (Denial-of-Wallet, #122).

**Проверено @ HEAD:** `pnpm --filter web typecheck` → 0; **1223 теста** (assistant-scoped) преминават;
`pnpm audit --audit-level=high` чист; Prettier чист.

## Ключово решение: стойностите се владеят от сървъра (§9.1)

Сърцето на интегритета. Моделът **не пише числа** — `emit_report` блоковете _референцират_ хендъли към
резултатни множества, които сървърът реално е изпълнил, а `bindReport()` пре-свързва реалните стойности.
Таблиците взимат редовете изцяло от резултата, така че моделът не може да инжектира измислен ред или да
напише „12 млрд." вместо „1,2 млрд." — векторът за клевета от
[architecture.md](../../../../../docs/architecture.md) §3. Само `text`/`callout` носят авторска проза и
са markdown-санитизирани (без raw HTML → затваря stored-XSS на публичния `/reports/:id`).

## RAG — добавка спрямо спецификацията

Спецификацията е **text→SQL агент с инструменти, БЕЗ векторно извличане.** RAG е добавен нарочно на двете
места с най-голяма полза при по-малкия BgGPT модел: (1) **grounding на схемата** — извлича най-релевантните
trap-правила и примерни заявки за конкретния въпрос в системния prompt (retrieval-augmented формата на §9.2);
(2) **`semantic_search`** — допълва FTS за парафрази/синоними. Прието като част от v1 (ADR-0008); пада обратно
до статичния `describeSchema()`, когато индексът е празен.

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
upstream), `TURNSTILE_SECRET`, `ASSISTANT_HMAC_KEY` (§9.3 подпис на транскрипта, ADR-0011/0012 — CI го генерира
идемпотентно през `scripts/ensure-worker-secret.mjs`; на prod/staging gate-ът е **fail-closed** без него). CI
ползва и `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SIGMA_D1_ID`, `SIGMA_DEDUP_KV_ID`.

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

**Преди прод ключа — само инфра.** `run_sql` минава през тристепенния read-only guard по-горе (структурен
L1 + AST L2 + EXPLAIN-opcode на живия binding L3, fail-closed при всеки write opcode — физическо, не
parser-trust), а акаунт-широкият RPM таван **е наложен** (`BgGptCircuitBreaker` DO, ADR-0009). Остава само
**инфра**: физически read-only D1 binding (реплика/read-only credential, #134) като последен backstop под
код-guard-а. Дотогава защитата е код-ниво — дръжте прод `ASSISTANT_API_KEY` незададен, докато
provisioning-ът не е пълен.

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

- **Provisioning** — Cloudflare ресурсите/секретите по-горе, за всяка среда; пълен runbook:
  [`docs/deploy-assistant.md`](../../../../../docs/deploy-assistant.md). Мастер gate-ът `ASSISTANT_ENABLED`
  държи маршрута тъмен до go-live (§8).
- **Физически read-only D1** (#134) — код-guard-ът е тристепенен и наложен; остава отделен физически
  read-only D1 binding като инфраструктурен backstop (не блокира функцията, само хардунирането).
- **`semantic_search` — `ns: 'entity'` е празен** докато не се добави entity indexer (ETL, Фаза 2).
  Инструментът е регистриран и работи, но `semantic_search` ще връща 0 попадения за всяко запитване, докато
  pipeline-ът не напълни Vectorize с имена на компании/договори/възложители (schema-grounding-ът, `ns:
'schema'`, работи).
- **Runtime срещу живи облачни bindings** — чистите модули + agent loop-ът са unit- и typecheck-покрити;
  end-to-end срещу реален D1/Vectorize/AI Gateway се проверява на dev/preview, не в CI.
