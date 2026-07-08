# AI асистент — имплементация

Наша имплементация на [`docs/spec/ai-assistant.md`](../../../../../docs/spec/ai-assistant.md),
включително хардунирането от **§9** (PR #79). Backend-ът на асистента е **опроводен от край до край в
кода**: чистите тествани модули → tool registry → agent loop → ресурс route-а `/assistant/chat`.
Остават потребителските части (dock UI, renderer на справките и `/reports/:id`, глас) и provisioning-ът
(`BGGPT_API_KEY` + bindings) — виж „Какво остава".

## Какво има (имплементирано)

| Файл                        | Роля                                                           | Спец.        | Проверка  |
| --------------------------- | -------------------------------------------------------------- | ------------ | --------- |
| `report-schema.ts`          | Block речник + **сървърно обвързване на стойностите**          | §4, §9.1, §7 | unit      |
| `sql-guard.ts`              | Read-only структурен guard + LIMIT + byte cap                  | §7, §9.4     | unit      |
| `sql-ast-guard.ts`          | AST guard: read-only + table allowlist + no-cross-join + LIMIT | §9.4         | unit      |
| `describe-schema.ts`        | Куриран речник на данните с капаните                           | §9.2         | unit      |
| `rag.ts`                    | Vectorize + Workers AI RAG (grounding + semantic search)       | _добавка_    | unit      |
| `system-prompt.ts`          | emit-report политика, values-by-reference, data-trust, скелет  | §4/§7/§9.10  | unit      |
| `tool-results.ts`           | D1 редове → хендълнат `QueryResult`                            | §7           | unit      |
| `eop-fetch.ts`              | `eop_fetch` — валидация + fixed base (no SSRF) + cap           | §9.7         | unit      |
| `source-link.ts`            | Официални линкове (ЦАИС ЕОП) за цитиране                       | §3           | unit      |
| `emit-report-schema.ts`     | Структурна валидация + model-facing JSON Schema                | §4           | unit      |
| `render-format.ts`          | format-by-hint + entity-ref линкове                            | §4           | unit      |
| `tools.ts`                  | Tool registry (SDK-агностичен) + `finalizeReport`              | §2/§3        | unit      |
| `agent.ts`                  | Vercel AI SDK glue: BgGPT през AI Gateway + `streamText`       | §2/§9.5      | typecheck |
| `routes/assistant.chat.tsx` | Stateless chat ресурс route                                    | §2/§5        | typecheck |

**Проверено:** `pnpm --filter web typecheck` → 0; **150 теста** преминават; `pnpm audit --audit-level=high`
чист; Prettier чист. Чистите модули са unit-тествани и deploy-независими; agent loop-ът и route-ът са
typecheck-проверени, но **не са runtime-проверени** (няма `BGGPT_API_KEY` / облачни bindings в тази среда).

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

## ⚠️ Provisioning gate (трябва да предхожда `wrangler deploy`)

Това PR добавя bindings към Cloudflare ресурси, които трябва да **съществуват преди deploy** — иначе
`wrangler deploy` се проваля и блокира CD за целия екип (бележка от ревюто на #80). Преди мърдж/deploy на
средата с асистента осигурете: `BGGPT_API_KEY` (secret, `wrangler secret put`), Vectorize индекс
`sigma-assistant`, R2 кофа `sigma-reports`, и еднократно индексиране на схема-корпуса (`indexSchemaCorpus`).

```bash
# Веднъж на средата, ПРЕДИ `wrangler deploy` (иначе deploy-ът пада и блокира CD на целия екип):
wrangler vectorize create sigma-assistant --dimensions=1024 --metric=cosine  # ТРЯБВА 1024/cosine (bge-m3) — грешни размери чупят RAG
wrangler r2 bucket create sigma-reports
wrangler secret put BGGPT_API_KEY                                            # интерактивно; никога не се комитва
# `AI` (Workers AI) не изисква създаване на ресурс — account capability; включи Workers AI за акаунта.
# След като индексът съществува, еднократно: indexSchemaCorpus(env.AI, env.VECTORIZE) пълни схема-корпуса.
```

Докато бекендът не е напълно осигурен, `/assistant/chat` връща контролирано **503**, а грешка по време на
streaming се показва като четим текст — не като счупена връзка или 500 (graceful degradation, §7).

**Блокиращо преди прод ключ:** route-ът изпълнява `run_sql` в момента, в който `BGGPT_API_KEY` е наличен,
а D1 binding-ът все още е read-write. Затова НЕ задавайте прод `BGGPT_API_KEY`, докато (1) `run_sql` не
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
