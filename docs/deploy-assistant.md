# Пускане на AI асистента — provisioning и env

Този документ покрива **само** слоя, който AI асистентът (`/assistant/*`) добавя над базовия
деплой. Базата — двата Worker-а (`sigma`, `sigma-etl`), споделеният D1, R2 кешът на explorer-а
(`sigma-csv-cache`), API token-ът и GitHub Environments — е в [`deploy.md`](deploy.md) и
[`dev-environments-setup.md`](dev-environments-setup.md); тук не се повтаря.

Асистентът живее в Worker-а **`sigma`** (`apps/web`). Всичко по-долу се прави **за всяка среда**
(production, staging, dev/preview). Принципът е същият като в `deploy.md`: committ-натите `wrangler.*`
държат нулеви/празни dummy стойности, а реалните идентификатори и имена идват от env променливи в
момента на деплой ([`scripts/wrangler-render.mjs`](../scripts/wrangler-render.mjs)) — едно и също дърво
се деплойва към произволен акаунт без редакция на файлове.

> **Fail-closed по подразбиране.** Без `AI_GATEWAY_BASE_URL` асистентът връща `503`; без
> `TURNSTILE_SECRET` — `403`; без `ASSISTANT_API_KEY` — `503`. Затова непълен provisioning не пуска
> грешни отговори — просто спира ендпойнта. `ASSISTANT_ENABLED` остава `"false"` до последната стъпка.

## 0. Предпоставки

Базовият деплой от [`deploy.md`](deploy.md) е минат: D1 `sigma` е provision-нат и seed-нат, R2
`sigma-csv-cache` съществува, API token-ът и GitHub Environment-ите са настроени. API token-ът трябва
да носи допълнително **Vectorize:Edit**, **Workers R2 Storage:Edit** (за `sigma-reports`) и
**AI Gateway:Edit** (за custom provider-ите). Асистентът чете D1 в **read-only** режим (виж §6).

## 1. Cloudflare ресурси (еднократно, за всяка среда)

| Ресурс | Binding | Provisioning |
|---|---|---|
| **Vectorize** индекс `sigma-assistant` | `VECTORIZE` | `wrangler vectorize create sigma-assistant --dimensions=1024 --metric=cosine` — 1024 = `@cf/baai/bge-m3` ([`rag.ts`](../apps/web/app/lib/assistant/rag.ts) `EMBED_MODEL`). Име per-env чрез `SIGMA_VECTORIZE_NAME`. |
| **R2** bucket `sigma-reports` | `REPORTS` | `wrangler r2 bucket create sigma-reports` (или [`scripts/bootstrap-r2.mjs`](../scripts/bootstrap-r2.mjs)). Съхранява генерираните справки. Име per-env чрез `SIGMA_REPORTS_NAME`. |
| **KV** namespace (dedup) | `DEDUP_KV` | `node scripts/ensure-kv-namespace.mjs --apply` (идемпотентно) → `SIGMA_DEDUP_KV_ID`. Freshness-валидиран кеш на справките (L0–L2.5). |
| **Workers AI** | `AI` | Само акаунтът да има Workers AI. Ползва се за RAG embeddings (`bge-m3`) **и** за Whisper fallback-а на гласа. Без provisioning. |
| **AI Gateway** `sigma-assistant` + провайдъри | — (чрез `AI_GATEWAY_*`) | Виж §2. `wrangler` **не** управлява AI Gateway. |
| **Durable Objects** `ReportSingleFlight`, `BgGptCircuitBreaker` | `REPORT_SINGLE_FLIGHT`, `BGGPT_CIRCUIT_BREAKER` | **Автоматично при деплой** през migrations `v1`/`v2` в `wrangler.jsonc`. Без ръчна стъпка. |
| **Rate limiters** `ASSISTANT_RATE_LIMITER` (1005, 10/60s), `TRANSCRIBE_RATE_LIMITER` (1006, 5/60s) | — | Само конфигурация в `wrangler.jsonc`. Без provisioning. |

## 2. AI Gateway (задължителен — целият моделен трафик минава оттук)

Gateway `sigma-assistant`, споделен между чат и глас, с два custom провайдъра към BgGPT
(`https://api.bggpt.ai`). `wrangler` не го докосва — provisioning-ът е през account-scoped REST API
(token с **AI Gateway:Edit**):

1. **Gateway** `sigma-assistant` — създай веднъж (dashboard или REST). Скриптовете само проверяват, че
   съществува; никога не пипат настройките му, за да не се клобърне чатът.
2. **Чат провайдър** `bggpt` → URL сегмент `custom-bggpt` — upstream `https://api.bggpt.ai`.
   Пълният път е `.../{gateway}/custom-bggpt/v1` (виж `AI_GATEWAY_BASE_URL`).
3. **Гласов провайдър** `bggpt-voice` → URL сегмент `custom-bggpt-voice`:
   `node scripts/ensure-voice-provider.mjs --apply` (dry-run без `--apply`). Виж
   [ADR-0013](adr/0013-voice-via-ai-gateway.md) защо провайдър-endpoint, а не dynamic route.
4. **Whisper fallback** — вграденият провайдър `workers-ai`, без provisioning.

## 3. Тайни (secrets)

За Worker-а `sigma`. В CI четирите основни се задават от GitHub secrets през
[`scripts/ensure-worker-secret.mjs`](../scripts/ensure-worker-secret.mjs); ръчно —
`wrangler secret put <NAME> --name sigma`. **Никога не се committ-ват** (виж [`AGENTS.md`](../AGENTS.md)).

