# Деплой на СИГМА към Cloudflare

Деплой-наборът на СИГМА е **два Worker-а, които споделят един D1 за всяка среда**: **`sigma`**
(SSR explorer-ът — `apps/web`) и **`sigma-etl`** (cron-задействаният refresh Workflow —
`apps/etl`). Останалите приложения извън обхвата на v1 не се деплойват.

Explorer-ът чете D1 директно; ETL-ът пише в **същия** D1. Локално двата споделят един miniflare
D1 (vite `persistState`), а в облака — чрез свързване към **един и същ `database_id`**.
Committ-натите `wrangler.*` файлове държат нулеви (zero-UUID) dummy стойности, така че локалната
разработка / miniflare работи без промяна, а реалните идентификатори **и** имена на ресурси идват от
**env променливи в момента на деплой** — затова едно и също дърво с код се деплойва към произволен
брой цели (production, staging, втори акаунт) без редакция на файлове.

## Среди

| | Production | Staging | Production-v2 (бъдеще) |
|---|---|---|---|
| Web worker → URL | `sigma` → **sigma.midt.bg** (зад Access; workers.dev изключен) | `sigma-stage` → sigma-stage.cf-midt.workers.dev (зад Access) | ново име, 3-ти URL |
| ETL worker | `sigma-etl` (cron) | `sigma-etl-stage` (cron) | — |
| Workflow (глобален за акаунта) | `sigma-refresh` | `sigma-refresh-stage` | — |
| D1 база | `sigma` | `sigma-stage` (**отделна** база) | собствена база |
| CF акаунт | obecto | obecto (засега споделен) | **отделен** акаунт |
| GitHub Environment | `production` | `staging` | `production` (пренасочен) |

Staging/dev разчитат на автоматичния `workers.dev` хост — наричането на worker-а `sigma-stage` е
достатъчно, за да обслужва `sigma-stage.cf-midt.workers.dev` (без конфигуриране на routes).
**Production** допълнително получава custom домейна `sigma.midt.bg` и Cloudflare Access gate преди
пускане — виж *Заключване преди пускане* (§6) по-долу.

Всяка среда има **своя собствена D1 база** (*същият акаунт ≠ същата база*). В рамките на една среда
web + etl споделят един D1, така че explorer-ът чете това, което ETL-ът записва; между средите никога
не се докосват.

## Как работи — рендериране през env променливи

Деплоят никога не редактира committ-натите `wrangler.*`. `deploy` скриптът на всеки пакет изпълнява
`build → render → deploy`: [scripts/wrangler-render.mjs](../scripts/wrangler-render.mjs) чете env
променливите и записва временен, gitignore-нат `wrangler.deploy.*`, който `wrangler deploy --config`
изпраща.

```
react-router build                                              # name:"sigma", id: 0000…0000
node scripts/wrangler-render.mjs build/server/wrangler.json     # чете env → wrangler.deploy.json
wrangler deploy --config build/server/wrangler.deploy.json      # изпраща рендерирания файл
```

Единствената разлика между staging и production деплой е **кои стойности на env променливите са в
обхват**:

| env променлива | production | staging | потребител |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | prod token | staging token | wrangler (auth) |
| `CLOUDFLARE_ACCOUNT_ID` | obecto | obecto (засега същият) | wrangler (auth) |
| `SIGMA_D1_ID` | prod D1 id | **staging D1 id** | render → `database_id` |
| `SIGMA_WEB_NAME` | *(незададена → `sigma`)* | `sigma-stage` | render → име на web worker |
| `SIGMA_ETL_NAME` | *(незададена → `sigma-etl`)* | `sigma-etl-stage` | render → име на etl worker |
| `SIGMA_WORKFLOW_NAME` | *(незададена → `sigma-refresh`)* | `sigma-refresh-stage` | render → `[[workflows]] name` |
| `SIGMA_D1_NAME` | *(незададена → `sigma`)* | `sigma-stage` | render → `database_name` **+** provisioning/seed скриптовете |
| `SIGMA_CSV_CACHE_NAME` | *(незададена → `sigma-csv-cache`)* | `sigma-csv-cache-stage` | render → `r2_buckets[].bucket_name` на web worker-а |

Всяка променлива за име по подразбиране е своята committ-ната стойност, така че когато всички са
незададени, рендерът е **байт-идентичен с днешния** (само `database_id` се подменя) — инвариантът за
безопасност на production.

> Имплементация на рендера: бърз път записва низа с подменен sentinel без промяна, когато никоя
> променлива за име не е зададена (запазва байт-идентичността и `.jsonc` коментарите). Когато е
> зададена променлива за име, web конфигурацията (`.json`/`.jsonc`) се парсва → мутира →
> стрингифицира, а ETL конфигурацията (`.toml`) се пренаписва по поле — `name`←`SIGMA_ETL_NAME`,
> `[[workflows]] name`←`SIGMA_WORKFLOW_NAME`, `database_name`←`SIGMA_D1_NAME`; `database_id` идва от
> sentinel-а `SIGMA_D1_ID`. `class_name`/`binding` никога не се променят.

