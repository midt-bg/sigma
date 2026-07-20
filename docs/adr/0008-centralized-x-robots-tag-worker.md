# ADR-0008 — Централизирано авторство на `X-Robots-Tag: noindex` в worker-а

- **Дата:** 2026-07-02
- **Статус:** Прието
- **Свързани:** [ADR-0007](0007-privacy-masking.md) (политиката *noindex + маскиране*), [Issue #173](https://github.com/midt-bg/sigma/issues/173), PR #183 (review fixes)
- **Обхват:** Механизма, по който се прилага публичният хедър `X-Robots-Tag: noindex` върху всички машинно-четими повърхности (JSON, CSV, `.data` twin на React Router v7 single-fetch). Не променя продуктовата политика от ADR-0007 — само нейното инженерно реализиране.

## Контекст

ADR-0007 задължава всяка машинно-четима повърхност да носи `X-Robots-Tag: noindex`. Първоначалната имплементация пишеше хедъра **inline на всяко място**, което го изпращаше:

- в loader-а на [`apps/web/app/routes/contract.json.tsx`](../../apps/web/app/routes/contract.json.tsx);
- в четирите клона на [`apps/web/app/lib/csv-export.ts`](../../apps/web/app/lib/csv-export.ts) (`markCsvCache`, динамичният `Response`, 200/206 `Response`, 304 `Response`).

Това създаваше три проблема, установени при code review на PR #183:

1. **Множество авторски sites.** Политиката „кой получава `noindex`" беше разпръсната из route-ове и helper-и. Всяка нова машинно-четима повърхност трябваше да помни да добави хедъра — лесна регресия.
2. **`.data` близнак на `/companies/:eik` оставаше непокрит.** При `ssr:true` React Router v7 single-fetch сервира turbo-stream payload на `/companies/:eik.data`, споделяйки loader-а с HTML отговора. Този payload съдържаше естествено-личностния ЕИК на едноличния търговец и нямаше нито маскиране на тялото, нито `X-Robots-Tag: noindex` — дупка спрямо HTML профила, който вече имаше `noindex` мета таг.
3. **Маркерът не достигаше до HTML отговора.** `getDocumentHeadersImpl` на React Router не пропагира loader хедъри към document response (само `Set-Cookie`), така че дори loader-ът да сложеше маркер, worker-ът не го виждаше на HTML отговора без експлицитно препращане.

## Решение

**Единствено авторско място за `X-Robots-Tag: noindex`** — worker pipeline-ът. Route-овете и helper-ите само *маркират*, worker-ът *превежда*.

1. **Вътрешен маркер.** Въвеждаме константата `PRIVACY_MASK_MARKER = 'X-Privacy-Mask'` и литерала `PRIVACY_MASK_APPLIED = 'applied'` в [`apps/web/app/lib/security.ts`](../../apps/web/app/lib/security.ts). Route/helper, чийто отговор съдържа маскирани естествено-личностни данни, извиква `markPrivacyMaskApplied(headers)`, което слага `X-Privacy-Mask: applied`.

2. **Един преводач.** Функцията `hardenResponse` в [`apps/web/workers/app.ts`](../../apps/web/workers/app.ts) е **единственото** място в авторския код, което пише `X-Robots-Tag: noindex` в изходящия отговор. Тя извиква `applyPrivacyMaskHeaders(headers)` (от същия `security.ts`), което превежда маркера в публичния хедър и **безусловно изтрива** самия маркер — така той не достига нито edge кеша (`edgeCache.put(key, hardened.clone())`), нито клиента.

3. **Маскиране на `.data` at the source.** Loader-ът на [`apps/web/app/routes/company.tsx`](../../apps/web/app/routes/company.tsx) `mutate`-ва `company.eik = null` за разпознати естествени лица и връща `Response.json({...}, { headers: { 'X-Privacy-Mask': 'applied' } })`. Тъй като single-fetch `.data` twin споделя същия loader, маскирането и маркировката се случват автоматично и за двете повърхности.

4. **Препращане през `headers()`.** Route-ът експортира `headers({ loaderHeaders })`, който експлицитно препраща `X-Privacy-Mask: applied` към document response-а — заобикаляйки липсата на авто-пропагация в React Router. Без това worker-ът не би превел маркера за HTML отговора.

## Последствия

- **Една точка за поддръжка.** Всяка бъдеща машинно-четима повърхност (нов feed, нов route) наследява `X-Robots-Tag: noindex` автоматично, стига да извика `markPrivacyMaskApplied(headers)`. Няма как да се „забрави" хедърът на нова повърхност, която вече маркира — макар че добавянето на нова повърхност изисква умишлено поставяне на маркера.
- **Маркерът не изтича.** Изтриването в `hardenResponse` е defensive: дори повторно/идемпотентно извикване оставя вече сложен `X-Robots-Tag` недокоснат и никога не пропуска `X-Privacy-Mask` навън.
- **Разделени тестове.** Loader/helper тестовете твърдят присъствие на маркера **и отсъствие** на `X-Robots-Tag` (последното е прерогатив на worker-а); worker/CSP тестовете твърдят превода. Виж [`security.test.ts`](../../apps/web/app/lib/security.test.ts), [`contract.json.test.ts`](../../apps/web/app/routes/contract.json.test.ts), [`csv-export.test.ts`](../../apps/web/app/lib/csv-export.test.ts), [`company.data.test.ts`](../../apps/web/app/routes/company.data.test.ts) и [`app.nofollow.test.ts`](../../apps/web/workers/app.nofollow.test.ts).
- **`authorities.csv`** получава `X-Robots-Tag: noindex` (маркира се), но без маскиране на тялото — възложителите винаги имат попълнен ЕИК (публични органи). Политическа последователност, не техническо маскиране (както и в ADR-0007).

## Засегнати повърхности

- [`apps/web/workers/app.ts`](../../apps/web/workers/app.ts) — `hardenResponse`: единствен автор на `X-Robots-Tag: noindex`.
- [`apps/web/app/lib/security.ts`](../../apps/web/app/lib/security.ts) — `markPrivacyMaskApplied`, `applyPrivacyMaskHeaders`, `PRIVACY_MASK_MARKER`, `PRIVACY_MASK_APPLIED`.
- [`apps/web/app/routes/contract.json.tsx`](../../apps/web/app/routes/contract.json.tsx) — маркира отговора.
- [`apps/web/app/lib/csv-export.ts`](../../apps/web/app/lib/csv-export.ts) — маркира в четирите клона (вече не пише `X-Robots-Tag`).
- [`apps/web/app/routes/company.tsx`](../../apps/web/app/routes/company.tsx) — `company.eik = null` + маркировка в loader-а; `headers()` препраща маркера за HTML отговора (и `.data` twin-а).
