# `apps/web/test/` — Testing the SSR Worker

В `apps/web` имаме две отделни vitest ленти, обединени от един workspace файл. Идеята е, че чистите функции (csv-export, security headers, cache-key, request log, rate-limit helpers) се покриват бързо и изолирано от **unit** лентата, а **integration** лентата качва истинския `apps/web/workers/app.ts` в Node, закача Cloudflare binding-ите от `wrangler.jsonc` през `wrangler.getPlatformProxy({ persist: false })`, засява D1 с малка фикстура и асъртва HTTP контракта (статус + security/cache headers + body shape) на маршрутите от issue `#94`.

## Кой файл какво прави

```
apps/web/test/
└── integration/
    ├── polyfills.ts          vitest setupFile — инсталира in-memory CacheStorage на globalThis.caches
    │                          (workers/app.ts чете caches.default at module init)
    ├── global-setup.ts       vitest globalSetup — буута wrangler proxy, прилага миграциите, засява фикстурата
    ├── setup.ts              appFetch(request): Promise<Response> — основният helper за integration тестовете
    ├── helpers/headers.ts    тънки vitest assertion хелпъри (assertCommonSecurity, assertHtmlContentType,
    │                          assertEdgeCacheFirstRequest, …)
    ├── routes.test.ts        13 маршрута от issue #94 (header contract: status + security + cache headers)
    ├── sitemaps.test.ts      /sitemap*.xml + /robots.txt — body shape (urlset / literal редове)
    ├── contracts-detail-json.test.ts
    │                          /contracts/1 (HTML) + /contracts/1.json (JSON:200 + body shape), 404 path
    ├── rate-limit.csv.test.ts  11× burst → 11-и = 429 + Retry-After; per-IP isolation
    ├── contracts-pagination.test.ts
    │                          cursor extraction → next page → disjoint ids + monotone amount_eur
    ├── contracts-csv.test.ts   defensive: worker-ът стига до /contracts.csv + header/body shape
    └── edge-cache.test.ts    X-Edge-Cache: MISS|BYPASS на първата заявка
```

Вижте също [`docs/spec/integration-testing.md`](../../../docs/spec/integration-testing.md) (ADR-0002) за пълното обяснение на архитектурното решение, включително умишлените scope cuts за HIT-on-second-request и streaming CSV body parse в dev mode.

## Как се пуска

Всички команди се изпълняват от корена на монорепото:

```bash
# Unit lane — само чисти функции, без Worker pipeline (~1 s, 30 файла, 284 теста)
pnpm --filter @sigma/web test:unit

# Integration lane — Worker + D1 + bindings през wrangler.getPlatformProxy (~2–3 s, 7 файла, 34 теста)
pnpm --filter @sigma/web test:integration

# Двете ленти последователно — CI gate, exit 0 = зелено (общо 37 файлa, 318 теста, ~5–6 s)
pnpm --filter @sigma/web test

# Typecheck (независимо)
pnpm --filter @sigma/web typecheck
```

`pnpm --filter @sigma/web test` върви `vitest run --config vitest.workspace.ts`, който зарежда двата проекта (`./vitest.config.ts` и `./vitest.integration.config.ts`) в един процес — Vitest 4 премахна legacy `--workspace` CLI флага и поддържа обединението само през `test.projects` в конфиг файл.

### Филтриране до един тест

```bash
# само един it() от integration лентата
pnpm --filter @sigma/web test:integration -- --testNamePattern "GET /contracts/1"

# само един файл
pnpm --filter @sigma/web exec vitest run --config vitest.integration.config.ts test/integration/rate-limit.csv.test.ts

# всички тестове, чието име съдържа „429“
pnpm --filter @sigma/web test:integration -- -t "429"
```

### Debugging

```bash
# verbose изход (и stack traces), без филтър
pnpm --filter @sigma/web test:integration -- --reporter=verbose

# watch mode (development)
pnpm --filter @sigma/web exec vitest --config vitest.integration.config.ts --watch
```

`console.log` вътре в тестовете излиза нормално в stdout. Wrangler proxy-тo **не** spawn-ва отделен процес — всичко е in-process и self-contained.

### Съжителстване с `pnpm dev`