### Защо явни имена (запис на решение)

Всеки ресурс получава своя собствена env променлива, вместо имената да се извличат от един суфикс от
типа `-stage`:

- **Един източник на истина за името на D1.** `SIGMA_D1_NAME` е *същата* променлива, която
  provisioning/seed скриптовете ([bootstrap.mjs](../scripts/bootstrap.mjs),
  [import.mjs](../scripts/import.mjs) и `load-*.mjs` loader-ите) използват, за да насочат към D1 — и
  тя също определя рендерирания `database_name`. Затова деплойнатата конфигурация не може да се
  разминава с базата, която реално сте създали/заредили.
- **Самодокументиращо и без ограничения.** Един GitHub Environment изброява точно какво изпраща
  (`SIGMA_WEB_NAME=sigma-stage`, …) без аритметика на суфикси, а бъдещ production на втори акаунт е
  свободен да използва произволни имена, не наложена `sigma-` основа.

Това е чисто, защото рендер скриптът е **field-aware** — няма двусмислие между worker `name` "sigma" и
`database_name` "sigma".

### Защо GitHub Environments

Полето `environment:` на деплой job-а избира секретите/променливите на коя среда да се резолвнат, така
че *един и същ* workflow изпраща към staging или production само въз основа на това кои credentials +
имена са в обхват. Environments са и естественото място за бъдещ production на отделен акаунт (просто
попълвате неговите секрети) и за опционален ръчен gate за одобрение на production.

## 0. Предпоставки (еднократно)

