# Връщане назад след пускане

Кога: след пускане сайтът показва грешни числа или страници, или новият ETL пише грешно, а поправката
напред не е бърза. Обичайното връщане ползва предишната версия на web и базата, която тя е
обслужвала. Ако между версиите има оттегляне или корекция на публични данни, приложете
[връщане след оттегляне](#връщане-след-оттегляне). Стъпките изпълнява операторът с production
токена.

Пътищата за пускане и кое връщане отговаря на кой са в [deploy.md](../deploy.md) („Три пътя за пускане“).

## Какво да е записано преди пускането

- **Версията на web Worker-а преди пускането:** `wrangler deployments list --name sigma` (id на
  версията, която сега обслужва).
- **Живият слот преди пускането** (`sigma-green`) и неговото id. При пускане с изграждане и превключване
  той остава непокътнат поне седмица — това е връщането на данните.
- **Точката за възстановяване** при малка промяна: bookmark-ът от стъпката „Schema apply“ (в
  обобщението на изпълнението в GitHub Actions).

## Стъпки, в този ред

Не в ±30 минути около 00/06/12/18 UTC (обновяването и регистърът) и не около 03:00 UTC (ходът на
декларациите: в неделя винаги, в другите дни след неуспешен ход).

1. **Спрете ходовете.** За всеки поток на production (`sigma-refresh`, `sigma-registry`,
   `sigma-declarations`, `sigma-rebuild`): `wrangler workflows instances list <поток>` и
   `wrangler workflows instances terminate <поток> <id>` за всеки, който върви.
2. **Паркирайте новия ETL** — махнете графика му, без да качвате код. В обвивка с токена на production и
   без никоя друга `SIGMA_*` променлива:

   ```bash
   env | grep '^SIGMA_'                          # празно
   SIGMA_D1_ID=<id на живия слот> SIGMA_ETL_SCHEDULE=off node scripts/wrangler-render.mjs apps/etl/wrangler.toml
   grep -E '^name|^crons' apps/etl/wrangler.deploy.toml   # първият name е "sigma-etl"; crons = []
   pnpm --filter @sigma/etl exec wrangler triggers deploy --config wrangler.deploy.toml
   ```

   Рендерирането иска `SIGMA_D1_ID`, иначе спира. Име на друга среда в обвивката (напр. от `.env.local`
   на dev) би рендерирало нейния Worker и би паркирало него, не production.

   Потоците му още отговарят на ръчно пускане, но нищо не тръгва само. Новият ETL не може да се смени с
   ETL-а на предишната версия: миграцията на неговия Durable Object не се връща. Докато трае връщането,
   базата не се обновява.

   Графикът (Cron Triggers) не е част от версията на Worker-а: `wrangler rollback` нито го връща, нито
   го маха — сменя се само с `triggers deploy` или `deploy`. `wrangler triggers deploy` е отбелязана от
   wrangler като експериментална; ако откаже, махнете графика от таблото: Workers & Pages → `sigma-etl`
   → Settings → Trigger Events → изтрийте двата cron-а. И двата пътя пипат само графика — нито код, нито
   web, нито базата. Не пускайте Deploy вместо това (виж по-долу).

При предходно оттегляне продължете със стъпките в [„Връщане след оттегляне“](#връщане-след-оттегляне).
Стъпки 3–6 по-долу са за обичайно връщане.

3. **Върнете web:** `wrangler rollback <id на версията отпреди пускането> --name sigma`. Версията носи
   своите bindings, така че web отново чете базата, която е чел преди. В Dev2 това отне около 6 секунди,
   без нито една неуспешна заявка; пак напред — също толкова.
4. **Базата:**
   - **Голяма промяна (изграждане и превключване):** нищо не се пипа — предишният слот е непокътнат, а
     web вече сочи към него. В средата `production` в GitHub върнете `SIGMA_D1_ID` и `SIGMA_D1_NAME` към
     него, за да не го превключи обратно следващото внедряване.
   - **Малка промяна (миграции на място):**
     `wrangler d1 time-travel restore <база> --bookmark=<bookmark> --remote`. Връща цялата база към
     точката; редовете, записани след нея, се губят и обновяването ги записва наново.
5. **Изчистете кеша** на `sigma.midt.bg` (Cloudflare → Caching → Purge Everything на зоната `midt.bg`):
   върнатата версия носи стария си ключ на кеша и иначе обслужва записите си отпреди пускането, докато
   изтекат (до `s-maxage` им). Purge по URL не ги стига ([deploy.md](../deploy.md), „Уговорка: остаряла страница и
   изчистване на кеша").
6. **Проверете** началната страница, списъците, един договор, една фирма, търсенето и методологията.

## Връщане след оттегляне

След спирането на потоците и графика запазете работещия коригиран слот, докато подготвите
заместващата версия. `wrangler rollback`, пренасочването към стар слот и възстановяването на
момент преди корекцията могат отново да публикуват оттеглените данни, включително при празен
кеш. Изпълнете следните стъпки вместо 3–6 от обичайното връщане.

1. **Проверете слота за новата версия.** Потвърдете името и идентификатора на D1 и проверете
   корекцията в основната база и във всички засегнати производни таблици. При обобщения, които
   могат да се обслужат от реплика, потвърдете актуалните им данни и там, преди да се запълва
   кешът. Ако няма проверен коригиран слот, спрете процедурата преди превключването.
2. **Изберете съвместим web ref.** Проверете в Stage, че кодът работи със схемата на избрания слот,
   чете от основната база за засегнатите маршрути с отделни записи или имена и спазва срока за
   обслужване от кеша и локалното оттегляне. Запишете пълния commit SHA.
3. **Пуснете само web върху проверения слот.** При промяна на данните в CSV първо изпълнете
   [подготовката на CSV](#csv-при-оттегляне). След това изпълнете
   [целевия web deploy](#целеви-web-deploy) за всеки засегнат Worker.
4. **Проверете всеки обслужван хост**, включително публичните огледала. Проверете активната
   версия, D1 binding-а и първия и повторния HTTPS отговор за засегнатите страници, пълните
   `.data` заявки, ресурсите и валидните варианти на филтрите. Потвърдете корекцията и при
   запълнен кеш. При засегнати CSV проверете и активния `CSV_CACHE` binding, след което изпълнете
   [проверките на CSV](#проверка-на-csv-след-превключване) на всеки хост. При смяна на слот сверете
   `SIGMA_D1_ID` и `SIGMA_D1_NAME` в production средата в GitHub и за ETL преди следващото обновяване.
   При смяна на кофа запишете проверената `SIGMA_CSV_CACHE_NAME` и в настройките за следващите web
   внедрявания. Повторете проверките след обновяването.

## Целеви web deploy

Използвайте отделен чист checkout с инсталирани зависимости. От корена му в production обвивката
експортирайте `SIGMA_ROLLBACK_REF` с проверения пълен SHA, `SIGMA_WEB_NAME` с името на целевия
Worker (`sigma` за основния хост), `SIGMA_D1_ID` и `SIGMA_D1_NAME` с данните на проверения слот и
`SIGMA_CSV_CACHE_NAME` с проверената кофа (`sigma-csv-cache` при стандартната конфигурация).
Повторете за всеки отделен Worker с неговите стойности.

Блокът изтрива `apps/web/build` в този checkout преди компилация. Изпълнете го целия. При грешка
в която и да е стъпка поправете причината и изпълнете блока отново от началото.

```bash
bash -euo pipefail <<'BASH'
: "${SIGMA_ROLLBACK_REF:?Set the verified commit SHA}"
: "${SIGMA_WEB_NAME:?Set the target Worker name}"
: "${SIGMA_D1_ID:?Set the verified D1 ID}"
: "${SIGMA_D1_NAME:?Set the verified D1 name}"
: "${SIGMA_CSV_CACHE_NAME:?Set the verified CSV bucket}"
checkout=$(git rev-parse --show-toplevel)
cd "$checkout"
revision=$(git rev-parse HEAD)
changes=$(git status --porcelain)
test "$revision" = "$SIGMA_ROLLBACK_REF"
test -z "$changes"
rm -rf -- apps/web/build
started_at=$(node -p 'Date.now()')
SIGMA_DEV_REMOTE_BINDINGS=0 SIGMA_SOURCE_COMMIT="$SIGMA_ROLLBACK_REF" pnpm --filter @sigma/web run build
SIGMA_SHIP_ENV=production node scripts/wrangler-render.mjs apps/web/build/server/wrangler.json
node --input-type=module - "$started_at" <<'NODE'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'apps/web/build/server'
const config = JSON.parse(readFileSync(join(dir, 'wrangler.deploy.json'), 'utf8'))
const db = config.d1_databases.find(({ binding }) => binding === 'DB')
const csv = config.r2_buckets.find(({ binding }) => binding === 'CSV_CACHE')
assert.equal(config.name, process.env.SIGMA_WEB_NAME, 'Unexpected Worker name')
assert.equal(db?.database_id, process.env.SIGMA_D1_ID, 'Unexpected D1 ID')
assert.notEqual(db.database_id, '00000000-0000-0000-0000-000000000000', 'Placeholder D1 ID')
assert.equal(db.database_name, process.env.SIGMA_D1_NAME, 'Unexpected D1 name')
assert.equal(csv?.bucket_name, process.env.SIGMA_CSV_CACHE_NAME, 'Unexpected CSV bucket')

assert.equal(config.main, 'index.js', 'Unexpected Worker entry')
const entry = readFileSync(join(dir, config.main), 'utf8')
const tag = entry.match(/\b(?:var|let|const) DEPLOY_TAG\s*=\s*['"]([a-z0-9]+)['"]/u)?.[1]
const builtAt = Number.parseInt(tag, 36)
assert(builtAt >= Number(process.argv[2]) && builtAt <= Date.now(), 'Missing or stale DEPLOY_TAG')
const chunk = entry.match(/\bcreateRequestHandler\(\s*\(\)\s*=>\s*import\(['"](\.\/assets\/server-build-[\w-]+\.js)['"]\)/u)?.[1]
assert(chunk, 'Missing linked SSR bundle')
const ssr = readFileSync(join(dir, chunk), 'utf8')
const revision = ssr.match(/\bfunction sigmaVersion\(\)\s*\{\s*return ['"]([a-f0-9]{12})['"]/u)?.[1]
assert.equal(revision, process.env.SIGMA_ROLLBACK_REF.slice(0, 12), 'Unexpected build revision')
console.log(`Verified ${config.name}, revision ${revision}, DEPLOY_TAG ${tag}`)
NODE
BASH
```

Проверката чете входния модул от рендерирания конфиг и SSR модула, който той зарежда. Ако
форматът на избрания ref е различен, потвърдете в Stage същите стойности в неговите генерирани
модули и подгответе приложима проверка преди production. След успешен край на целия блок пуснете
проверения артефакт от същия checkout.

```bash
pnpm --filter @sigma/web exec wrangler deploy --config build/server/wrangler.deploy.json
```

Новият `DEPLOY_TAG` сменя ключовете на Web Cache API за всички варианти, включително URL
псевдонимите. Заявка под стария таг може още да завърши запис в старото пространство.

## CSV при оттегляне

Ако корекцията засяга `/contracts.csv`, `/companies.csv` или `/authorities.csv`, проверете версията
на export-а в избрания коригиран слот преди web deploy. Четенето използва `DB` на целевия Worker.
Запазете предишните `ETag` стойности за проверката след превключването. Сверете името и ID на
слота и изпълнете заявката от корена на checkout-а.

```bash
pnpm --filter @sigma/web exec wrangler d1 execute "$SIGMA_D1_NAME" --remote \
  --command 'SELECT refreshed_at FROM home_totals WHERE id = 1'
```

Запишете ефективната версия. Кодът премахва всичко извън `[a-zA-Z0-9]` от `refreshed_at` и
използва `v0` при празна или липсваща стойност. Нефилтрираният export се чете от `CSV_CACHE` с
ключ `csv/<route>/<version>`, където `route` е `contracts`, `companies` или `authorities`. Всички
слотове и Worker-и със същата кофа и версия споделят ключа, включително след смяна на
`DEPLOY_TAG`. [Реализация на CSV export-а](../../apps/web/app/lib/csv-export.ts)

Преди превключването осигурете коригирани обекти, генерирани от проверения слот, под ключове,
които старите заявки и другите слотове не могат да запишат. Ако ползвате същата кофа с доказано
свободна версия, проверете за съвпадение на **ефективната** версия при всички Worker-и и слотове
с достъп до кофата, включително по-рано обслужваните. Потвърдете произхода и съдържанието на
всеки подготвен обект. Изтриването на обект под стар ключ оставя възможност вече започнал
multipart upload да го създаде отново.

При съвпадение на версии или неяснота за стари записи използвайте нова празна кофа. Експортирайте
новото име като `SIGMA_CSV_CACHE_NAME`, създайте кофата и рендерирайте конфигурацията чрез целевия
web deploy. Първият нефилтриран GET генерира обекта от коригирания слот. Давайте достъп до новата
кофа само на Worker-и, които четат проверените коригирани данни. При различни слотове с еднакви
версии, но различно съдържание, използвайте отделни кофи. Ако нито една от двете подготовки е
възможна, спрете преди превключването.

```bash
pnpm --filter @sigma/web exec wrangler r2 bucket create "$SIGMA_CSV_CACHE_NAME"
```

### Проверка на CSV след превключване

За всеки засегнат D1 и `CSV_CACHE` binding и всеки негов публичен хост изтеглете целия засегнат
CSV с чист HTTP клиент, после повторете заявката. Проверете коригираните редове и липсата на
оттеглените стойности и в двете тела. При празна кофа първият GET създава обекта (`X-Csv-Cache: MISS`),
а следващият го чете (`HIT`). При вече подготвен обект и първият GET може да е `HIT`. Проверете
също засегнатите филтрирани export-и (`X-Csv-Cache: dynamic`).

- Изпратете предишния `ETag` с `If-None-Match`. При променени байтове очаквайте `200`, коригираното
  тяло и нов `ETag`.
- За нефилтрирания export изпратете `Range: bytes=0-31` след пълното изтегляне. Проверете `206`,
  `Content-Range` и съответните байтове от коригираното пълно тяло.

Запишете часа на превключване и при проверката отчетете `Cache-Control: public, max-age=3600`.
Получен CSV може да остане свеж в браузър или друг downstream кеш до един час от получаването
му. Проверката с чист клиент установява какво обслужва Worker-ът и не отнема свежестта на вече
получените копия.

## Докато трае връщането

- **Спрете обичайните внедрявания на production** — таговете `v*` и ръчния Deploy. При
  оттегляне приложете целевия web deploy от процедурата по-горе. Всяко внедряване качва web от
  избрания ref (при ръчен Deploy по подразбиране е `main`, т.е. неиздаден код) върху върнатата версия и
  така отменя стъпка 3. Пуска и плана на схемата и синхронизацията на списъците. При голяма промяна след
  стъпка 4 проверката преди запис и без това го отказва: предишният слот не носи версията на данните на
  новия код.
- **Графикът се пипа само както в стъпка 2** — `triggers deploy` или таблото.
- **Поправката напред** минава първо през Stage, после пускането се повтаря по същия път.