`pnpm dev` (`react-router dev`) и `pnpm --filter @sigma/web test:integration` могат да вървят **по едно и също време** на една машина без конфликти. Причината: integration лентата boot-ва `wrangler.getPlatformProxy({ persist: false })` — D1/binding-ите живеят изцяло в паметта на тестовия Vitest worker process и **не пишат** в `apps/web/.wrangler/state/`. `pnpm dev`, от друга страна, persist-ва локалния D1 seed там (чрез `pnpm setup` + `pnpm run import`). Тези два свята не се припокриват, така че:

- Можете да отворите <http://localhost:5173> в браузъра, да пипате ръчно страници и паралелно да пуснете integration suite — двата процеса не заключват файлове един на друг.
- Не е нужно да спирате `pnpm dev`, за да пуснете `test:integration`.

**Изключение (бъдещо):** ако лентата в бъдеще мигрира към `@cloudflare/vitest-pool-workers` или `unstable_dev` (които пишат на диска), ще трябва да добавите mutex или задължителен `pnpm dev` stop преди integration suite. Подробности — в Operational notes на [`docs/spec/integration-testing.md`](../../../docs/spec/integration-testing.md).

## Как се добавя нов тест

### 1. Header контракт за съществуващ маршрут

Ако просто добавяте още един маршрут от issue `#94`, най-често трябва да добавите нов `it(...)` в `apps/web/test/integration/routes.test.ts`:

```ts
// apps/web/test/integration/routes.test.ts
import { appFetch } from './setup';
import {
  assertCommonSecurity,
  assertEdgeCacheFirstRequest,
  assertHtmlContentType,
} from './helpers/headers';

const BASE = 'https://sigma.test';

function get(path: string, ip: string): Promise<Response> {
  return appFetch(new Request(`${BASE}${path}`, { headers: { 'CF-Connecting-IP': ip } }));
}

describe('routes — header contract (issue #94)', () => {
  it('GET /flows', async () => {
    const res = await get('/flows', '203.0.113.99'); // <- нов IP от RFC 5737 документацията
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertHtmlContentType(res);
    assertEdgeCacheFirstRequest(res);
  });
});
```

Задължителни стъпки:

1. **Изберете нов `CF-Connecting-IP` от `203.0.113.0/24`** (RFC 5737 документация). Четирите rate-limit binding-а (`CSV_RATE_LIMITER`, `SEARCH_RATE_LIMITER`, `AGG_RATE_LIMITER`, `ASSISTANT_RATE_LIMITER`) са per-IP — споделеният IP с друг тест значи споделен bucket и фалшиво „429 mid-test“.
2. **`assertCommonSecurity`** покрива задължителната база:
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: DENY`
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `Cross-Origin-Opener-Policy: same-origin`
   - `Cross-Origin-Resource-Policy: same-origin`
   - `Permissions-Policy: geolocation=(), microphone=(), camera=()`
   - `Content-Security-Policy: ABSENT` (тестовата лента е `import.meta.env.PROD === false`).
3. **`assertEdgeCacheFirstRequest`** асъртва `X-Edge-Cache: MISS|BYPASS` — `HIT` е умишлено извън обхвата на тази лента и е описан в ADR-0002.
4. **Content-Type хелпъри** (`assertHtmlContentType`, `assertSitemapContentType`, `assertTextPlainContentType`, `assertJsonContentType`, `assertCsvContentType`) — изберете според реалния Content-Type, който маршрутът емитира. Regex-ите толерират `charset=utf-8` суфикс.

### 2. Body-shape тест за нов маршрут

Ако имате нужда от проверка на **тялото** (не само на хедърите), отворете нов файл по аналогия с `sitemaps.test.ts` или `contracts-detail-json.test.ts`. Шаблонът:

```ts
import { describe, expect, it } from 'vitest';
import { appFetch } from './setup';