- Cloudflare акаунт на план **Workers Paid** (нужен за Workflows и за ~1,4 GB D1).
- Credential:
  - **CI (препоръчително):** API token, съхранен като GitHub **Environment secret**
    (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`); деплоят тръгва от
    [.github/workflows/deploy.yml](../.github/workflows/deploy.yml). Без дълготраен credential на
    нито една машина за разработка (съгласно [AGENTS.md](../AGENTS.md)).
  - **Локално (provisioning/seeding + опционален ръчен деплой):** предпочитайте
    `pnpm exec wrangler login` (OAuth сесия — няма какво да се изтрива след това) пред поставен token.

> **Какво прави CI vs. какво е еднократно ръчно.** CI само **деплойва** (`wrangler deploy`). То не
> може да изпълни стъпки 1–2 по-долу: provisioning-ът произвежда `database_id`, който CI се нуждае
> като секрет (проблем "кокошка и яйце"), а първоначалното зареждане на данни се нуждае от
> gitignore-натия `data/` корпус. Направете стъпки 1–2 веднъж, локално, за всяка среда; след това CI
> деплойва, а cron-ът на `sigma-etl` поддържа данните свежи.

### Минимални scope-ове за API token

Custom token-ът се нуждае само от тези **Account**-ниво права (не може да се ограничи до един Worker —
виж *Бележки → Обхват на достъпа*): Workers Scripts **Edit**, D1 **Edit**, Workers R2 Storage **Edit**
(explorer-ът свързва R2 bucket-а `sigma-csv-cache`) и Account Settings **Read**. Същите scope-ове
покриват и provisioning, и деплой. (Workflows се изпращат като част от Worker-а `sigma-etl`, така че
не е нужно отделно **Workflows** право — то се покрива от Workers Scripts: Edit; някои dashboard-и не
изброяват самостоятелен Workflows scope.)

## 1. Provisioning на D1 (за всяка среда, локално)

Всяка среда получава **собствена** база. `SIGMA_D1_NAME` избира името (по подразбиране `sigma`):

```bash
# production (име по подразбиране)
pnpm bootstrap:apply                                          # → wrangler d1 create sigma

# staging
SIGMA_D1_NAME=sigma-stage node scripts/bootstrap.mjs --apply # → wrangler d1 create sigma-stage
```

Запишете отпечатания **D1 `database_id`** и го съхранете като секрет `SIGMA_D1_ID` на съответната
среда — **не** в committ-натите `wrangler.*` файлове (които пазят zero-UUID dummy за локална
разработка).

> `bootstrap.mjs` действа върху акаунта, към който `wrangler` е автентикиран в момента, и само
> *създава* + отпечатва id-то (не го свързва никъде). Ако базата вече съществува, create-ът се проваля
> меко; прочетете id-то обратно с `wrangler d1 info <name>`.

## 2. Зареждане на данните (за всяка среда, локално)

```bash
# production
node scripts/import.mjs --remote

# staging
SIGMA_D1_NAME=sigma-stage node scripts/import.mjs --remote
```

Това мигрира схемата, зарежда EOP staging данните (от отворената емисия `storage.eop.bg` — подменяема
с `EOP_OPEN_DATA_BASE_URL`), извежда анексите, зарежда валутните курсове + NUTS, нормализира до
domain таблиците и преизчислява rollup-ите + FTS.

> **`SIGMA_D1_NAME` пази production от seed.** `import.mjs` и **всеки** `load-*.mjs` loader насочват
> към базата по име чрез `SIGMA_D1_NAME`; без него те по подразбиране насочват към `sigma`. Винаги го
> задавайте при зареждане на non-prod среда.

> **Уговорка за bulk-зареждане.** Всяка стъпка минава през `wrangler d1 execute --remote --file` —
> единственият bulk път в wrangler 4.x (няма `wrangler d1 import`). Бавно, но осъществимо през API за
> ~190 хил.-редовите staging + domain таблици — сметнете ~20 мин. за свежо отдалечено зареждане.
> Пълната база е ~1,4 GB вкл. staging (в рамките на 10 GB лимита на Paid). След първото зареждане cron
> Workflow-ът я поддържа свежа инкрементално (никога не презарежда базата).

> **Две уловки, ако зареждате от sqlite `.dump`:** D1 отхвърля `PRAGMA foreign_keys = OFF;`, `BEGIN
> TRANSACTION;`, `COMMIT;` и `PRAGMA writable_schema = ON;` (последното е това, което `.dump` издава,
> за да пресъздаде FTS5 virtual таблиците). Махнете тези редове и преизградете `search_index` с
> обичайната рецепта `INSERT INTO search_index ... SELECT ... FROM contracts` от
> [scripts/precompute.sql](../scripts/precompute.sql) — не изпращайте FTS съдържание през dump.

> Промени в схемата след първото зареждане се прилагат out-of-band, за всяка среда:
> `SIGMA_D1_NAME=sigma-stage wrangler d1 migrations apply sigma-stage --remote`. Деплоите не мигрират
> и не презареждат данни.

## 3. Конфигуриране на GitHub Environments

Създайте две среди (repo Settings → Environments):

**`production`** (огледало на днешните repo секрети, така че prod поведението не се променя):
- секрети `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SIGMA_D1_ID` (prod)
- променливи: *(не са нужни — всяка променлива за име по подразбиране е committ-натата prod стойност)*

**`staging`**:
- секрети `CLOUDFLARE_API_TOKEN` (засега същият акаунтски token е добре), `CLOUDFLARE_ACCOUNT_ID`
  (= obecto), `SIGMA_D1_ID` (новата `sigma-stage` D1)
- променливи `SIGMA_WEB_NAME` = `sigma-stage`, `SIGMA_ETL_NAME` = `sigma-etl-stage`,
  `SIGMA_WORKFLOW_NAME` = `sigma-refresh-stage`, `SIGMA_D1_NAME` = `sigma-stage`

> Средата `production` е **неблокираща** за създаване: дори с `environment: production` зададено на
> job-а, GitHub все още излага repo-ниво секретите, така че production продължава да се деплойва с
> днешните repo секрети, докато не решите да ги преместите в средата.

> Опционално подсилване: дайте на `production` **required reviewers**, за да изчака prod деплой ръчен
> клик "Review deployments".

## 4. Деплой

Единственият workflow [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) преобразува git
събитие → среда и деплойва двата Worker-а:

- **Production** — push на version tag (издаване на release):
  ```bash
  git tag v1.0.0 && git push origin v1.0.0          # → production
  ```
- **Staging** — ръчно стартиране:
  ```bash
  gh workflow run deploy.yml -f environment=staging  # → staging  (или Actions tab → Run workflow)
  ```

Job-ът `deploy` задава `environment: <target>`, така че `${{ secrets.* }}` / `${{ vars.* }}` се
резолвват от съответната среда, после проверява credentials-ите, прави type-check и изпълнява
`pnpm --filter @sigma/web run deploy` + `pnpm --filter @sigma/etl run deploy`. Per-среда
`concurrency` група пречи staging build да блокира production release.

> **Ръчно (еднократно, опционално):** с правилните env променливи, заредени локално, можете да
> изпълните същите `pnpm --filter @sigma/web run deploy` / `pnpm --filter @sigma/etl run deploy` от
> машина — но CI е предвиденият път, за да остават credentials-ите извън лаптопите.

Деплоят на `apps/web` презаписва каквото в момента обслужва това worker име с живия SSR explorer.
ETL-ът по необходимост е отделен worker — той носи cron trigger-а и класа `RefreshWorkflow`.

## 5. Верификация

- Отворете worker URL-а (напр. `https://sigma.cf-midt.workers.dev/` или
  `https://sigma-stage.cf-midt.workers.dev/`) — реални суми (~190 хил. договора · ~50,8 млрд. €).
- Dashboard → **Workflows** → refresh Workflow-ът на средата (`sigma-refresh` / `sigma-refresh-stage`)
  е в списъка. Няма публичен HTTP trigger; ръчни/backfill стартирания минават през Dashboard или
  `wrangler workflows trigger <name>`. Cron-ът (`0 */6 * * *`) после опреснява без надзор.
- Уверете се, че production е **недокоснат**, когато деплойвате staging (различен worker + D1 + lane).

