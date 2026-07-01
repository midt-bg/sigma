# ADR-0001 — Стратегия за рендиране на front-end-а и модел на сигурност

- **Статус:** Прието
- **Обхват:** Итерация 1 — публичният, read-only explorer на обществените поръчки (АОП). Документът отбелязва и пътя напред към по-широката платформа (оценка на риска, аномалии, картелен анализ — roadmap).

> **Актуализация (2026-05-21):** Решението за фреймуърк по-долу беше променено от SvelteKit на **React Router v7 върху Cloudflare Workers** след претегляне на екосистемата, набирането на хора и контрибутори, primitives за достъпност и екосистемата за визуализации/AI. Решенията за рендиране (§2) и за сигурност (§3) са независими от фреймуърка и остават непроменени; обновени бяха само техните специфични за фреймуърка механики.

## Контекст

Итерация 1 е **публичен, read-only** отчетен и визуализационен слой върху ~129 хил. реда договори от АОП в Cloudflare D1, насочен към граждани, журналисти и НПО, с интерфейс на български. Уеб приложението първоначално беше скелетирано върху **SvelteKit**; този ADR преразглежда този избор. Сървърната среда е **Cloudflare Workers**, които четат D1. Данните пристигат като **периодични bulk зареждания** (`scripts/import.mjs`), а не като жива емисия; в тази итерация **няма публичен write път и няма автентикация**.

Три въпроса стояха в основата на решението:

1. Трябва ли front-end-ът да премине от Svelte към React?
2. Трябва ли страниците да се рендират на сървъра (SSR), да се пре-рендират (статично), или да са класическо клиентско SPA срещу API?
3. Променят ли отговора атаките през SSR / „hydration“?

## Решение

### 1. React с React Router v7 (framework mode) върху Cloudflare Workers

Избран пред първоначалния SvelteKit скелет след претегляне на дълготрайните фактори:

- **Екосистема и преизползване** — най-голямата екосистема от компоненти/библиотеки и най-богатите опции точно за повърхностите, върху които СИГМА стъпва: мрежови графи на връзки (`@xyflow/react`), таблици за големи данни (TanStack Table / AG Grid), графики (visx / Recharts), а за по-късния асистент — AI SDK (`@ai-sdk/react`) и зрели UI-та за асистенти.
- **Набиране на хора и open-source контрибутори** — значително по-голям talent pool; релевантно за вероятно OSS гражданска платформа („Лицензът ще бъде определен преди публичното пускане“).
- **Primitives за достъпност** — React Aria / Radix са сред най-добрите в класа си за изричната цел **WCAG 2.2 AA**.
- **Дълготрайност** — най-защитимият дългосрочен избор за дълголетна платформа от обществена полза.

**React Router v7 (framework mode), а не Next.js** — той върви чисто върху **Cloudflare Workers** (през `@cloudflare/vite-plugin`) и запазва модела SSR-на-edge и хибридното рендиране от §2. Приети компромиси спрямо SvelteKit: по-голям клиентски runtime (смекчен от SSR + кеширане) и липса на first-party CF *Pages* адаптер — RR7 се деплойва като Worker, което освен това уеднаквява `apps/web` с останалите `apps/*`.

### 2. Рендиране: хибридно, избрано според повърхността

По подразбиране **SSR + edge кеширане**; пре-рендиране само за реално статичните страници; клиентско рендиране само за интерактивните „острови“. **Не** чисто SPA за публично съдържание (SEO/споделяемост + цена на първото изрисуване); **не** build-time пре-рендиране на целия корпус (десетки хиляди страници за компании/институции, а търсенето изобщо не може да се пре-рендира).

| Повърхност | Стратегия | Защо |
| --- | --- | --- |
| Начало, За проекта, **методология / „как работят червените флагове“**, документация за отворените данни | Пре-рендиране (статично) | Рядко се променят → надеждно + безплатно |
| Профил на компания (по ЕИК), страница на институция, детайл на поръчка/обособена позиция | **SSR + edge кеш** (`s-maxage` + `stale-while-revalidate`), purge при презареждане на набора данни | Голям обем, променя се само при bulk презареждане → скорост като при статика + устойчивост на DDoS, актуалност след презареждане |
| Explorer: търсене / филтри / класации („най-големи бенефициенти“) | SSR, кратък кеш, варира според заявката | Безкрайно URL пространство; задвижван от SQL |
| Интерактивни визуализации (граф на мрежа/потоци, карта на България, сортируеми таблици) | Клиентски рендиран **остров**, хидриран върху SSR-ната страница + първоначални данни | Нуждае се от клиентска интерактивност; SSR на обвивката заради SEO/първо изрисуване |