describe('GET /some-route — body shape', () => {
  it('renders the documented body', async () => {
    const res = await appFetch(
      new Request('https://sigma.test/some-route', {
        headers: { 'CF-Connecting-IP': '203.0.113.42' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/expected literal/);
  });
});
```

### 3. Rate-limit burst тест за нов binding

Ако добавяте нов `ratelimit` binding в `wrangler.jsonc` и искате да асъртвате неговия threshold end-to-end:

1. Конфигурирайте binding-а в `apps/web/wrangler.jsonc` под `unsafe.bindings[*]` (type: `ratelimit`, namespace, simple_limit).
2. Добавете нов `describe(...)` в `apps/web/test/integration/rate-limit.csv.test.ts` (или отделен файл), който извиква `__resetSigmaProxyForTesting()` в `beforeAll` за да получите **свеж** proxy с празен bucket. Вижте коментара на „Why `beforeAll` disposes the proxy“ в началото на `rate-limit.csv.test.ts:42`.
3. Консумирайте `<limit + 1>` заявки от един и същ IP и асъртвайте:
   - първите `<limit>` = `200` (или съответния „нормален“ статус)
   - `<limit + 1>`-ият = `429` с `Retry-After` и документираното `body literal`
4. Добавете втори тест от **различен IP**, за да докажете, че bucket-ът е per-IP.

### 4. Кога D1 фикстурата не стига

`apps/web/test/integration/global-setup.ts` засява:

- 1 authority (`auth:BG000000000`), 1 bidder (`eik:BG000000001`), 1 tender (`t:FIX-1`).
- 30 договора в `contracts` със строго намалящ `amount_eur` (за pagination regression).
- 1 ред във всяка от `home_totals`, `authority_totals`, `company_totals`, `data_freshness` — за да има първа страница за `/`, `sitemap-authorities.xml`, `sitemap-companies.xml`.

Всичко е `INSERT OR IGNORE` — идемпотентно, безопасно за повторни пускания в рамките на един worker process.

Ако новият ви тест има нужда от повече данни (например 200 договора, за да тества пейджнация на 3 страници), имате два избора:

- **Локално в `beforeAll` на конкретния тест** — извикайте `proxy.env.DB.exec(...)` с нов `INSERT OR IGNORE` и след това добавете колоните/редовете, от които тестът има нужда. Proxy-то се bootstrap-ва лениво в `setup.ts:getProxy()`, така че в `beforeAll` вече е наличен на `globalThis.__SIGMA_PROXY__`.
- **Глобално в `global-setup.ts`** — добавете новите редове към `FIXTURE_*` списъка + инкрементация на броя в `buildContractsInsert(n)`. Направете го, ако фикстурата е полезна за повече от един тест.

### 5. Когато тестът се нуждае от нов binding/поле

Ако промените `apps/web/wrangler.jsonc` (например добавяте ново поле в `vars` или нов binding), `wrangler.getPlatformProxy` ще го отрази автоматично на следващия bootstrap. **Стъпки:**

1. Редактирайте `wrangler.jsonc`.
2. Пуснете `pnpm --filter @sigma/web cf-typegen` за да се обнови `worker-configuration.d.ts` (`Env` типът).
3. Ако използвате нови `Env` полета в `setup.ts`/`global-setup.ts`, добавете typecast или тип изявление в новите редове.
4. Пуснете `pnpm --filter @sigma/web typecheck` — `wrangler types && react-router typegen && tsc -b`.

## Чеклист за PR

Преди да маркирате „готово“ в PR, който пипа integration лентата:

- [ ] `pnpm --filter @sigma/web test` — и двете ленти зелени, exit 0.
- [ ] `pnpm --filter @sigma/web typecheck` — exit 0 (включва `wrangler types && react-router typegen && tsc -b`).
- [ ] Ако сте добавили нов binding или променили `wrangler.jsonc` — `pnpm --filter @sigma/web cf-typegen` е пуснат и `worker-configuration.d.ts` е в commit-а.
- [ ] Ако сте добавили нов fixture ред — той е `INSERT OR IGNORE` (идемпотентен).
- [ ] Ако тестът е бъстнат (CSV rate-limit) — `beforeAll` извиква `__resetSigmaProxyForTesting()` за свеж bucket.
- [ ] Всеки нов `it(...)` има **свой собствен** `CF-Connecting-IP` от `203.0.113.0/24`.

## Полезни файлове за справка

- [`docs/spec/integration-testing.md`](../../../docs/spec/integration-testing.md) — ADR-0002: защо `getPlatformProxy`, защо ръчна миграция, защо polyfill, какви са умишлените scope cuts.
- [`vitest.workspace.ts`](../vitest.workspace.ts), [`vitest.config.ts`](../vitest.config.ts), [`vitest.integration.config.ts`](../vitest.integration.config.ts) — конфигурацията на трите проекта.