## 6. Заключване преди пускане — Cloudflare Access (Zero Trust)

СИГМА е публичен портал за прозрачност, но и двете внедрявания се държат **частни до пускане** зад
**Cloudflare Access**. Production (`sigma.midt.bg`) е заключен **преди пускане** и се отваря на
go-live (без redeploy); staging остава заключен постоянно за екипа.

> **Решение: Access, не in-worker парола.** По-ранен план заключваше *вътре* в worker-а (KV
> `published` флаг + Basic Auth), защото Access не можеше да защити `workers.dev` URL, а v1 нямаше
> custom домейн. И двете предпоставки се промениха — production вече използва custom домейна
> `sigma.midt.bg`, а Cloudflare добави one-click Access и за `workers.dev`. Access е по-силният избор:
> работи на ръба (преди worker-а *и* кеша), дава реална идентичност / SSO / audit и **покрива статични
> assets** (без soft-vs-hard-gate компромис), без приложен код. In-worker gate-ът е изваден от
> употреба.

**Предпоставка.** `midt.bg` трябва да е Cloudflare **зона в същия акаунт** като worker-а `sigma` —
Workers Custom Domains и self-hosted Access apps се закачат към зона, която контролирате. Ако DNS-ът ѝ
още не е на Cloudflare, добавете домейна и сменете nameservers (или делегирайте `sigma.midt.bg`).

**a. Поставете worker-а на хоста.** Workers & Pages → `sigma` → Settings → Domains & Routes →
Add → **Custom Domain** → `sigma.midt.bg` (Cloudflare авто-създава DNS записа + TLS сертификата).
Еквивалент в конфигурацията: `"routes": [{ "pattern": "sigma.midt.bg", "custom_domain": true }]` — но
засега го закачете out-of-band, за да не се задейства и при `sigma-stage` деплоя (виж бележката за
`workers_dev` по-долу).

**b. Защитете го с Access.** Zero Trust dashboard (`one.dash.cloudflare.com`, безплатно до 50
потребители) → Access → Applications → **Add → Self-hosted**:
- Application домейн: subdomain `sigma`, домейн `midt.bg` (празен path = целият сайт).
- Policy → **Allow**, Include = вашите хора: списък *Emails*, *Emails ending in* `@obecto.com` или
  група от identity provider.
- Метод за вход: вграденият **One-time PIN** на Cloudflare (код по имейл) работи без IdP; добавете
  Google / Microsoft Entra / GitHub под Settings → Authentication за SSO.

**c. Затворете заобикалянето.** Изключете `workers.dev` за prod worker-а (**`workers_dev = false`**,
или изключете route-а в dashboard-а) — иначе `sigma.<sub>.workers.dev` остава публичен backdoor около
gate-а. Това е стъпката, която хората забравят.

**Тест.** `https://sigma.midt.bg` → пренасочване към Access вход → сайт; имейл извън списъка е
отказан; `workers.dev` URL-ът вече не отговаря.

**Публично на пускане (без redeploy).** Изтрийте Access приложението на `sigma.midt.bg` или задайте
неговата policy на **Bypass / Everyone**. Staging пази своето приложение, така че екипният preview
остава частен; пре-заключете prod по всяко време чрез възстановяване на policy-то.

**Staging gate.** Същата идея — one-click *Enable Cloudflare Access* на
`sigma-stage.<sub>.workers.dev` (Settings → Domains & Routes) или дайте на staging
`staging.sigma.midt.bg` + собствено Access приложение.

> **`workers_dev` е per-среда.** Prod иска `false` (заключен custom домейн); staging на workers.dev
> иска `true`. Затова или дайте на staging собствен custom subdomain (и двете `false`, една
> committ-ната стойност), или направете `workers_dev` env-задвижвана render стойност като имената —
> **не** committ-вайте поголовно `workers_dev: false`, иначе ще изключите workers.dev URL-а на
> staging.

> **Bypass за автоматизация / IaC.** Ако нещо трябва да достигне заключен prod (uptime check и т.н.),
> добавете **Service Token** policy или IP bypass. Access приложението + policy може да се управлява и
> като код (Terraform `cloudflare_zero_trust_access_application` / `_policy`) вместо click-ops. ETL-ът
> не се нуждае от нищо тук — `sigma-etl` е cron-only без публична повърхност.

## Гаранции за изолация — защо staging не може да докосне production

Три независими стени; всяка една е достатъчна:

1. **Различни worker имена.** Staging рендер произвежда `sigma-stage` / `sigma-etl-stage`;
   `wrangler deploy` презаписва само worker-а, именуван в неговата конфигурация — не може да пише в
   `sigma`.
2. **Различен D1.** Staging свързва `sigma-stage` id-то; prod базата `sigma` никога не се именува в
   staging рендер. Seed/provision скриптовете (`import.mjs` + всеки `load-*.mjs`) насочват към базата
   по име чрез `SIGMA_D1_NAME` — без него по подразбиране е `sigma`, така че тази променлива е
   guard-ът, който пази production от seed.