Тъй като наборът данни е периодична снимка (а не жив), кеш TTL-ите може да са дълги, а едно презареждане просто **purge-ва** кеша — почти всички предимства на статиката, без да се изброява корпусът при build.

### 3. Модел на сигурност

Приоритети за публичен сайт за прозрачност: **интегритет ≈ наличност ≫ конфиденциалност** — данните са публични по дизайн; тяхната *достоверност* и *uptime* са продуктът.

**Контроли в итерация 1:**

- **Read път да остане read-only.** Ingestion-ът е офлайн (`scripts/import.mjs`); няма публичен write endpoint. Това се запазва — без публична мутация, без админ в итерация 1.
- **Edge модел + кеширане като поглъщане на DDoS.** Cloudflare поглъща L3/4; кешираният HTML означава, че атакуващ / scrape трафик удря кеша, а не D1.
- **WAF + rate limiting** върху задвижвания от SQL explorer/търсене и върху всеки export на отворени данни; ограничаване на `limit` / пагинация / размер на export-а, така че нито една заявка да не сканира цялата таблица.
- **Строг CSP + security headers** — генериране на per-request nonce в `entry.server.tsx`, подаван към `<Scripts nonce>` / `<ScrollRestoration nonce>` на React Router и към header-а `Content-Security-Policy` (за да са разрешени hydration скриптовете на фреймуърка без `unsafe-inline`). Добавяне на HSTS, `X-Content-Type-Options`, `Referrer-Policy`.
- **D1 prepared statements само с bound параметри**; никога конкатениране на SQL чрез низове.

**По въпроса за „hydration атаките“** — реалните класове и как този дизайн ги адресира:

- **Изтичане между потребители през кеширан персонализиран SSR** — неприложимо в итерация 1 (без автентикация; всяка страница е анонимна и идентична → безопасна за кеширане). Остава предотвратено и по-късно, като се кешират *само* анонимни публични страници и никога автентикираните.
- **Свръх-сериализиране на тайни в hydration payload-а** — смекчено чрез типизираните response DTO-та в `packages/api-contract` (отдават проекции на същностите, никога сурови редове) и чрез държане на код, носещ credentials, извън уеб/read пътя. DTO-тата да остават без вътрешни-само полета.
- **XSS през сериализирано състояние / рендирани данни** — разчита се на авто-escaping-а на React/JSX; **никога `dangerouslySetInnerHTML`** върху текст от АОП (институция / компания / предмет са от външен източник); строгият CSP е резервната защита.

**Отложено за по-късни фази** (повърхностите на по-широката платформа):

- **Workflow-и за възложители/участници + админ** → Cloudflare Access (SSO + MFA) за админ; строго разделяне на публичен/персонализиран кеш; изолация на write пътя в отделен worker.
- **AI асистент за обществени поръчки** → маршрутизиране през **AI Gateway** (лимити за rate/разход, кеширане, логване); read-only, параметризирани инструменти; заземяване на всяко твърдение в изчислени данни (риск от клевета); никакво кеширане; рендиране на изхода като текст. Спецификация — [`spec/ai-assistant.md`](spec/ai-assistant.md).

## Последствия / scaffold follow-up-и

- Конфигуриране на пре-рендирането в `react-router.config.ts` (`prerender` пътища) за статичните информационни route-ове.
- Задаване на `Cache-Control` (`s-maxage` + `stale-while-revalidate`) през `headers` export-ите на route-овете при SSR data route-овете; иницииране на cache purge (по URL/таг) в края на скрипта за зареждане на данните.
- Задаване на CSP + security headers в `entry.server.tsx` (или Worker middleware) с per-request nonce върху `<Scripts>`.
- Добавяне на Cloudflare rate-limit правило + WAF managed ruleset за explorer/export endpoint-ите (infra конфигурация, проследявана отделно).
- Премахване или auth-gate на отворения `POST /etl/run` от скелета в `apps/etl` преди какъвто и да е деплой.

