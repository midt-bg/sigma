# ADR-0002 — Интеграционно тестване на маршрутите и SSR Worker-а в `apps/web`

- **Статус:** Прието (в обхвата на issue `#94`)
- **Обхват:** Итерация 1 — публичният, read-only explorer на обществените поръчки (АОП). Документът фиксира единната тест-архитектура за „интеграционната лента“ на `apps/web`: HTTP заявка, която се изпраща през истинския SSR Worker pipeline (`apps/web/workers/app.ts`), минава през реалните Cloudflare binding-и (`DB`, `CSV_RATE_LIMITER` и др.) и се асъртва срещу seeded D1 данни.

> **Актуализация:** Документът е първоначалният ADR за интеграционния стек. Решенията за rendering (§2 в [`architecture.md`](architecture.md)) и сигурност (§3 там) остават непроменени; добавя се само един допълнителен тестов слой.

## Контекст

Преди тази итерация `apps/web` имаше **само unit тестове**: отделни файлове (`*.test.ts`) до производствения код, които внасят функциите директно и ги извикват с фалшиви аргументи. Това покрива чистите помощни функции (`csv-rate-limit.ts`, `csp.ts`, `cache-key.ts`) и заявките на `packages/db`, но **не покрива**:

1. **Реалния SSR Worker pipeline** — модулът `apps/web/workers/app.ts` има нелинейна `fetch` оркестрация (rate-limit guards, edge cache `caches.default`, security headers през `hardenResponse`, React Router `createRequestHandler`, per-request nonce CSP). Тази оркестрация не се изпълнява в нито един от unit тестовете и не беше възможно да се асъртва енд-до-нд преди тази итерация.
2. **Header контракта на маршрутите от issue `#94`** — `Content-Type` per route, security header set (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-*`), HSTS и CSP в production, `X-Edge-Cache: MISS|BYPASS`, `Content-Disposition` за CSV exports.
3. **Реалния rate-limiter** — unit тестовете на `csv-rate-limit.ts` стъбват функцията, но пълният pipeline (`req → routing → handler → 429`) минава през истинския Cloudflare `ratelimit` binding от `wrangler.jsonc`.
4. **Pagination regression за issue `#87`** — keyset функцията в `packages/db/src/queries/keyset.ts` е покрита от unit тест, но SSR рендирането на `?cursor=…` връзката в `PageNav` компонента не е.

Issue `#94` поиска работна интеграционна лента за `/search`, `/companies`, `/authorities`, `/contracts`, детайл на договор + JSON, `/contracts.csv` и всички sitemap/robots маршрути.

Три въпроса стояха в основата на решението:

1. Как да качим реалния Worker в Node, за да тестваме реалния request pipeline?
2. Как да осигурим „достатъчно истински“ Cloudflare binding-и (`DB`, ratelimit, R2, AI, Vectorize), без да вдигаме `wrangler dev` като отделен процес?
3. Как да изолираме тестовете един от друг (rate-limit state, D1 данни), без CI-то да е крехко?

## Решение

### 1. Vitest worker mode + `wrangler.getPlatformProxy({ persist: false })`

Интеграционните тестове се изпълняват в **Vitest с `environment: 'node'`**, а **Cloudflare binding-ите** се доставят от `wrangler.getPlatformProxy({ configPath: 'apps/web/wrangler.jsonc', persist: false, remoteBindings: false })`. Минифлейърът на `wrangler` вдига вградена симулация на D1, R2, KV, Vectorize, Queues, AI, и четирите `ratelimit` binding-а и ги слага на `proxy.env` + `proxy.caches` + `proxy.ctx`. `persist: false` означава, че D1 е **напълно в паметта** — всеки извиквяне на `getPlatformProxy` стартира свеж D1, без да оставя файлов отпечатък.

Избрано пред `@cloudflare/vitest-pool-workers` (който върти истински workerd isolate на тестов worker pool): последният е по-верен на продукцията, но добавя нов runtime зависимост и отделен vitest конфиг файл, който в момента не е наличен в еталонната конфигурация на framework-а. За обхвата на `#94` (route-level smoke + header contract + rate-limit + pagination regression) локалното минифлейър изпълнение е достатъчно.

### 2. Polyfill за `caches` глобалния

`apps/web/workers/app.ts:29` чете `caches.default` **at module-init time**. Под Vitest с `environment: 'node'` `globalThis.caches` е `undefined` и module-import хвърля `ReferenceError`. Инсталираме минимален `PolyfillCacheStorage` (`~50` реда) на `globalThis.caches` **преди** първият тест да импортне `workers/app.ts`. Полифилът:

- Има `default` getter, `open`, `match`, `put`, `delete`, `keys`, `matchAll`.
- Съхранява записи в `Map<Request, Response>` по URL.
- Използва се за **първата заявка** (`X-Edge-Cache: MISS|BYPASS`) — това, което `#94` всъщност покрива.

**HIT-on-second-request е умишлено извън обхвата** на тази лента: `cache.match` през полифилния `CacheStorage` не прави round-trip като workerd isolate (няма isolate boundary в Node процеса). Ако в бъдеще екипът мигрира към `@cloudflare/vitest-pool-workers`, този assertion може да се върне — засега `apps/web/workers/app.cache.test.ts` покрива `hardenResponse`'s cacheable branch в изолация.

### 3. Ръчна стъпка за миграциите

`wrangler.getPlatformProxy({ configPath })` **не** извиква `wrangler d1 migrations apply` — applier-ът живее в CLI командата и не е експортнат от `wrangler` (проверено в `cli.d.ts:3540`). Това означава, че свеж D1 стартира с **0 таблици**.

Допълнително, `proxy.env.DB.exec(...)` **не приема** миграционните файлове директно (`packages/db/migrations/0000_init.sql`): не приема SQL, започващ с `--` line comment-и, и не приема многоредови `CREATE TABLE (...)`. Затова `apps/web/test/integration/setup.ts` имплементира **минимален SQL препроцесор** (~30 реда, без нови зависимости): strip-ва `--` line-ове, collapse-ва whitespace, сплит-ва по `;` (с коректно третиране на string literals) и пуска `DB.exec(statement)` за всеки отделен statement.

С тази стъпка `0000_init.sql` + `0001_flow_pairs_bidder_index.sql` се прилагат и създават 23 таблици + 46 индекса (включително `search_index` FTS5 virtual table и неговите shadow таблици) преди фикстурата.

### 4. `@react-router/dev/vite`'s `reactRouter()` plugin в отделен vitest проект

За да може React Router loader-ите да се резолвват под vitest (защото `workers/app.ts` импортва `virtual:react-router/server-build`), интеграционният проект трябва да зареди `@react-router/dev/vite`'s `reactRouter()` plugin. Затова:

- `apps/web/vitest.config.ts` (unit проект) остава **без** `reactRouter()` — тестовете за чисти функции не се нуждаят от него.
- `apps/web/vitest.integration.config.ts` (integration проект) зарежда `reactRouter()` + `@tailwindcss/vite` плюс `setupFiles: ['./test/integration/polyfills.ts']`.
- `apps/web/vitest.workspace.ts` обединява двата проекта в един root и `pnpm --filter @sigma/web test` върви през `vitest run --config vitest.workspace.ts`.

Допълнителна настройка: `ssr.noExternal: ['@opentelemetry/api', 'ai', '@ai-sdk/openai']` плюс `resolve.alias` записи заобикаля `@opentelemetry/api@1.9.1` ESM билд проблем — extension-less relative imports (`./baggage/utils`), които Node 24 strict loader отхвърля. Alias-ите се смятат относително спрямо repo root-а, не към локален абсолютен checkout път, за да работят в CI и на други машини.

### 5. Seed-ната D1 фикстура — 30 реда

`apps/web/test/integration/global-setup.ts` (vitest `globalSetup`) и/или `setup.ts` (lazy per-test-file bootstrap) имплементират малка, **повторяема** фикстура:

- 1 authority (`auth:BG000000000`), 1 bidder (`eik:BG000000001`), 1 tender (`t:FIX-1`).
- 30 договора в `contracts` с **строго намаляващ** `amount_eur` (`1000+30`, `2000+29`, …, `30000+1`), за да може pagination regression-а да асъртва monotone decreasing стойности.
- По 1 ред в `home_totals`, `authority_totals`, `company_totals`, `data_freshness` — за да има смислена първа страница за `sitemap-authorities.xml`, `sitemap-companies.xml` и `/`.
- `INSERT OR IGNORE` навсякъде — фикстурата е идемпотентна и не чупи повторни пускания в рамките на един worker process.

### 6. Isolация и конкурентност

- **Между worker processes (vitest `vmThreads` / `forks`)**: всеки test file върви в собствен worker thread, `wrangler.getPlatformProxy({ persist: false })` се извиква **per-file lazy** в `setup.ts` (не глобално). Двата worker thread-а получават два независими D1 binding-а — нулево cross-talk. Глобалният `globalSetup` (ако е конфигуриран) е **оптимизация** (стартира прокси по-рано), но setup.ts е проектиран да работи и без него — bootstrap-ът е идемпотентен в рамките на worker process.
- **В рамките на един worker process**: rate-limit binding-ите споделят in-memory state между `appFetch` calls. За burst теста (CSV 11-и call = 429) `__resetSigmaProxyForTesting()` dispose-ва проксито и принуждава **свежа** bootstrap-ване за следващия тест. Използва се само там, където е необходимо.
- **Между извикванията на `app.default.fetch`**: всеки тест сетва отделен `CF-Connecting-IP` от RFC 5737 документацията (`203.0.113.10`, `203.0.113.11`, …) — IP-key derivation-ът в `csv-rate-limit.ts` взима точно тази стойност, и всеки тест получава самостоятелен bucket.

### 7. Обхват на тестовете

| Файл | Какво покрива |
| --- | --- |
| `apps/web/test/integration/setup.ts` | `appFetch(request)` помощна функция; lazy `getPlatformProxy({ persist: false })`; SQL препроцесор за миграциите; 30-редова фикстура |
| `apps/web/test/integration/global-setup.ts` | vitest `globalSetup` — алтернативен bootstrap (по-ранен), но setup.ts е проектиран да работи самостоятелно |
| `apps/web/test/integration/polyfills.ts` | vitest `setupFiles` — инсталира `PolyfillCacheStorage` на `globalThis.caches` преди `import 'workers/app'` |
| `apps/web/test/integration/helpers/headers.ts` | `assertCommonSecurity`, `assertHtmlContentType`, `assertSitemapContentType`, `assertTextPlainContentType`, `assertEdgeCacheFirstRequest` |
| `apps/web/test/integration/routes.test.ts` | 13 маршрута от issue `#94` — status + security headers + Content-Type + `X-Edge-Cache: MISS|BYPASS` |
| `apps/web/test/integration/sitemaps.test.ts` | `/sitemap.xml`, `/sitemap-pages.xml`, `/sitemap-contracts.xml`, `/sitemap-companies.xml`, `/sitemap-authorities.xml`, `/robots.txt` — отделни тестове с проверка на `<urlset>`, `<loc>` елементи |
| `apps/web/test/integration/contracts-detail-json.test.ts` | `/contracts/1` (HTML) + `/contracts/1.json` (JSON:200 + Content-Type:application/json) |
| `apps/web/test/integration/rate-limit.csv.test.ts` | 11 successive `GET /contracts.csv` → първите 10 = 200 или документирания dev-mode 500, 11-и = 429 с `Retry-After: 60` и `Too many CSV export requests` body |
| `apps/web/test/integration/contracts-pagination.test.ts` | SSR cursor extraction → следваща страница → disjoint ids + monotone decreasing `amount_eur` |
| `apps/web/test/integration/contracts-csv.test.ts` | Defensive: worker-ът достига до `/contracts.csv` route-а, очаквани Content-Type / Cache-Control / `X-Edge-Cache` headers; пълният streaming body parse остава извън обхвата на dev-mode лентата |
| `apps/web/test/integration/edge-cache.test.ts` | Първата заявка за cacheable route → `X-Edge-Cache: MISS\|BYPASS`; HIT-on-second-request е умишлено извън обхвата |

### 8. Как се пуска

```bash
# Unit проект (без integration)
pnpm --filter @sigma/web test:unit

# Integration проект (route + Worker pipeline)
pnpm --filter @sigma/web test:integration

# Двата едновременно (CI gate)
pnpm --filter @sigma/web test

# Typecheck (независимо)
pnpm --filter @sigma/web typecheck
```

## Алтернативи, които разгледахме

### A. `@cloudflare/vitest-pool-workers`

Идеалният вариант: виртуални workerd isolates вътре във vitest worker pool — реален runtime, истинска `caches`, истинска isolate-isolated state.

**Защо не е избран:** добавя още една зависимост и изисква допълнителен vitest конфиг (`vitest.config.workers.ts`), който в момента не присъства в `apps/web/vitest.config.ts`. За `#94` функционалният обхват (route smoke + headers + rate-limit + pagination regression) е покрит и от `getPlatformProxy`-базираната лента. **Условие за връщане:** ако екипът започне да удря несъответствия между Node polyfill-а и production isolate-а (например CSP/Headers разлики, isolate-local state-несъответствия), миграцията е оправдана.

### B. Mock-ване на `caches.default` глобалния

Алтернативно на `PolyfillCacheStorage` можехме просто да дефинираме `globalThis.caches = {}` и ръчно да направим един `Map` за `X-Edge-Cache` асършъните.

**Защо не е избран:** `app.ts:29` прави `const edgeCache = caches.default;` at module-init, а по-късно `edgeCache.match(key)` / `edgeCache.put(key, response)`. С празен `{}` модул-import ще хвърли, а с ръчно patch-нат `Map` ще се наложи да се меси вътре в `app.ts` (анти-патърн — тестовете пипат продукционен код).

### C. Vitest pool `forks` вместо `vmThreads`

`vmThreads` (default) е по-бърз, но споделя повече state между worker-ите в рамките на един process. `forks` стартира Node subprocess за всеки test file.

**Защо не е избран:** `@cloudflare/vite-plugin` и `reactRouter()` двамата имат проблемно поведение върху `forks` pool (дълго зареждане на модулите на всеки fork, и при много тестове CI времето расте непропорционално). Пробата в Round 1 (`E-P1T1-008`) показа, че `@cloudflare/vite-plugin` изобщо не успява да се зареди в тест pool. С `vmThreads` и `persist: false` cross-talk рискът е премахнат на архитектурно ниво (всеки worker thread е отделен Node process от гледна точка на D1), а setup.ts вижда `globalThis` per-worker.

### D. `wrangler dev` като отделен процес + fetch от теста

Алтернативно: `beforeAll` стартира `wrangler dev` на друг порт и тестът прави `fetch` към него.

**Защо не е избран:** добавя shell-out, race conditions (трябва да чакаме `wrangler dev` да е готов), отделен лог-файл за грешки, и правене на тестовете зависими от network port-ове (flake-prone в CI). Предимството на `getPlatformProxy` е, че всичко е in-process, deterministic и self-contained.

### E. CSV streaming assertion (`/contracts.csv` end-to-end)

В Round 2 пробвахме `GET /contracts.csv` 200 + `text/csv` + body parse. През dev mode (`@react-router/dev` `devalue.stringify`) loader-ът връща `R2Object` от `env.CSV_CACHE.get(...)`, който не е POJO.

**Избор:** Деферирано. `servedCsvExport` unit тест + `csv-rate-limit` unit тест + integration rate-limit burst test покриват заедно рисковете — production build (`mode: 'production'`) заобикаля `devalue` изцяло, така че streaming CSV assertion ще влезе в бъдещ pre-built-mode integration lane (извън обхвата на `#94`).

### F. Edge cache HIT-on-second-request assertion

В Round 2 пробвахме `cache.put(req, res)` → `cache.match(req)` да върне hit. Полифилният `Map`-backed `CacheStorage` не прави round-trip както workerd isolate.

**Избор:** Деферирано. `apps/web/workers/app.cache.test.ts` unit тестът покрива upstream логиката; integration тестът асъртва първата заявка (`MISS|BYPASS`). Условие за връщане: миграция към `@cloudflare/vitest-pool-workers`.

### G. Wrangler `unstable_dev` (legacy runtime test API)

Cloudflare поддържа `wrangler.unstable_dev({ ... })` като runtime API за стартиране на работен процес — `unstable_` префиксът е индикация, че API-то е в движение (преди излизането на `getPlatformProxy`/`workerd` pool-овете). Тестът може да извика `await unstable_dev(...)` в `beforeAll`, да получи обратно `fetch`-подобен хендлър, и да прави истински HTTP заявки към реален workerd.

**Защо не е избран за текущата итерация:** `unstable_dev` стартира отделен `workerd` subprocess (или `miniflare` при по-стария stack), който **пише в `.wrangler/state/`** на диска и вдига D1/KV/R2 на реални файлове. Това създава директен конфликт с `pnpm dev` (`react-router dev`), който също разчита на същия `.wrangler/state/` за локалното dev seed — двата процеса не могат да държат заключен един и същ miniflare state без `wrangler dev --persist false` или подобно. Освен това `unstable_dev` изисква `await`-ване на readiness hooks и polling за да знаем кога binding-ите са налице, което е типичен източник на flaky CI. `getPlatformProxy({ persist: false })` (раздел 1) прави точно същото, но **in-process** — без subprocess, без `.wrangler/state/`, без lock-конфликти с `pnpm dev`. `unstable_dev` остава валиден избор, ако в бъдеще екипът иска пълен workerd runtime; условието за връщане е същото като при `@cloudflare/vitest-pool-workers`.

### H. Ръчно извикване на handler-ите без Worker pipeline

Алтернативно: bypass-ваме `workers/app.ts` и извикваме всеки route handler директно — `loader()`-ът на `routes/contracts.tsx` се тика с фалшив `Request` и се асъртва върху `Response`-а.

**Защо не е избран:** `apps/web/workers/app.ts` има нелинейна `fetch` оркестрация (`withRequestLog` → `handleRequest` → 4 поредни rate-limit guards → edge cache `caches.default.match/put` → `hardenResponse` → per-request nonce CSP → `X-Edge-Cache: HIT|MISS|BYPASS` хедър). Тези стъпки **не са** покрити от per-route handler тестовете. Issue `#94` изрично иска header contract за маршрутите от списъка + rate-limit burst + pagination regression — и трите изискват пълния Worker pipeline, защото:

- **Header contract** се прилага от `hardenResponse`, не от route handler-а.
- **Rate-limit burst** зависи от `CSV_RATE_LIMITER` binding, който е конфигуриран в `wrangler.jsonc` и се инжектира от `getPlatformProxy`.
- **Pagination regression** иска SSR HTML с `Следваща ›` anchor, който идва от `Pagination` компонента, рендиран през `reactRouter()` plugin-а и `hardenResponse`-обвития отговор.

Per-route handler тестове остават полезни за изолирана логика (covered by unit lane в `app/routes/*.test.ts`), но не заменят integration лентата.

### I. Hand-rolled Node `fetch` върху предварително изграден worker

Алтернативно: `react-router build` изгражда Worker-а, после `beforeAll` стартира `node ./build/server/index.js` локално (или wrangler deploy-ва preview), и тестът прави `fetch('http://localhost:8787/...')`.

**Защо не е избран:** и двете стъпки са скъпи по време — `react-router build` е ~2–3 s и трябва да се пуска на всяка тестова итерация (или поне при промяна на кода). `wrangler dev` също стартира допълнителен subprocess (виж D/G). Освен това `node`-exec на workerd build не е директно поддържан от Cloudflare — `react-router build` произвежда работещ под workerd bundle, но `node ./build/server/index.js` не тръгва без `wrangler dev` или прекомпилация за `@cloudflare/vite-plugin`'s Node adapter. `getPlatformProxy({ persist: false })` е строго по-евтин и по-бърз: in-memory miniflare без build стъпка.

## Алтернативи, които не разгледахме в Round 1–3 (out of scope)

- **Browser-level E2E** (`#95` — Playwright + WebKit/Chromium) — изрично извън обхвата на `#94`.
- **Coverage thresholds** (`#93`) — изрично извън обхвата на тази интеграционна лента.

Тези два ще имат отделни тикети и ADR-и, ако бъдат отворени в бъдеще.

## Последствия

### Положителни

- **Реалният request pipeline е тестван.** `appFetch(req)` минава през `withRequestLog` → `handleRequest` → `csvRateLimit` → React Router handler → `hardenResponse`. Всеки регрес в тази верига (header, rate-limit, CSP nonce, status code) е хванат.
- **Rate-limit binding-ите се тестват end-to-end.** `getPlatformProxy` вдига истински `ratelimit` binding; 11 successive `appFetch` calls тригват 429 с production body и `Retry-After: 60`.
- **D1 фикстурата е идемпотентна.** `INSERT OR IGNORE` + повторното пускане на миграциите е безопасно.
- **Polyfill-ът е минимален.** ~50 реда, без нови зависимости, без пипане в `app.ts`.
- **Unit test lane-ът е непокътнат.** `vitest.config.ts` остава за чисти функции; новият `vitest.integration.config.ts` е отделен проект в `vitest.workspace.ts`.

### Ограничения (умишлени)

- **HIT-on-second-request не е покрит** — деферирано, докато не мигрираме към `@cloudflare/vitest-pool-workers`.
- **Streaming CSV end-to-end (`/contracts.csv` body parse) не е покрит** в dev mode — деферирано, докато не преминем към pre-built-mode integration.
- **`/assistant/chat` (AI route) не е покрит** — изрично извън обхвата на `#94`.
- **`/search/suggest` не е покрит** интеграционно — unit покритие в `apps/web/app/routes/search.suggest.test.ts`.
- **Browser E2E (`#95`) и generic coverage thresholds (`#93`) не са в обхвата** на тази лента.

### Operational notes

- **CI gate**: `pnpm --filter @sigma/web test && pnpm --filter @sigma/web typecheck` — двата проекта вървят последователно в рамките на `test` script-а (`vitest run --config vitest.workspace.ts`).
- **CI startup cost**: Integration проектът добавя **~2–3 секунди** startup на виртуалния miniflare D1 + SQL preprocessor + 30-редова фикстура. Виртуалният `persist: false` D1 е in-memory, така че няма disk I/O освен четенето на двата малки migration файла (`packages/db/migrations/0000_init.sql` + `0001_flow_pairs_bidder_index.sql`). За 7 тест файла / 34 теста общият runtime е под 4 секунди на стандартен лаптоп. Ако тази латентност стане проблем за CI, първото нещо, което да се оптимизира, е local bootstrap — мениджмънтът на `wrangler.getPlatformProxy({ persist: false })` се стреми да мемоизира проксито в `globalThis.__SIGMA_PROXY__` per worker process.
- **Miniflare state isolation** (per C8): всеки vitest test file върви в собствен worker thread (`vmThreads`), а `wrangler.getPlatformProxy({ persist: false })` се bootstrap-ва lazy per-file в `setup.ts`. Двата worker thread-а получават два независими in-memory D1 binding-а — нулев cross-talk. Глобалният `globalSetup` (ако е конфигуриран) е **само оптимизация**, не е correctness gate: `setup.ts` е проектиран да работи самостоятелно, така че дори globalSetup да липсва/падне, тестовете минават. Rate-limit binding-ите СПОДЕЛЯТ in-memory state в рамките на един worker process — за това burst тестът извиква `__resetSigmaProxyForTesting()` в `beforeAll` (виж `rate-limit.csv.test.ts:42` коментара за пълното обяснение).
- **Конфликт с `pnpm dev` (`.wrangler/state`)** (per C8): `wrangler dev` и `react-router dev` пишат **на диска** в `apps/web/.wrangler/state/` за да persist-нат локалния D1 seed (`pnpm setup` и `pnpm run import` създават там production-lite данните). Лансирането на `pnpm dev` и `pnpm --filter @sigma/web test:integration` **по едно и също време** е безопасно: integration лентата използва `persist: false` и не докосва `.wrangler/state/` — нейният miniflare е изцяло in-memory и се самоунищожава при `proxy.dispose()`. Ако в бъдеще екипът мигрира към `unstable_dev` или `@cloudflare/vitest-pool-workers` (които пишат на диска), ще трябва да се добави един от: (а) `persist: { path: <tmpdir> }` плюс mutex върху `.wrangler/state/`; или (б) задължителен `pnpm dev` stop преди integration lane. **Днес не е необходимо.**
- **Локално debugging**: `pnpm --filter @sigma/web test:integration -- --testNamePattern "<route>"` филтрира до един тест; `console.log` вътре в теста излиза нормално.
- **Добавяне на нов route test**: добави запис в `routes.test.ts` с нов `CF-Connecting-IP` от RFC 5737 диапазона (`203.0.113.NN`), за да имаш самостоятелен rate-limit bucket.

## Свързани документи

- [`architecture.md`](architecture.md) — по-ранният ADR за rendering стратегията и сигурността.
- [`deploy.md`](deploy.md) — деплой към Cloudflare: как `wrangler.jsonc` binding-ите (включително `ratelimit`) стигат до production.
- [`apps/web/test/README.md`](../../apps/web/test/README.md) — кратко практическо ръководство за пускане и debugging на integration лентата.
- [`README.md`](../../README.md) — главният repo readme; Testing секцията е обновена с един ред за `test:integration`.