3. **Различни credentials / lane.** Staging използва секретите на средата `staging` и concurrency
   групата `deploy-staging`. Когато production-v2 премине на собствен акаунт, акаунтската граница става
   четвърта стена: staging token няма достъп до prod акаунта изобщо.

## Данни и cron-ът на ETL

Историческата база на ЦАИС ЕОП се зарежда от публичната EOP MinIO open-data емисия —
[scripts/load-eop.mjs](../scripts/load-eop.mjs) → `https://storage.eop.bg` (подменяема с
`EOP_OPEN_DATA_BASE_URL`). Емисията е **отворена** → seed-ът в стъпка 2 просто работи.

Деплойнатият cron `RefreshWorkflow` ([apps/etl/src/index.ts](../apps/etl/src/index.ts)) дърпа същата
EOP емисия върху малък скорошен прозорец на всеки 6 часа (cron `0 */6 * * *`), стартирайки durable
Workflow-а `sigma-refresh`; големите догонвания остават за CLI-то (`pnpm run import --catchup`). Подробно
за pipeline-а — в [`docs/etl.md`](etl.md).

> По-ранните pipeline-и през `data.egov.bg` (OCDS) и админ-експорта на АОП са изведени от употреба;
> единственият текущ източник е EOP MinIO (`storage.eop.bg`). Обмислете разместване на staging
> графика (напр. `30 */6 * * *`), за да не удря източника в същата минута като prod.

## Бележки

- **Runtime секрети.** Explorer-ът не се нуждае от нито един (read-only публични данни). **ETL-ът**
  няма runtime секрет и няма публична HTTP повърхност — върви cron-only и не може да бъде задействан
  през интернет. Секретите в `.dev.vars` остават за AI gateway / Anthropic и credentials-ите за
  националните регистри, използвани от ETL/ingest и планирания асистент (виж
  [`docs/spec/ai-assistant.md`](spec/ai-assistant.md)).
- **Обхват на достъпа.** Cloudflare API token-ите се скоупват по право + акаунт, **не** надолу до един
  Worker script (`Workers Scripts: Edit` е акаунт-широко). За истинска изолация "само СИГМА" сложете
  СИГМА worker-ите в собствен Cloudflare акаунт и скоупнете token-а към него (това е production-v2
  планът). Иначе използвайте минималните scope-ове по-горе и дръжте token-а в CI, а не на лаптоп.
- **Кеширане на страниците** става чрез `Cache-Control` хедъри + per-colo Cache API
  ([apps/web/app/lib/cache.ts](../apps/web/app/lib/cache.ts)) — без нужда от KV namespace. Worker-ът
  нормализира cache ключовете до query параметрите, които loader-ите консумират, така че непознати
  query параметри се сливат в същия кеширан запис, вместо да форсират свежа D1 агрегация. Cloudflare
  ресурсите, които СИГМА provision-ва, са D1 **плюс R2 bucket-а `sigma-csv-cache`**, който explorer-ът
  свързва (`CSV_CACHE`) за кеширане на CSV експорта — и двата са env-рендерирани (`SIGMA_D1_*` /
  `SIGMA_CSV_CACHE_NAME`), така че staging и production никога не споделят storage. CSV експортите не
  се кешират на ръба и са защитени от Workers Rate Limiting binding-а `CSV_RATE_LIMITER` (10/60s);
  cache miss-овете на `/companies` и `/authorities` са защитени от `AGG_RATE_LIMITER` (30/60s).
- **Бележки по поправки в сигурността.** Route matching-ът на worker-а нормализира декодирани/малки
  пътища и маха завършващите наклонени черти, така че `/contracts.csv/` достига същия CSV limiter gate
  като `/contracts.csv`, а `/companies/` / `/authorities/` достигат същия агрегационен gate като
  безчертовите си форми. Статичните assets се обслужват от Workers Assets, а не от SSR Worker-а;
  техните security хедъри идват от [apps/web/public/_headers](../apps/web/public/_headers), който се
  копира в built client assets. URL енкодингът на sitemap-а маха XML-невалидните C0 контроли преди
  escape-ване, предотвратявайки лош upstream байт да счупи sitemap страница. Keyset pagination
  cursor-ите са обвързани с един комбиниран integrity token за реда на подреждане плюс каноничния
  активен набор от филтри, така че cross-filter cursor replay се проваля затворено (fail closed) и
  рестартира пагинацията.
- **Чеклист за custom домейн.** В production Worker-ът пренасочва cleartext HTTP към HTTPS преди
  обработката на route-а. За production custom домейна задайте Minimum TLS Version 1.2, включете
  Always Use HTTPS, подайте/верифицирайте HSTS preload и добавете case-insensitive WAF rate правило на
  `*.csv` като зона-ниво backstop (не е налично на `workers.dev`).

## Production-v2 (бъдеще, отделен акаунт)