## Свързани документи

- [`etl.md`](etl.md) — ETL pipeline-ът и емисията от ЦАИС ЕОП.
- [`deploy.md`](deploy.md) — деплой към Cloudflare и оперативна сигурност.
- [`spec/ai-assistant.md`](spec/ai-assistant.md) — спецификация на планирания AI асистент.
- [`README.md`](../README.md) на репозиторието и [`../AGENTS.md`](../AGENTS.md) — общ преглед и работни конвенции.

# ADR-0002 — Политика за поверителност на машинно-четим изход (Issue #173)

- **Статус:** Прието
- **Обхват:** Повърхностите на СИГМА, които връщат машинно-четимо тяло — JSON записите на договорите (`/contracts/:id.json`) и CSV експортите (`/contracts.csv`, `/companies.csv`, `/authorities.csv`). Не засяга HTML рендирането на профилите, което вече имаше собствен `noindex` път.
- **Препратки:** [Issue #173](https://github.com/midt-bg/sigma/issues/173) · [`apps/web/app/routes/privacy.tsx`](../apps/web/app/routes/privacy.tsx) (`# natural-person-data`) · ADR-0001 §3 (модел на сигурност)

> Решението за маскиране на идентификаторите на едноличните търговци и физическите лица в машинно-четимия изход е продуктово-политическо и инженерно, не правно. GDPR и ЗЗЛД се третират като контекст за вземане на решение, не като юридическо тълкуване — окончателната оценка е задължение на поддържащите проекта.

## Контекст

Итерация 1 на СИГМА публикува идентификатори на изпълнителите на обществени поръчки в три форми: (1) HTML профили на фирми (по ЕИК), (2) JSON запис на договора (`/contracts/:id.json`) за връзка от HTML-а, и (3) CSV експорти (`/contracts.csv`, `/companies.csv`, `/authorities.csv`) за журналисти и изследователи.

HTML профилът на фирма вече прилагаше `noindex` мета таг за записи, които се разпознават като едноличен търговец или физическо лице (`isSingleNaturalPersonProfile` в [`apps/web/app/routes/company.tsx`](../apps/web/app/routes/company.tsx) — *inline*, преди ADR-0002). Логиката имаше две слабости:

1. **Дупка между HTML и машинно-четим изход.** Търсачките и бот-индексаторите, които не изпълняват HTML мета таговете, можеха да достигнат до JSON и CSV записите и да индексират същите естествено-личностни идентификатори (ЕИК, пълно име на ЕТ). Това противоречи на политиката `noindex` от страна на HTML.
2. **Дублирана логика на откриване.** Разпознаването „ЕТ …" беше вградено в route-а като `isSingleNaturalPersonProfile` (inline), а друга негова разновидност (`isNaturalPersonProfileName`) живееше в [`packages/shared/src/format.ts`](../packages/shared/src/format.ts). Без единен предикат всяка нова машинно-четима повърхност щеше да копира правилата, а при разминаване на копията — да изтече идентификатор.

Допълнителен фактор: edge кешът на CSV отговорите (`Cache-Control: public, max-age=3600`) съдържа пълните байтове на стрийма. Ако едно и също тяло се сервираше и за юридически лица, и за ЕТ без маскиране, кешът щеше да замрази изтичането — което означава, че маскирането трябва да се случи **преди** записа в R2.

## Решение

Приета е политика **`noindex` плюс маскиране**, с общ предикат от [`packages/shared/src/format.ts`](../packages/shared/src/format.ts):

1. **Единен предикат.** Премахваме inline `isSingleNaturalPersonProfile` от `apps/web/app/routes/company.tsx` и заменяме с `isNaturalPersonBidder(name, legalForm)` от `packages/shared/src/format.ts`. Предикатът комбинира два сигнала — `legal_form LIKE 'ЕТ%'` (включително латинското `ET`, разширените форми `ЕДНОЛИЧЕН ТЪРГОВЕЦ`, `SOLE TRADER`, `INDIVIDUAL`) и водещия `ЕТ ` / `ET ` суфикс в името (който вече беше в `isNaturalPersonProfileName`). HTML `noindex` мета тагът, CSV маскирането и JSON маскирането споделят **единствено** този предикат — няма дублирани хардкоднати правила в route-овете.
2. **`X-Robots-Tag: noindex` на всяка машинно-четима повърхност — централизирано в worker-а.** Заглавието се задава в **единствено едно** място в авторския код: в worker pipeline-а [`hardenResponse`](../../apps/web/workers/app.ts) (в `apps/web/workers/app.ts`), който при финалното обвиване на отговора извиква помощната функция `applyPrivacyMaskHeaders` от [`apps/web/app/lib/security.ts`](../../apps/web/app/lib/security.ts). Route-овете само **маркират** отговора си с вътрешния хедър `X-Privacy-Mask: applied` чрез помощната функция `markPrivacyMaskApplied` от същия файл — например [`apps/web/app/routes/contract.json.tsx`](../apps/web/app/routes/contract.json.tsx) го извиква в reference-equality гейта на маскирането. Четирите CSV клона на [`apps/web/app/lib/csv-export.ts`](../apps/web/app/lib/csv-export.ts) (`markCsvCache`, динамичният `Response`, 200/206 `Response`, 304 `Response`) също само маркират — `X-Robots-Tag: noindex` се появява в изходящите им хедъри единствено защото worker-ът го излъчва, не защото `csv-export.ts` го пише. Вътрешният `X-Privacy-Mask` маркер се изтрива в worker-а преди кеширане и преди достигане до клиента (виж [`apps/web/workers/app.ts:62`](../../apps/web/workers/app.ts) и `applyPrivacyMaskHeaders` в `security.ts:86-91`) — никога не изтича към потребителя. Маркерът е допълнение към `robots.txt` (който вече забраняваше `/*.csv`) — покрива crawler-и и инструменти, които четат HTTP-хедъри, но не и `robots.txt`.
3. **Маскиране на ЕИК и оригиналното име.** За разпознати естествено лица / еднолични търговци:
   - **CSV:** `contractor_eik`/`eik` се замества с празен низ, `contractor`/`name` се замества със символа `MASKED_NATURAL_PERSON_LABEL` от [`packages/shared/src/format.ts:197`](../packages/shared/src/format.ts) (стойност `„Частно лице"` — без запетая/кавичка, за да не се нуждае от CSV-escape).
   - **JSON:** `bidder.eik` → `null`, `bidder.name` → `MASKED_NATURAL_PERSON_LABEL`, `bidder.displayName` → `MASKED_NATURAL_PERSON_LABEL`, `sourceNames.bidder` → `MASKED_NATURAL_PERSON_LABEL`. Останалите полета (`bidder.slug`, агрегатите `totalContracts`/`totalEur`, `kind`, `settlement`) остават непроменени — `slug`-ът не е PII, а е URL фрагмент.
4. **Символът `MASKED_NATURAL_PERSON_LABEL` е единичен източник на истината.** Експортиран от `@sigma/shared` (баррелът [`packages/shared/src/index.ts`](../packages/shared/src/index.ts)). Тестовете го импортират по символ, не по литерален текст — преименуване на етикета (напр. на „Физическо лице") няма да счупи нито един тест.
5. **Юридическите лица не се пипат.** `legal_form` `АД`/`ООД`/`ЕАД`/`ЕООД` остават видими както в CSV, така и в JSON. Само когато предикатът върне `true` се прилага маската.

## Последствия

- **Кеш политиката остава.** `Cache-Control: public, max-age=3600` за CSV и `public, s-maxage=3600, stale-while-revalidate=86400` за JSON остават непроменени — маскираните байтове са безопасни за кеширане, защото не съдържат естествено-личностни идентификатори. Edge кешът е приоритет за DDoS устойчивостта (ADR-0001 §3) и отпадането му би влошило публичната достъпност на експортите.
- **R2 CSV кешът се регенерира при първото презареждане след тази промяна.** Ключът на обекта е `csv/<route>/<freshnessVersion>` ([`apps/web/app/lib/csv-export.ts`](../apps/web/app/lib/csv-export.ts)). Следващото bulk презареждане (през `scripts/import.mjs`) инкрементира `freshnessVersion` и новите обекти се записват вече маскирани; старите се презаписват естествено (без миграция).
- **Брой маскирани редове е равен на броя флагнати от предиката.** Всеки ред в CSV стрийма се оценява независимо от `isNaturalPersonBidder(name, legalForm)`; маскирането е per-row, не per-batch. Контролната проверка за това е в `packages/db/src/queries/contracts.test.ts` (тестът „masks the contractor and clears contractor_eik when legal_form is a sole-trader form (ЕТ)") и в `packages/db/src/queries/companies.test.ts` (тестът „writes MASKED_NATURAL_PERSON_LABEL + empty EIK for an ЕТ row in the rollup branch").
- **HTML профилът не е засегнат.** `noindex` мета тагът за естествени лица остава непроменен — предикатът е същият, но маркерът вече е в общата логика, не в inline код.
- **Подаване на документацията надолу по веригата.** В [`apps/web/app/routes/privacy.tsx`](../apps/web/app/routes/privacy.tsx) е добавена секция `# natural-person-data`, която описва подхода за потребители и журналисти: кои идентификатори се маскират, кои остават, и причината (`noindex` плюс етикет вместо истинското име).
- **`authorities.csv` получава само `X-Robots-Tag: noindex`.** Възложителите в корпуса винаги имат попълнен ЕИК (публични органи) — не се прилага маскиране на тялото. Маркерът е политическа последователност (еднаква политика за всички CSV), не техническо маскиране.
- **Стримовете не се рефакторират.** Контрактите `streamContractsCsv`/`streamCompaniesCsv`/`streamAuthoritiesCsv` остават същите; маскирането е вътрешен branch в per-row цикъла, който разчита на новата `b.legal_form` колона в SELECT-а.

## Засегнати повърхности

### Споделена логика

- [`packages/shared/src/format.ts`](../packages/shared/src/format.ts) — нови `isNaturalPersonBidder(name, legalForm)` и `MASKED_NATURAL_PERSON_LABEL`; запазен `isNaturalPersonProfileName` за backwards compatibility (все още се използва от `streamCompanySitemap`).
- [`packages/shared/src/format.test.ts`](../packages/shared/src/format.test.ts) — нови тестове за предиката, етикета и „shared predicate surface" (truth-table блок).

### DB заявки (CSV стрийм + JSON getContract)

- [`packages/db/src/queries/contracts.ts`](../packages/db/src/queries/contracts.ts) — `streamContractsCsv` проектира `b.legal_form AS bidder_legal_form` и прилага маскиращия branch в per-row цикъла (редове ~436, ~450-453).
- [`packages/db/src/queries/companies.ts`](../packages/db/src/queries/companies.ts) — `streamCompaniesCsv` и двата клона на `source()` (`company_totals` rollup и base-aggregation CTE) проектират `b.legal_form`; per-row цикълът маскира `eik`/`name`.
- [`packages/db/src/queries/details.ts`](../packages/db/src/queries/details.ts) — `getContract` проектира `b.legal_form AS bidder_legal_form` (съществуващият `JOIN bidders b` се преизползва); `ContractDetailRow` и типът на return-а се разширяват с `bidder_legal_form: string | null`.
- [`packages/db/src/queries/contracts.test.ts`](../packages/db/src/queries/contracts.test.ts) — нов `describe('streamContractsCsv masking', ...)` блок (4 теста).
- [`packages/db/src/queries/companies.test.ts`](../packages/db/src/queries/companies.test.ts) — нов `describe('streamCompaniesCsv masking', ...)` блок (4 теста).

### Web route-ове

- [`apps/web/app/routes/contract.json.tsx`](../apps/web/app/routes/contract.json.tsx) — добавя чистия хелпер `maskContractForPrivacy(record, bidderLegalForm): ContractRecord` (модулен export, за тестваемост) и в reference-equality гейта на маскирането извиква `markPrivacyMaskApplied(headers)` от `apps/web/app/lib/security.ts` — служи като вътрешен сигнал за worker-а, не пише `X-Robots-Tag` директно. 404 клонът и `Cache-Control` остават непроменени.
- [`apps/web/app/routes/contract.json.test.ts`](../apps/web/app/routes/contract.json.test.ts) — нов тестов файл (3 теста за хелпера + 4 за loader-а, общо 7). Тестовете за loader-а твърдят, че маркерът `X-Privacy-Mask: applied` присъства на маскирания отговор и че `X-Robots-Tag: noindex` **не** присъства на loader output-а — последното е прерогатив на worker-а.
- [`apps/web/app/routes/company.tsx`](../apps/web/app/routes/company.tsx) — премахва inline `isSingleNaturalPersonProfile`; HTML `noindex` сега идва от `isNaturalPersonBidder`. За естествено лице loader-ът `mutate`-ва `company.eik = null` и връща `Response.json({...}, { headers: { 'X-Privacy-Mask': 'applied' } })`. `headers()` export-ът препраща `X-Privacy-Mask` от `loaderHeaders`, за да достигне маркерът до worker-а и при HTML отговора (виж по-долу за `.data` близнака).
- **`.data` близнак на `/companies/:eik`** (React Router v7 single-fetch при `ssr:true`) — споделя същия `loader` от `company.tsx`, така че маскирането и сигнализирането се случват автоматично за `.data` заявките: при естествено лице `company.eik = null` е видимо в turbo-stream payload-а и worker-ът излъчва `X-Robots-Tag: noindex` на отговора (включително в edge-кешираното копие).
- [`apps/web/app/routes/contracts.csv.tsx`](../apps/web/app/routes/contracts.csv.tsx), [`apps/web/app/routes/companies.csv.tsx`](../apps/web/app/routes/companies.csv.tsx), [`apps/web/app/routes/authorities.csv.tsx`](../apps/web/app/routes/authorities.csv.tsx) — без промяна на кода; маркерът идва от `servedCsvExport`.

### Worker — централизирана точка за прилагане

- [`apps/web/workers/app.ts`](../apps/web/workers/app.ts), функция `hardenResponse` — **единственото** място в авторския код, което пише `X-Robots-Tag: noindex` в изходящия отговор. Извиква `applyPrivacyMaskHeaders(headers)` от [`apps/web/app/lib/security.ts`](../apps/web/app/lib/security.ts), което превежда маркера `X-Privacy-Mask: applied` (сложен от който и да е route loader или `csv-export.ts`) в публичния `X-Robots-Tag: noindex` и след това изтрива самия маркер. Поставянето на изтриването в `hardenResponse` гарантира, че вътрешният маркер не достига нито edge кеша (`edgeCache.put(key, hardened.clone())`), нито клиента. Поради тази централизация **всяка бъдеща машинно-четима повърхност** (CSV, JSON, `.data`, нов feed) наследява `X-Robots-Tag: noindex` автоматично, стига route-ът (или helper в `csv-export.ts`) да сложи маркера през `markPrivacyMaskApplied(headers)` — само с едно място за поддръжка на политиката.

### Web помощен код

- [`apps/web/app/lib/security.ts`](../apps/web/app/lib/security.ts) — двата нови хелпера на политиката: `markPrivacyMaskApplied(headers)` (route-ът го извиква, за да маркира отговора) и `applyPrivacyMaskHeaders(headers)` (worker-ът го извиква, за да преведе маркера в `X-Robots-Tag: noindex` и да го изтрие). Константата `PRIVACY_MASK_APPLIED` (`'applied'`) е литерален тип и е единственият позволен израз за стойност на маркера.
- [`apps/web/app/lib/csv-export.ts`](../apps/web/app/lib/csv-export.ts) — `X-Robots-Tag: noindex` **не** се задава тук. На негово място `markCsvCache` и 304 клонът извикват `markPrivacyMaskApplied(headers)` от `security.ts`; политическото решение (кой получава `noindex`) се взема в worker-а. Съществуващите `Cache-Control` и `Content-Disposition` остават.
- [`apps/web/app/lib/csv-export.test.ts`](../apps/web/app/lib/csv-export.test.ts) — обновен `describe('servedCsvExport privacy', ...)` блок (тестовете вече твърдят `X-Privacy-Mask: applied` на `response.headers` и **липса** на `X-Robots-Tag` — последното е прерогатив на worker-а).

### Потребителска документация

- [`apps/web/app/routes/privacy.tsx`](../apps/web/app/routes/privacy.tsx) — нова секция `# natural-person-data` след съществуващия `# data` блок. Обяснява маскирането на естествено-личностни идентификатори и `noindex` политиката в машинно-четимия изход.

## Доказателство

### Тестове — маскиране и noindex (тези файлове са цитирани в success criteria на Issue #173)

| Файл | Тестове | Покритие |
| --- | --- | --- |
| [`packages/shared/src/format.test.ts`](../packages/shared/src/format.test.ts) | `isNaturalPersonBidder`, `MASKED_NATURAL_PERSON_LABEL`, `shared predicate surface — single source of truth for the noindex / masking decision` | Предикатът и етикетът — единственият източник на истината. |
| [`packages/db/src/queries/contracts.test.ts`](../packages/db/src/queries/contracts.test.ts) | `streamContractsCsv masking` (4 теста) | Per-row CSV маскиране: ЕТ маскира, ООД запазва, leading-ЕТ хевристика, консорциум ДЗЗД запазва `kind`. |
| [`packages/db/src/queries/companies.test.ts`](../packages/db/src/queries/companies.test.ts) | `streamCompaniesCsv masking` (4 теста) | Двата клона на `source()` (rollup + base-aggregation) маскират ЕТ и запазват ООД. |
| [`apps/web/app/lib/csv-export.test.ts`](../apps/web/app/lib/csv-export.test.ts) | `servedCsvExport privacy` (5 теста) | `X-Robots-Tag: noindex` на MISS/HIT/dynamic за трите CSV повърхности; тялото съдържа етикета и изключва оригиналното име; `Cache-Control` остава `public, max-age=3600`. |
| [`apps/web/app/routes/contract.json.test.ts`](../apps/web/app/routes/contract.json.test.ts) | `maskContractForPrivacy` (3 теста) + `contract.json loader` (4 теста) | Чист хелпер + интеграция през loader-а: ЕТ маскира и получава `noindex`, АД преминава без `noindex`, 404 не е засегнат, `Cache-Control` е `public, s-maxage=3600, stale-while-revalidate=86400`. |

### Финални exit code-ове от `ralph/verification-baseline.md`

Източник: [`ralph/verification-baseline.md`](../ralph/verification-baseline.md) (секция „Post-edit", записана СЛЕД приключване на T-001 … T-012).

| Команда | Exit code | Резюме |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 7 turbo tasks успешни; widened return type на `getContract` и `maskContractForPrivacy` хелперът са ковариантни с предишните форми. |
| `pnpm --filter @sigma/shared test` | 0 | 2 файла, 42 теста минават (включително новите за `isNaturalPersonBidder`, `MASKED_NATURAL_PERSON_LABEL` и shared-predicate surface). |
| `pnpm --filter @sigma/web test` | 0 | 31 файла, 296 теста минават (включително новите 5 в `csv-export.test.ts` и новите 7 в `contract.json.test.ts`). |
| `pnpm --filter @sigma/db test` | 1 | 25 файла, 174 теста, 171 минават, 3 **предварително съществуващи** failure-а (не са въведени от тази промяна): `integrity-checks.test.ts` (rollup-reconciliation) и два timeout-а в `refresh-slice.test.ts`. Маскиращите файлове (`contracts.test.ts`, `companies.test.ts`) минават изцяло. |
| `pnpm lint` | 1 | 5 **предварително съществуващи** prettier warning-а във файлове извън обхвата (`RiskIndicators.tsx`, `riskLogic.test.ts`, `companies.test.ts`, `companies.ts`, `contract.json.test.ts`). `docs/architecture.md` е в `.prettierignore`. |

Нетният delta спрямо чистия baseline (преди прилагане на T-001 … T-012): **+11 нови теста, 0 нови failure-а** (преди: 160 passed / 3 failed; след: 171 passed / 3 failed). Промяната не влошава нито един предварително съществуващ failure, както изисква success criteria.

### Оперативна бележка

При първото bulk презареждане след deploy-а на тази промяна R2 обектите под `csv/<route>/<freshnessVersion>` ще бъдат презаписани с вече маскирани байтове. До този момент — ако някой направи `wrangler r2 object get` — може да види оригиналните CSV файлове в кеша. Това е приемливо защото (1) файловете са в `robots.txt` + `X-Robots-Tag: noindex` и не се индексират, и (2) следващото презареждане ще ги подмени естествено.
