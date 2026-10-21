# Cloudflare, кеш и сигурност (при ревю)

> Изведено от повтарящи се бележки в ревютата. Допълва [`architecture.md`](architecture.md) §2–§3
> с оперативните правила, които ревюто изисква.

## Ключове за кеш (edge и R2)

- Ключът включва само параметри, които променят изхода. CSV-ключът не бива да носи `?sort` —
  стриймърите подреждат по keyset `id` и го игнорират; иначе идентичен изход се пише под неограничен
  брой ключове (cost/scan amplification).
- Нормализирайте `?sort`/филтрите срещу allowlist преди ключа; проверка с null-prototype-безопасен
  `in` (устойчиво на `__proto__`/`toString`).
- Edge HTML ключът (`workers/cache-key.ts`) трябва да съвпада с нормализацията в loader-а. Всеки
  параметър, който loader чете, е в списъка на своя маршрут (`routeQueryParams` в
  `app/lib/query-params.ts`). Работникът подава на loader-а само тези параметри, затова пропуснат
  параметър спира филтъра, вместо да слее два различни отговора в един запис (CWE-349). Drift-guard
  тест сканира маршрутите и пада CI при разминаване.
- Езикът идва само от префикса в пътя (не от cookie/`Accept-Language`); `/en/contracts` и
  `/contracts` се кешират отделно.

## Rate limiting

- Уникален `namespace_id` за всеки limiter и среда (без споделени bucket-и).
- Deploy-assert в `scripts/wrangler-render.mjs`: липсваща или дублирана връзка → **провален deploy**
  (`process.exit(1)`), не тих fail-open по време на работа.
- Покривайте под-пътищата (напр. `/search/suggest`, не само `=== '/search'`) — те вършат същата
  скъпа FTS работа.
- Структуриран `warn` на двата fail-open клона (липсваща връзка; limiter хвърля).

## CSP

- На edge-кеширан HTML заменете nonce-CSP с hash — но хеширайте **само** inline скриптовете, които
  носят SSR nonce атрибута, не цялото тяло (иначе самооторизирате инжектиран скрипт) и никога не
  преповтаряйте замразен nonce за всички посетители през целия живот на кеша.
- Без `nonce` на `<script type="application/ld+json">` — това е data island, CSP не важи за него, а
  атрибутът чупи hydration при всяко зареждане.

## Инжекции и валидация

- `JSON.stringify` към `dangerouslySetInnerHTML` минава през `.replace(/</g, '\\u003c')` —
  stringify не екранира `</script>`; всяко поле от източника (име на възложител/фирма) иначе е
  stored-XSS вектор.
- Валидирайте ЕИК (цифри, дължина 9/13) преди външна връзка; ЕИК на подизпълнител от суровия staging
  (`contracts.subcontractor_eik`) **не** е валидиран — пуснете връзката само при валиден ЕИК и го
  обвийте в `encodeURIComponent`.
- D1 prepared statements само с bound параметри — никога конкатениран SQL.

## D1 разход и индекси

- D1 таксува сканираните, не върнатите редове. Преди merge проверявайте с `EXPLAIN QUERY PLAN`, че
  горещите join/filter пътища ползват индекс; не-водеща колона на съставен PK → пълно сканиране =
  дефект от класа на коректността.
- Добавяйте адитивни, идемпотентни миграции (`IF NOT EXISTS`), които преживяват ship-а
  (`DELETE`+`INSERT`, не `DROP TABLE`).

## AI асистент (`/assistant/chat`) — в кода, не е осигурен

> Маршрутът `/assistant/chat` ([`assistant.chat.tsx`](../apps/web/app/routes/assistant.chat.tsx)) и
> инструментите `run_sql` и `eop_fetch` ([`lib/assistant/`](../apps/web/app/lib/assistant/)) са в кода и
> се деплойват. Асистентът остава изключен, като на средата не се задава `BGGPT_API_KEY`: без ключа
> маршрутът връща 503 („Асистентът все още не е конфигуриран.“), преди да стигне до модела, D1 или
> Vectorize. Дали ключът липсва, се проверява с `wrangler secret list --name <web worker>`.
> Ключът е launch gate — не се задава в production, докато не са изпълнени условията в
> [`lib/assistant/README.md`](../apps/web/app/lib/assistant/README.md) („Блокиращо преди прод ключ“):
> `run_sql` срещу read-only D1 и глобален бюджет/circuit-breaker. Правилата по-долу важат още сега:
> маршрутът е публичен адрес и всяка промяна в него се преглежда по тях.

- Rate-limit **преди** embeddings/agent-loop (`apps/web/workers/assistant-rate-limit.ts`, per-IP),
  `failClosed: true` (503 при липсваща връзка). Per-IP лимитът не е глобален бюджет.
- CSRF guard ([`request-guard.ts`](../apps/web/app/lib/assistant/request-guard.ts)): само `POST`;
  `Sec-Fetch-Site` се приема, когато е `same-origin`, `none` или липсва (клиент без браузър), а
  `same-site`/`cross-site` се отхвърлят с 403; `Content-Type` трябва да съдържа `application/json`
  (иначе 415).
- Таван на тялото (256 KB по деклариран `Content-Length` и след прочитане), на броя съобщения и на
  дължината на едно съобщение; клиентски `system`/`tool` съобщения и `tool-*` части отпадат, преди
  историята да стигне до модела.
- `run_sql` с позитивен allowlist на таблици (отхвърляй `sqlite_master`, `pragma_*` във
  функционална форма, join с `on === null`) и per-ход бюджет на прочетените редове
  (`D1_ROWS_READ_BUDGET`).
- `eop_fetch` прави `JSON.parse(slice)` след байтовия cap, не върху цялото тяло.

## Supply chain

- SHA-pin на GitHub Actions (с четим `# vX.Y.Z` коментар); `sha256sum -c` за инсталатори; Dependabot
  за `github-actions` (групирано седмично, префикс `ci(deps):`).