Без промяна в кода: създайте средата `production` с `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` /
`SIGMA_D1_ID` на новия акаунт, задайте нейните променливи за имена (оставете незададени, за да запазите
`sigma`/`sigma-etl`/…, или задайте явни имена за отделна идентичност), provision-нете + seed-нете
нейната D1 по същия начин и деплойнете. Env-рендерирането вече поддържа N цели.

---

# Runbook: reseed на отдалечен D1 (staging/prod) от локално преизградена база

Използвайте това, за да направите D1-а на дадена отдалечена среда идентичен с чисто локално
преизграждане **без** да пускате тежкия ingest отново отдалечено.

## Принцип: секретът е източникът на истина, името е декорация

Деплойнатият worker свързва D1 по **`database_id`** — стойността `SIGMA_D1_ID`, която
`scripts/wrangler-render.mjs` подменя в `wrangler.deploy.*` — и **никога по име**. Затова "коя база е
жива" се определя изцяло от `SIGMA_D1_ID`; *името* на D1 е просто етикет.

**Не** се опитвайте да пазите едно канонично име като `sigma-stage`. D1 имената са **уникални за
акаунт и не могат да се преименуват** (няма `wrangler d1 rename`, няма API rename), а суап без
прекъсване изисква старата база жива, докато новата се seed-ва — което така или иначе налага второ име.
Вместо това поддържайте **два постоянни слота** и местете секрета между тях.

## Blue/green слотове (стандартът за двете среди)

Всяка среда има **две дълготрайни D1 бази** ("слотове"). Живият е този, към който сочи `SIGMA_D1_ID`;
другият е празен ход и същевременно е мигновеният rollback. Един reseed изпраща в празния слот и
обръща указателя — **никога** create/rename/delete на горещия път (след еднократното създаване на
слотовете).

| среда | слотове | жив указател | worker / etl / workflow (непроменени между reseed-ите) |
|---|---|---|---|
| **staging** | `sigma-stage-blue` · `sigma-stage-green` | `SIGMA_D1_ID` (staging env секрет) | `sigma-stage` / `sigma-etl-stage` / `sigma-refresh-stage` |
| **production** | `sigma-blue` · `sigma-green` | `SIGMA_D1_ID` (production env секрет) | `sigma` / `sigma-etl` / `sigma-refresh` |

Дефинирайте **двата** слота постоянно в migrate конфигурацията (`apps/web/wrangler.jsonc` или
отделен `wrangler.migrate.jsonc`), така че `wrangler d1 migrations apply <slot>` винаги да се резолвва
— **без per-reseed временен binding**. Само D1 *id*-то зад binding-а мърда при суап; имената на
worker/ETL/workflow никога не се променят.

> **Защо слотове вместо `<name>-next`:** името спира да има значение. Два стабилни етикета + указател
> (`SIGMA_D1_ID`) е стандартната blue-green форма; премахва изцяло проблема с преименуването (D1 не
> може да се преименува) и churn-а от create/delete.

> **Нюанс за байт-идентичността на prod.** Деплой-секцията по-горе пази prod рендера байт-идентичен,
> когато променливите за имена са незададени. `SIGMA_D1_NAME` задава само козметичния `database_name`
> (binding-ът е по id), а guard-ът срещу презаписване на грешния *worker* идва от
> `SIGMA_WEB_NAME`/и т.н., не от името на базата — затова насочването на prod към `sigma-green`
> означава просто `SIGMA_D1_NAME=sigma-green`. Дръжте един prod слот именуван `sigma` (текущата база),
> за да остане рендерът при незададени променливи байт-идентичен до първия слотов reseed на prod;
> партньорският слот е `sigma-green`.

### Възприемане на слотовете и извеждане на старите бази от употреба

- **Създайте слотовете лениво, при _следващия_ деплой на всяка среда.** Ако двата слота на дадена
  среда още не съществуват, следващият деплой, който докосва тази среда, ги създава първо (стъпка 1 от
  процедурата), после изпраща + обръща — няма отделен migration pass.
- **За всяка среда независимо.** Staging и production възприемат слотовете при **своя** следващ деплой.
  Staging-only деплой създава/използва **само** слотовете `sigma-stage-*` и **не** трябва да създава
  или докосва production слотовете `sigma-*` (и обратно). Възприемете и двете само когато умишлено
  деплойвате и двете.
- **Изведете старата база само след потвърден, здрав деплой — и само с изрично потвърждение от
  потребителя.** Щом новият слот е жив и верифициран, заместената **legacy / pre-slot** база се
  изтрива, за да се избегне бъркотия и разход — но **никога автоматично**. Винаги питайте потребителя
  за потвърждение преди `wrangler d1 delete` и пре-проверете, че името се резолвва към *legacy* id-то
  (не жив слот и не базата на другата среда), преди да изтривате.
