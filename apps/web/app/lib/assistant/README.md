# AI асистент — имплементация

Наша имплементация на [`docs/spec/ai-assistant.md`](../../../../../docs/spec/ai-assistant.md),
включително хардунирането от **§9** (PR #79). Backend-ът на асистента е **опроводен от край до край в
кода**: чистите тествани модули → tool registry → agent loop → ресурс route-а `/assistant/chat`.
Остават потребителските части (dock UI, renderer на справките и `/reports/:id`, глас) и provisioning-ът
(`BGGPT_API_KEY` + bindings) — виж „Какво остава".

## Какво има (имплементирано)

| Файл                        | Роля                                                          | Спец.        | Проверка  |
| --------------------------- | ------------------------------------------------------------- | ------------ | --------- |
| `report-schema.ts`          | Block речник + **сървърно обвързване на стойностите**         | §4, §9.1, §7 | unit      |
| `sql-guard.ts`              | Read-only структурен guard + LIMIT + byte cap                 | §7, §9.4     | unit      |
| `sql-ast-guard.ts`          | Read-only **AST guard** (node-sql-parser, fail-closed)        | §9.4         | unit      |
| `describe-schema.ts`        | Куриран речник на данните с капаните                          | §9.2         | unit      |
| `rag.ts`                    | Vectorize + Workers AI RAG (grounding + semantic search)      | _добавка_    | unit      |
| `system-prompt.ts`          | emit-report политика, values-by-reference, data-trust, скелет | §4/§7/§9.10  | unit      |
| `tool-results.ts`           | D1 редове → хендълнат `QueryResult`                           | §7           | unit      |
| `eop-fetch.ts`              | `eop_fetch` — валидация + fixed base (no SSRF) + cap          | §9.7         | unit      |
| `source-link.ts`            | Официални линкове (ЦАИС ЕОП) за цитиране                      | §3           | unit      |
| `emit-report-schema.ts`     | Структурна валидация + model-facing JSON Schema               | §4           | unit      |
| `render-format.ts`          | format-by-hint + entity-ref линкове                           | §4           | unit      |
| `tools.ts`                  | Tool registry (SDK-агностичен) + `finalizeReport`             | §2/§3        | unit      |
| `agent.ts`                  | Vercel AI SDK glue: BgGPT през AI Gateway + `streamText`      | §2/§9.5      | typecheck |
| `routes/assistant.chat.tsx` | Stateless chat ресурс route                                   | §2/§5        | typecheck |

**Проверено:** `pnpm --filter web typecheck` → 0; **127 теста** преминават; `pnpm audit --audit-level=high`
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
Докато бекендът не е напълно осигурен, `/assistant/chat` връща контролирано **503**, а грешка по време на
streaming се показва като четим текст — не като счупена връзка или 500 (graceful degradation, §7).

## Какво остава

- **Фаза 2 — потребителски слой:** глобален dock (`useChat`); renderer `emit_report` → компонентите на
  сайта + нов `timeseries`; `/reports/:id`, chat карти, индекс `/reports`; воден знак „AI-генерирано,
  неофициално" + показан въпрос (§9.12); достъпни таблици-алтернативи за SVG блоковете (§9.6).
- **Фаза 2 — устойчивост (преместено по-рано по бележка от #80):** rate-limiting + circuit-breaker /
  exponential backoff пред BgGPT — асистентът удря модела при всяка заявка, така че пик на трафика или
  отпадане на BgGPT не бива да стига до потребителя като грешка. v1 вече има базова graceful degradation
  (`onError` по време на streaming + 503 при setup) и clamp на `MAX_STEPS` към [1, 20]; пълният
  лимитер/прекъсвач е следващата стъпка тук.
- **Фаза 3:** глас (`/assistant/transcribe` → Whisper).
- **Втвърдяване:** read-only D1 data path за `run_sql` — отделен binding без write права, последният
  §9.4 слой (AST guard-ът вече е имплементиран в `sql-ast-guard.ts` след ревюто на #80); HMAC-подпис на
  сървърните съобщения (§9.3); memoize `(sql_hash, freshness)` + дедуп на справки (§9.8); golden-report
  CI, вкл. adversarial prompt-injection (§9.9); launch gate (Turnstile).
