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
  параметър, който loader чете, е в `CACHE_QUERY_PARAMS`, иначе два различни отговора се сливат в
  един запис (CWE-349). Drift-guard тест сканира маршрутите и пада CI при разминаване.
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

## AI асистент (`/assistant/chat`) — планиран

> Този раздел е **изпреварващ стандарт** за планирания асистент (виж
> [`spec/ai-assistant.md`](spec/ai-assistant.md)). Маршрутът `/assistant/chat`, `run_sql` и
> `eop_fetch` **още не съществуват** в кода — правилата важат, когато слоят се появи.

- Rate-limit **преди** embeddings/agent-loop, `failClosed: true` (503 при липсваща връзка).
- CSRF guard: изисквай `POST` + `Content-Type: application/json` + `Sec-Fetch-Site: same-origin`.
- `run_sql` с позитивен allowlist на таблици (отхвърляй `sqlite_master`, `pragma_*` във
  функционална форма, join с `on === null`).
- `eop_fetch` прави `JSON.parse(slice)` след байтовия cap, не върху цялото тяло.

## Supply chain

- SHA-pin на GitHub Actions (с четим `# vX.Y.Z` коментар); `sha256sum -c` за инсталатори; Dependabot
  за `github-actions` (групирано седмично, префикс `ci(deps):`).