- **Установеното състояние пази двата слота.** След възприемането двата слота са постоянни: празният е
  rollback-ът на дълбочина един reseed и се *презаписва* (изтрива се + изпраща наново) при следващия
  reseed, **не** се изтрива. Затова "изтрий старата база" е еднократното legacy извеждане по-горе —
  rolling reseed-ите не изтриват нищо.

## Защо не `import.mjs --remote`

`node scripts/import.mjs --remote` пуска in-place `runFullDerive` срещу отдалечения D1, който изпълнява
`derive-amendments.sql` като едно `wrangler d1 execute --remote` твърдение. Това твърдение отнема
десетки минути локално и **надхвърля ~30s per-query CPU лимита на D1** на отдалеченото. Затова
in-place отдалеченият път не е приложим за пълен reseed. Вместо това преизградете локално и **изпратете
готовите domain таблици** с [scripts/ship-domain.mjs](../scripts/ship-domain.mjs) (chunked inserts,
всеки доста под лимита), после го оставете да пусне `precompute.sql` на целта.

## Предпоставки

1. Чисто локално преизграждане: `node scripts/import.mjs --reset --from=2020-01-01 --to=<последен
   кеширан ден>` (cache-backed; **спрете dev сървъра на `:5173` първо** — той споделя miniflare D1-а и
   конкурентно bulk зареждане сринва `workerd` със SIGBUS). Верифицирайте броячите преди изпращане.
   (Изпращането *от* sqlite-а само го чете — explorer-ът е read-only — затова dev сървърът може да
   остане вдигнат по време на самото изпращане.)
2. `wrangler`, автентикиран към целевия акаунт. Deploy/seed token-ът се нуждае от Workers Scripts + D1
   + Workers R2 Storage + Account Settings (всички **Edit**, Account Read).
3. Пътят на локално обслужвания D1 sqlite:
   `apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<най-голям>.sqlite`.

## Процедура: blue/green reseed (идентична за staging и prod)

Изпратете в **празния** слот, докато живият продължава да обслужва — без празен прозорец, нищо лошо не
се кешира.

1. **Създайте слотовете, ако липсват (първо възприемане само за ТАЗИ среда).** Ако `<env>-blue` /
   `<env>-green` още не съществуват, `wrangler d1 create` и двата и ги добавете като постоянни
   `d1_databases` записи в migrate конфигурацията — само за **тази среда** (staging-only деплой никога
   не създава prod слотовете). Виж секцията *Възприемане на слотовете и извеждане на старите бази от
   употреба* по-горе. След това прескачайте тази стъпка.
2. **Определете празния слот.** `SIGMA_D1_ID` (env секретът) именува живия слот; другият е празен.
   `wrangler d1 list` за id-тата.
3. **Изпразнете празния слот** (children-first, FKs deferred) — безопасно, нищо не сочи към него, нулев
   ефект върху живото. `wrangler d1 execute <idle-slot> --remote --file wipe.sql` (wipe.sql по-долу).
   Това избягва `--replace` FK-ordering опасността и значи, че изпращате в чиста схема.
4. **Изпратете в празния слот:**
   `SIGMA_D1_NAME=<idle-slot> node scripts/ship-domain.mjs --work-db=<local.sqlite> --remote --yes`.
   Прилага миграциите (резолвва се, защото слотът е в конфигурацията), изпраща domain таблиците в ред
   на FK зависимост и пуска `precompute.sql` (преизгражда rollup-ите + FTS `search_index` — никога не
   изпращайте FTS съдържание през sqlite dump). ~15-20 мин. `ship-domain` верифицира броя редове на
   всяка таблица спрямо източника.
5. **Верифицирайте празния слот** спрямо локалното: `contracts`,
   `date_flag='signed_after_publication'`, `amendments`, шестте core таблици и решаващо
   **`home_totals` има `id=1`** с реални стойности (homepage loader-ът чете `home_totals WHERE id = 1`).
6. **Обърнете указателя.** Задайте `SIGMA_D1_ID` → id-то на празния слот и `SIGMA_D1_NAME` → неговото
   име (CI env секрет/променлива или локален env за ръчен деплой). Redeploy на web + ETL, после
   `wrangler workflows trigger <env-workflow>`, за да придвижи новия слот до текущия ден.
7. **Верифицирайте живото** (свежи homepage суми, date-flag badge, year филтър, pentest поправки). На
   custom домейн **purge-нете edge кеша** след суапа (виж уговорката); на `*.workers.dev` той се
   самолекува при TTL.
8. **Rollback прозорец.** Предишният слот остава непокътнат като мигновен rollback — обърнете
   `SIGMA_D1_ID` обратно и redeploy. Той се **презаписва при следващия reseed**, така че rollback-ът е
   на дълбочина един reseed. Никога не изтривайте слот на горещия път.
9. **Изведете legacy базата (само при възприемане).** След като новият деплой е потвърден здрав,
   изтрийте заместената pre-slot база, за да избегнете бъркотия/разход — **само с изрично потвърждение
   от потребителя** и само след като верифицирате, че името се резолвва към това legacy id (никога жив
   слот, никога другата среда). Установените reseed-и не изтриват нищо — предишният слот е rollback-ът.