| Secret | Задължителен | Роля |
|---|---|---|
| `ASSISTANT_API_KEY` | да | Ключ за чат-модела (BgGPT). Липсва → чатът връща `503`. |
| `ASSISTANT_HMAC_KEY` | да | Подпис на транскрипта (§9.3 / [ADR-0011](adr/0011-transcript-hmac-signing.md), [ADR-0012](adr/0012-transcript-hmac-enforcement.md)). |
| `TURNSTILE_SECRET` | да | Сървърна проверка на Turnstile. Липсва → `403`. |
| `LOG_IP_KEY` | да | HMAC на IP в лога на заявките (поверителност). |
| `VOICE_ASSISTANT_API_KEY` | опц. (глас) | Ключ за гласовия STT провайдър. **При липса пада към `ASSISTANT_API_KEY`.** |
| `ASSISTANT_HMAC_KEY_PREVIOUS` | опц. | Стар HMAC ключ по време на ротация (dual-verify прозорец). Ръчно. |
| `ASSISTANT_SEED_TOKEN` | опц. | Пази `POST /assistant/reindex` (§5). Задай ръчно само ако seed-ваш през HTTP. |

## 4. Променливи (vars)

Два механизма — не ги смесвай:

**А. `SIGMA_`-префиксни CI променливи**, рендерирани от `wrangler-render.mjs` в момента на деплой:

| CI var | → binding/var | Стойност |
|---|---|---|
| `SIGMA_ENVIRONMENT` | `ENVIRONMENT` | `production` / `staging` / `preview` / `development` — управлява fail-closed на HMAC (§6). |
| `SIGMA_ASSISTANT_ENABLED` | `ASSISTANT_ENABLED` | `"false"` до go-live, после `"true"`. |
| `SIGMA_VECTORIZE_NAME`, `SIGMA_REPORTS_NAME`, `SIGMA_DEDUP_KV_ID`, `SIGMA_D1_ID` | имена/id на ресурсите | от §1. |

**Б. Директни `vars` в `wrangler.jsonc`** (операторът ги задава — **не** са `SIGMA_`-рендерирани;
committ-нати празни в upstream):

| Var | Стойност | Бележка |
|---|---|---|
| `AI_GATEWAY_BASE_URL` | `https://gateway.ai.cloudflare.com/v1/<account-id>/sigma-assistant/custom-bggpt/v1` | **Задължителна, fail-closed** (празна → `503`). |
| `AI_GATEWAY_ID` | `sigma-assistant` | Gateway slug; рутира и RAG embeddings-ите. |
| `BGGPT_STT_BASE_URL` | `https://gateway.ai.cloudflare.com/v1/<account-id>/sigma-assistant/custom-bggpt-voice` | Гласов lane. |
| `ASSISTANT_MODEL` | напр. `bggpt-gemma4-31b-it-bg-gptq-w4a16` | Смяна на модел = само този ред. |
| `TURNSTILE_SITE_KEY` | публичният site key | Widget-ът. |
| `BGGPT_RATE_LIMIT_RPM` | напр. `120` | Акаунт-wide таван на платените BgGPT turns (`BgGptCircuitBreaker`). |
| `MAX_STEPS` / `RUN_SQL_TIMEOUT_MS` / `D1_ROWS_READ_BUDGET` | `6` / `10000` / `5000000` | Предпазители на агента; имат разумни стойности по подразбиране. |

> `ENVIRONMENT` идва **само** от runtime binding-а, а не от `import.meta.env.PROD` (Vite го inline-ва в
> build-time и е грешен за multi-env Worker). В `production`/`staging` HMAC gate-ът е **fail-closed**
> (отхвърля неподписан/фалшифициран транскрипт); в `preview`/`development` — fail-open.

## 5. Ред на пускане

1. Базов деплой минат (§0).
2. Създай асистент-ресурсите (§1) и AI Gateway провайдърите (§2).
3. Задай тайните (§3) и променливите (§4). Дръж `SIGMA_ASSISTANT_ENABLED="false"`.
4. **Деплой** → DO migrations `v1`/`v2` се прилагат автоматично.
5. **Seed на Vectorize:** `POST /assistant/reindex` с `Authorization: Bearer <ASSISTANT_SEED_TOKEN>` —
   (пре)ембедва статичния речник на данните в индекса `sigma-assistant`
   ([`seed-endpoint.ts`](../apps/web/app/lib/assistant/seed-endpoint.ts)). Без seed RAG-ът е празен.
6. Smoke-тест при изключен асистент (маршрутът е disabled), после **вдигни
   `SIGMA_ASSISTANT_ENABLED="true"` и предеплойни**.

## 6. Проверка

- Без `AI_GATEWAY_BASE_URL` → `POST /assistant/chat` дава `503` (fail-closed на gateway-а).
- Без валиден Turnstile token → `403` и на `/assistant/chat`, и на `/assistant/transcribe`.
- В `production`/`staging` неподписан транскрипт се отхвърля (HMAC fail-closed); в `preview` минава.
- След §5.5 повторно `reindex` е идемпотентно; `semantic_search` връща релевантни чънкове.
- Отговорите носят `Cache-Control: no-store`; справките (`/reports/*`) са `noindex`.

## Свързани / предстоящи (infra follow-ups)

Не блокери за първо пускане, но да се проследят като infra:

- **Read-only D1 credential** (`DB_RO`, #134) — асистентският `run_sql` минава през тристепенен guard,
  но физическият backstop е отделен read-only binding. Днес защитата е код-ниво (allowlist на
  opcodes/таблици/функции).
- **R2 retention/erasure** на `sigma-reports` (PRIV-2) и per-env bucket изолация.
- Аудит-лог и Vectorize integrity — виж [`spec/ai-assistant.md`](spec/ai-assistant.md) §9.