### wipe.sql (изпразване на слот, children-first)

```sql
PRAGMA defer_foreign_keys=ON;
DELETE FROM search_index; DELETE FROM flow_pairs; DELETE FROM facet_counts;
DELETE FROM sector_totals; DELETE FROM authority_totals; DELETE FROM company_totals;
DELETE FROM home_totals; DELETE FROM amendments;
DELETE FROM contracts; DELETE FROM lots; DELETE FROM tenders; DELETE FROM parties;
DELETE FROM bidders; DELETE FROM authorities; DELETE FROM data_freshness;
DELETE FROM fx_rates; DELETE FROM nuts_regions;
```

> **Нюанс с миграциите на `ship-domain`.** Той пуска `wrangler d1 migrations apply <name>`, който се
> нуждае слотът да е в конфигурацията (оттам постоянните slot binding-и). Алтернативно би могъл да
> приложи единствения `0000_init` през `wrangler d1 execute <name> --remote --file …`, който се
> резолвва по име и не се нуждае от binding — възможно опростяване, което би премахнало изискването за
> конфигурация изцяло.

## Резервен вариант: in-place reseed (само за запазване на едно фиксирано име, приема downtime)

Използвайте това *само* когато умишлено искате едно постоянно име на еднократна среда (staging) и
приемате цената — то **не** е по подразбиране. Има **~20-30 мин. влошен прозорец**, **непречистваем
homepage-`0`-и кеш** до ~1ч на `*.workers.dev` и се нуждае от maintenance прозорец далеч от 6-часовите
ETL тиктакания (00/06/12/18 UTC). Предпочитайте blue/green слотове. Стъпки (верифицирайте при всяка):

1. **Backup:** `wrangler d1 export <env> --remote --output=/tmp/<env>-backup.sql`.
2. **Schema parity** (ако е добавена колона): `wrangler d1 execute <env> --remote --command "ALTER
   TABLE …; CREATE INDEX …"` (резолвва се по име; guard, ако съществува).
3. **Wipe `<env>`** с wipe.sql по-горе (`wrangler d1 execute <env> --remote --file wipe.sql`).
4. **Ship:** `SIGMA_D1_NAME=<env> node scripts/ship-domain.mjs --work-db=<local.sqlite> --remote --yes
   --replace` (+ precompute). Верифицирайте.
5. **Deploy** web после ETL, после trigger на workflow-а; верифицирайте живото.

## Schema-only / additive промяна (без пълен reseed, без downtime)

За additive промяна като `date_flag`, при която данните не се изпразват и `home_totals` е непроменена,
същото крайно състояние е постижимо in-place без wipe/downtime/cache експозиция:

```sql
ALTER TABLE contracts ADD COLUMN date_flag TEXT NOT NULL DEFAULT 'ok';
CREATE INDEX IF NOT EXISTS idx_contracts_date_flag ON contracts(date_flag);
UPDATE contracts SET date_flag='signed_after_publication'
  WHERE signed_at IS NOT NULL AND published_at IS NOT NULL
    AND signed_at > date(published_at,'+2 day');
```

Пуснете през `wrangler d1 execute <env> --remote --file …` (резолвва се по име — без binding, без
`ship-domain`), **после** deploy на web (след като колоната съществува, така че `date_flag` select-а в
`details.ts` да е валиден) и ETL. Компромисът спрямо пълен reseed: средата запазва своите
ETL-поддържани редове, вместо да става байт-идентична на локалното преизграждане.

## Уговорка: остаряла homepage и purge на edge кеша

Страници, обслужени с `Cache-Control: s-maxage=3600`, се edge-кешират от Cloudflare по **клиентския
URL** (напр. `/`) и се обслужват **без извикване на worker-а**, докато TTL-ът не изтече. Blue/green
избягва изобщо да кешира лоша страница (старият слот обслужва коректни данни през цялото време). След
**in-place** reseed страница, кеширана по време на празния прозорец, може да обслужва остаряло (напр.
`0`-и) до ~1ч.

**Redeploy на worker НЕ го изчиства** — `DEPLOY_TAG`-ът на worker-а само bust-ва вътрешния
`caches.default`, който седи *зад* този edge кеш.

- **На `*.workers.dev`:** няма **достъп до cache-purge** (не е зона, която контролирате), затова се
  самолекува при изтичане на `s-maxage`, после `stale-while-revalidate` опреснява при следващата
  заявка. Данните са коректни междувременно — верифицирайте през некеширан route (напр. `*.csv`
  експорт).
- **На custom домейн** (напр. `sigma-stage.midt.bg` — зоната `midt.bg` съществува в акаунта): кешът
  **е** purge-ваем при поискване през dashboard-а (Caching → Purge) или
  `POST /zones/{zone_id}/purge_cache` (`purge_everything` или по URL). Препоръчително за staging, така
  че reseed-ът да е мигновено видим.
