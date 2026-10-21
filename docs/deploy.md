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

| | Production | Staging | Dev2 (репетиция) | Production-v2 (бъдеще) |
|---|---|---|---|---|
| Web worker → URL | `sigma` → **sigma.midt.bg** (custom домейн, публичен); отговаря и на `sigma.cf-midt.workers.dev` | `sigma-stage` → sigma-stage.cf-midt.workers.dev (публичен, без Access) | `sigma-dev2` | ново име, 3-ти URL |
| ETL worker | `sigma-etl` (cron) | `sigma-etl-stage` (cron) | `sigma-etl-dev2` | — |
| Workflows (глобални за акаунта) | `sigma-refresh` · `sigma-registry` · `sigma-declarations` · `sigma-rebuild` | `sigma-refresh-stage` · `sigma-registry-stage` · `sigma-declarations-stage` · `sigma-rebuild-stage` | `sigma-*-dev2` | — |
| D1 база | `sigma-green` · `sigma-blue` (слотове) | `sigma-stage-blue` · `sigma-stage-green` (**отделни** слотове) | `sigma-dev2-green` · `sigma-dev2-blue` | собствена база |
| CF акаунт | obecto | obecto (засега споделен) | obecto | **отделен** акаунт |
| GitHub Environment | `production` | `staging` | — (на ръка) | `production` (пренасочен) |

Dev2 съществува за репетицията на пускането: същият код и същите проверки като production (`dev2` в
`scripts/deploy-preflight.mjs` е с правилата на production), собствени бази, Worker-и, кофи и лимитери,
нищо общо с production и Stage. Ресурсите ѝ се трият след пускането.

Staging/dev разчитат на автоматичния `workers.dev` хост — наричането на worker-а `sigma-stage` е
достатъчно, за да обслужва `sigma-stage.cf-midt.workers.dev` (без конфигуриране на routes).
**Production** получава и custom домейна `sigma.midt.bg`. Нито една среда не е зад Cloudflare Access, а
web worker-ите не задават `workers_dev`, така че и production отговаря на своя `workers.dev` адрес —
виж §6 (*Публичност, Access и `workers.dev`*).

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
| `SIGMA_REGISTRY_WORKFLOW_NAME` | *(незададена → `sigma-registry`)* | `sigma-registry-stage` | render → registry `[[workflows]] name` |
| `SIGMA_DECLARATIONS_WORKFLOW_NAME` | *(незададена → `sigma-declarations`)* | `sigma-declarations-stage` | render → declarations `[[workflows]] name` |
| `SIGMA_REBUILD_WORKFLOW_NAME` | *(незададена → `sigma-rebuild`)* | `sigma-rebuild-stage` | render → rebuild `[[workflows]] name` |
| `SIGMA_DECLARATIONS_BUCKET` | *(незададена → `sigma-declarations`)* | `sigma-declarations-stage` | render → `r2_buckets[].bucket_name` и `DECLARATIONS_BUCKET` на etl worker-а |
| `SUPPRESSION_SALT` / `SUPPRESSION_KEY_VERSION` | prod salt / версия | staging salt / версия | секрети на etl worker-а за контейнера на декларациите |
| `SIGMA_D1_NAME` | **задължителна:** живият слот `sigma-green` или `sigma-blue` | активният `sigma-stage-blue` или `sigma-stage-green` | render → `database_name` **+** provisioning/seed скриптовете |
| `SIGMA_CSV_CACHE_NAME` | *(незададена → `sigma-csv-cache`)* | `sigma-csv-cache-stage` | render → `r2_buckets[].bucket_name` на web worker-а |
| `SIGMA_REPORTS_NAME` | *(незададена → `sigma-reports`)* | собствено име на средата | render → R2 кофата на асистента (`REPORTS`) |
| `SIGMA_VECTORIZE_NAME` | *(незададена → `sigma-assistant`)* | собствено име на средата | render → Vectorize индекса на асистента |
| `SIGMA_SHIP_ENV` | `production` (committ-натите `namespace_id`) | `staging` | render → `namespace_id` на rate-limit binding-ите на web worker-а (собствен набор за staging и dev, защото id-тата са общи за акаунта) и `SIGMA_SHIP_ENV` на etl worker-а, по която контейнерът на декларациите проверява целевата база |
| `SIGMA_SOURCE_COMMIT` | `github.sha` | `github.sha` | render → `[vars]` на etl worker-а; изграждането записва комита в `data_version` |

> Секретите на etl worker-а се поставят в последната стъпка на деплоя, след самото качване. Между двете
> има кратък прозорец, в който cron тик би заварил worker-а без токен. Ходът тогава не тръгва и в лога
> стои `Missing declaration setting: …` — шумно и безвредно, нищо не се качва наполовина. Ако видите
> това веднага след деплой, просто пуснете хода наново.

> **`SIGMA_D1_NAME` няма безопасна стойност по подразбиране за production.** Незададена, тя оставя
> committ-натото `sigma` — име, което не е слот на production: проверката преди запис
> (`scripts/deploy-preflight.mjs`) спира деплоя, а контейнерът на декларациите
> (`assertD1TargetAuthorized` в `scripts/ship-related-persons.mjs`) отказва да пише в него. Задава се
> винаги двойка със `SIGMA_D1_ID` на същия слот.

Всяка променлива за име по подразбиране е своята committ-ната стойност, така че когато всички са
незададени, рендерът е **байт-идентичен с committ-натия файл** (само `database_id` се подменя).
Production задава само `SIGMA_D1_NAME` (слотът) и оставя имената на Worker-ите, потоците и кофите по
подразбиране.

> Имплементация на рендера: бърз път записва низа с подменен sentinel без промяна, когато никоя
> променлива за име не е зададена (запазва байт-идентичността и `.jsonc` коментарите). Когато е
> зададена променлива за име, web конфигурацията (`.json`/`.jsonc`) се парсва → мутира →
> стрингифицира, а ETL конфигурацията (`.toml`) се пренаписва по поле — `name`←`SIGMA_ETL_NAME`,
> refresh `[[workflows]] name`←`SIGMA_WORKFLOW_NAME`, registry `[[workflows]]
> name`←`SIGMA_REGISTRY_WORKFLOW_NAME`, `database_name`←`SIGMA_D1_NAME`; `database_id` идва от
> sentinel-а `SIGMA_D1_ID`. Рендерът избира Workflow-а по `binding`, затова двете имена не могат да
> се презапишат едно друго. `class_name`/`binding` никога не се променят.

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

Custom token-ът е **Account**-ниво (не може да се ограничи до един Worker — виж *Бележки → Обхват на
достъпа*). Деплоят днес пипа следното, и token-ът трябва да го покрива:

| право | защо (в кода) |
|---|---|
| Workers Scripts **Edit** | `wrangler deploy` на web и etl, `wrangler secret put` (`LOG_IP_KEY`, секретите на etl), `wrangler triggers deploy` при паркиране, четирите Workflow-а на etl (`[[workflows]]`) и Durable Object-а на контейнера |
| Containers **Edit** | `[[containers]]` на etl (`DeclarationContainer`): деплоят строи образа от `containers/declarations/Dockerfile` и го качва в регистъра на акаунта |
| D1 **Edit** | `scripts/deploy-preflight.mjs` (`wrangler d1 info`), `scripts/release-schema.mjs` (миграции и Time Travel bookmark), `scripts/d1-file.sh` |
| Workers R2 Storage **Edit** | кофите `sigma-csv-cache`, `sigma-reports` (web) и `sigma-declarations` (etl); създаване на кофата и правилата за изтичане (`scripts/ensure-r2-lifecycle.sh`) |
| Vectorize **Edit** | web свързва индекса `sigma-assistant`; деплоят пада, ако индексът липсва или не може да се прочете |
| Account Settings **Read** | wrangler резолвва акаунта |

Workers AI (`ai` binding на web) не иска ресурс; ако dashboard-ът изброява Workers AI или Workflows
като отделни права, дайте им Read/Edit по същата логика. Същият token се поставя и като секрет на etl
worker-а (контейнерът пише в D1 и R2 през wrangler), затова D1 и R2 правата са нужни и по време на
работа, не само при деплой. Списъкът е изведен от командите в
[deploy.yml](../.github/workflows/deploy.yml) и скриптовете му; при отказ от API-то сверете името на
правото в dashboard-а — не разширявайте token-а „за всеки случай“.

## 1. Provisioning на D1 (за всяка среда, локално)

Всяка среда получава **собствени** бази — по два слота (виж таблицата „Среди“). `SIGMA_D1_NAME`
избира името; незададена, `bootstrap.mjs` създава `sigma`, което **не е** слот на production и
проверката преди запис го отказва. Затова името се задава винаги:

```bash
# production — двата слота
SIGMA_D1_NAME=sigma-green node scripts/bootstrap.mjs --apply # → wrangler d1 create sigma-green
SIGMA_D1_NAME=sigma-blue  node scripts/bootstrap.mjs --apply # → wrangler d1 create sigma-blue

# staging
SIGMA_D1_NAME=sigma-stage-blue node scripts/bootstrap.mjs --apply # → wrangler d1 create sigma-stage-blue
```

Запишете отпечатания **D1 `database_id`** на слота, който ще обслужва, и го съхранете като секрет
`SIGMA_D1_ID` на съответната среда (заедно с `SIGMA_D1_NAME` на същия слот) — **не** в committ-натите `wrangler.*` файлове (които пазят zero-UUID dummy за локална
разработка).

> `bootstrap.mjs` действа върху акаунта, към който `wrangler` е автентикиран в момента, и само
> *създава* + отпечатва id-то (не го свързва никъде). Ако базата вече съществува, create-ът се проваля
> меко; прочетете id-то обратно с `wrangler d1 info <name>`.

## 2. Зареждане на данните (за всяка среда, локално)

```bash
# production — празният слот
SIGMA_D1_NAME=sigma-blue node scripts/import.mjs --remote

# staging
SIGMA_D1_NAME=sigma-stage-blue node scripts/import.mjs --remote
```

Пълното изграждане на слот за пускане е `RebuildWorkflow` (виж „Пълно изграждане…“ по-долу и
[runbooks/production-cutover.md](runbooks/production-cutover.md)); `import.mjs` е ръчният път за
първоначално зареждане.

Това мигрира схемата, зарежда EOP staging данните (от отворената емисия `storage.eop.bg` — подменяема
с `EOP_OPEN_DATA_BASE_URL`), извежда анексите, зарежда валутните курсове + NUTS, нормализира до
domain таблиците и преизчислява rollup-ите + FTS.

> **`SIGMA_D1_NAME` избира базата.** `import.mjs` и **всеки** `load-*.mjs` loader насочват към базата
> по име чрез `SIGMA_D1_NAME`; без него те насочват към `sigma` — име, което не е слот на никоя среда.
> Винаги го задавайте.

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

> Деплоите **не презареждат данни**. Схемата следва журнала на миграциите — виж „Схемата“ по-долу.
>
> Деплоят прилага и курирания списък на държавните публични предприятия
> (`scripts/seed-state-owned.sql`, [ADR-0047](adr/0047-public-enterprises-and-private-management.md)) —
> единствените данни, които идват с кода. Иначе обслужваната база пазеше списъка, с който е била
> изградена; следващото обновяване преизчислява собствеността на изпълнителите по новия списък. Файлът
> минава през `scripts/d1-file.sh`, който го опитва до три пъти: `d1 execute --file` ползва импорта на D1
> и понякога съобщава „Not currently importing anything" за внос, който вече е приключил.
>
> Само на staging деплоят пуска и `scripts/repair-annex-total-suspect.sql`. Еднократната корекция на
> валутите, която по-ранни деплои на staging пускаха, веднъж записа удвоената текуща стойност като сума
> на договорите с удвоен анекс (`annex_total_suspect`); файлът я връща към стойността при подписване и
> записва засегнатите договори, изпълнители и възложители в списъците за преизчисляване, така че
> следващото обновяване пресмята наново всичко, което сумира тези договори. Втори път не променя нищо.
> На production не се пуска — там корекцията никога не е минавала; проверката
> `annex-total-suspect-basis` в integrity gate пази правилото навсякъде.

## Схемата

Схемата на всяка обслужвана база е веригата от миграции в
[`packages/db/migrations/`](../packages/db/migrations/), а журналът на wrangler (`d1_migrations`) казва
коя от тях базата вече има. Деплоят не стига схемата по друг път.

- **Приложена миграция не се редактира.** Обслужваната база записва миграцията по име и не я пуска втори
  път, затова редакция стига само до бази, построени след нея — така `0000_init.sql` веднъж се раздели от
  това, което държи production. `packages/db/migrations.lock` пази контролната сума на всеки файл и
  тестът пада при редакция. Промяна в схемата е нова миграция и нов ред в заключването.
- **`node scripts/release-schema.mjs plan <база>`** само чете: сравнява журнала и схемата на базата с
  веригата. Миграция в журнала трябва да има обектите си в базата. Миграция извън журнала се
  **отбелязва** като приложена, ако всичките ѝ обекти вече са там (база, оформена от старите ръчни
  стъпки), **прилага се**, ако нито един не е, и планът **отказва**, ако са само част. Накрая схемата
  трябва да съвпада с тази, която веригата строи от нищо; редът на колоните не е част от сравнението.
  Таблиците, които операциите пазят до схемата (поколенията на качването, разписките на изграждането),
  се изброяват, но не се сравняват.
- **`node scripts/release-schema.mjs apply <база> --remote --yes`** записва точка за възстановяване
  (Time Travel; bookmark-ът е в обобщението на стъпката в GitHub Actions), отбелязванията, проверява,
  че в журнала липсват точно планираните файлове, пуска `wrangler d1 migrations apply` и проверява
  паритета наново. Грешка от `migrations apply` се проверява по журнала: миграцията, която е минала
  въпреки грешката, не се пуска втори път.
- **Отказ спира деплоя преди Worker-ите,** така че базата продължава да обслужва кода, за който е
  изградена. Планът показва коя миграция и кой обект. Връщане след приложена миграция:
  `wrangler d1 time-travel restore <база> --bookmark=<bookmark> --remote`.
- **Първото внедряване на staging** отбелязва 0022–0025 и прилага само `0026` (таблицата
  `data_version`): журналът му има 0000–0021 от по-ранен `migrations apply`, а обектите на 0022–0025 са
  там от старите стъпки. База с `0000` от v1.0.2 в журнала получава всички следващи миграции наред.
- **База, чийто журнал вече съдържа 0000–0024** — построена с `wrangler d1 migrations apply` от
  редактирания `0000` (локални бази, dev) — не приема `0025` с обикновен `migrations apply`: колоните вече
  са там и ALTER пада. `release-schema.mjs apply` веднъж я отбелязва и продължава:

  ```bash
  # локалната база на pnpm dev
  node scripts/release-schema.mjs plan sigma --local --config wrangler.jsonc
  node scripts/release-schema.mjs apply sigma --local --config wrangler.jsonc

  # dev: обвивка с SIGMA_D1_NAME и SIGMA_D1_ID на dev и с никакви други имена на среда
  node scripts/wrangler-render.mjs apps/web/wrangler.jsonc
  node scripts/release-schema.mjs plan "$SIGMA_D1_NAME"
  node scripts/release-schema.mjs apply "$SIGMA_D1_NAME" --remote --yes
  ```

  `--config` се чете спрямо `apps/web`. Локално е задължително: конфигурацията по подразбиране
  (`wrangler.deploy.jsonc`) носи истинското id, а miniflare пази локалната база по id — планът и
  прилагането биха минали върху друг, празен файл. Скриптът няма `--persist-to`: работи върху
  състоянието по подразбиране на wrangler в `apps/web/.wrangler/state`, където пише и `pnpm dev`.
- **Външен ключ към предишното поколение — само в един случай.** Качването публикува с преименуване и
  SQLite пренасочва препратките на всички други таблици. Затова таблица, която качването трие, но не носи
  (днес само `related_persons_internal`), сочи `rp_prev_declarations` след публикуване. Само там планът
  чете `rp_prev_X` като `X` и го печата като `known drift`. Навсякъде другаде име на поколение е
  разминаване: споделена таблица към `rp_next_`/`rp_prev_` или таблица извън качването към което и да е
  от двете.
- **Деплоят не пренаписва редове и не пуска `precompute.sql`.** Миграциите добавят схема. Промяна в
  правилата за изчисление на сумите, флаговете или собствеността не е стъпка върху обслужваната база, а
  пълно изграждане на празния слот и превключване (по-долу).

### Известни остатъци в схемата

Обекти, които базите носят извън веригата или различно от нея. Нито един не пречи на обслужването;
планът ги показва, но не ги сравнява. Не се трият на ръка — чистенето е миграция.

- **`idx_contracts_tender_id`** (Stage и production) дублира `idx_contracts_tender` от `0000_init.sql`
  — същата колона `contracts(tender_id)`. Създава го `scripts/refresh-slice.sql` при всяко обновяване,
  затова е и там, където веригата не го строи. Цена: двоен запис в индекса при всеки ред в `contracts`.
  Чистене: `refresh-slice.sql` спира да го създава, а следваща миграция прави
  `DROP INDEX IF EXISTS idx_contracts_tender_id` — едната от двете стъпки без другата не стига.
- **`risk_scores` и `idx_risk_band`** (само Stage) са махнати от схемата, но остават в по-стария слот;
  таблицата е празна и има външен ключ към `tenders`. Отпада с пълното изграждане на слота или с
  миграция, която я трие.
- **Журналът на Stage** имаше `0000`–`0021`, а обектите на `0022`–`0025` — от старите ръчни стъпки.
  Деплоят през `release-schema.mjs` ги отбелязва (виж по-горе). Слот, по който още не е минал такъв
  деплой, не приема обикновен `wrangler d1 migrations apply`; планът показва кое ще се отбележи.
- **`0018_person_entities.sql`** е допълнен с индекса `idx_person_entities_indent` след като Stage го е
  записал като приложен, затова слот, изграден преди това, няма индекса. Заключването
  (`migrations.lock`) вече не допуска такава редакция; липсващият индекс идва с пълното изграждане на
  слота или с нова миграция `CREATE INDEX IF NOT EXISTS`.
- **`sigma_backfill_0002_current_value_currency`** е празна по замисъл: присъствието ѝ казва, че
  еднократната корекция на валутите е минала върху базата. Остава.

Проверка, само четене: `node scripts/release-schema.mjs plan <слот>` (редът „beside the schema (not
compared)“ изброява допълнителните обекти) или
`wrangler d1 execute <слот> --remote --command "SELECT type, name, tbl_name FROM sqlite_master WHERE name IN ('idx_contracts_tender_id','idx_contracts_tender','risk_scores','idx_risk_band','idx_person_entities_indent')"`.

## Проверка преди запис

Преди схемата и преди Worker-ите деплоят пуска `node scripts/deploy-preflight.mjs <среда>`. Тя само
чете и спира деплоя, преди да е записано каквото и да е:

- **Името и id-то на базата са една настройка.** `SIGMA_D1_NAME` трябва да се резолвва
  (`wrangler d1 info`) точно към `SIGMA_D1_ID` и да е слот на средата: `sigma-green`/`sigma-blue` за
  production, `sigma-stage-blue`/`sigma-stage-green` за staging, `sigma-dev2-green`/`sigma-dev2-blue` за
  Dev2.
- **Production** иска още `SUPPRESSION_SALT` и `SUPPRESSION_KEY_VERSION` и **слот, чиито редове са
  изградени по правилата на този код** (версията на данните, по-долу). Dev2 е с правилата на production,
  за да репетира същия път.
- **Staging** само предупреждава за версията на данните: там малките промени минават сами при всяко
  сливане, а голямата промяна е изграждане и превключване на Stage в същия ден.

## Версията на данните

`packages/db/data-version.json` казва по коя версия на правилата за изчисление кодът смята записаните
стойности (суми, флагове, собственост) и кои файлове ги смятат. Пълното изграждане на слот записва
версията в таблицата `data_version` на слота, когато го е проверило. Слот без запис (например изграден
от v1) няма версия.

- **Вдига се, когато вече записани редове биха се изчислили другояче.** Тогава обновяването на всеки 6
  часа преизчислява само последните дни, а историята остава по старото правило — смесено състояние.
- **Production не пуска на място върху редове на друга версия:** проверката преди запис отказва и казва,
  че е нужно изграждане на празния слот и превключване.
- **CI предупреждава** (не спира), когато pull request промени някой от файловете в `computedBy`, без да
  вдигне версията; рецензентът решава дали промяната иска изграждане.

## Три пътя за пускане

Критерият не е „структурата на базата“, а „променят ли се вече записаните редове“.

| път | кога | какво става | време | връщане |
|---|---|---|---|---|
| **Без промяна в данните** | няма нова миграция, правилата за изчисление са същите | качват се само Worker-ите; планът на схемата е празен | минути | `wrangler rollback` |
| **Малка промяна** | само добавящи миграции (таблица, индекс, колона със стойност по подразбиране); правилата са същите | миграциите върху живия слот: точка за възстановяване → план → прилагане → паритет | минути | Time Travel до точката или `wrangler rollback` |
| **Голяма промяна** | нова версия на данните или схема, която иска преизчисляване | пълно изграждане на празния слот → проверка → превключване | часове | превключване обратно |

- **Връщането** на всеки от трите пътя е описано стъпка по стъпка в
  [runbooks/release-rollback.md](runbooks/release-rollback.md).
- **Лицата са отделен случай:** всеки неделен ход строи цялото поколение наново и го разменя наведнъж,
  затова промяна само в правилата за лицата влиза със следващия ход, без изграждане на слот.
- **Схемата:** никога изтриване или преименуване в същото издание. Първо се добавя новото, после се
  изгражда, и чак в следващо издание се маха старото.
- **На Stage:** малките промени минават сами при всяко сливане; голямата промяна — сливане, после
  изграждане и превключване на Stage в същия ден. Голямата промяна винаги минава първо там.

## 3. Конфигуриране на GitHub Environments

Създайте две среди (repo Settings → Environments):

**`production`**:
- секрети `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SIGMA_D1_ID` (id-то на живия слот),
  `SUPPRESSION_SALT` (собствен за production — отпечатъците на свалените твърдения не се делят със
  staging)
- променливи `SIGMA_D1_NAME` (`sigma-green` или `sigma-blue`, винаги двойка със `SIGMA_D1_ID`) и
  `SUPPRESSION_KEY_VERSION` (`1`). Имената на Worker-ите, потоците и кофите остават committ-натите
  стойности по подразбиране.
- Без тях деплоят спира в проверката преди запис (по-долу): без име на базата декларациите никога не се
  публикуват, а без солта първото свалено твърдение спира всяко изграждане.

**`staging`**:
- секрети `CLOUDFLARE_API_TOKEN` (засега същият акаунтски token е добре), `CLOUDFLARE_ACCOUNT_ID`
  (= obecto), `SIGMA_D1_ID` (id-то на активния staging слот)
- променливи `SIGMA_WEB_NAME` = `sigma-stage`, `SIGMA_ETL_NAME` = `sigma-etl-stage`,
  `SIGMA_WORKFLOW_NAME` = `sigma-refresh-stage`,
  `SIGMA_REGISTRY_WORKFLOW_NAME` = `sigma-registry-stage`, `SIGMA_D1_NAME` = името на активния слот

> С `environment: production` на job-а GitHub излага и repo-ниво секретите, но настройките, които
> проверката преди запис иска (`SIGMA_D1_NAME`, `SUPPRESSION_SALT`, `SUPPRESSION_KEY_VERSION`), са на
> средата: без тях production деплоят спира, преди да е записал нещо.

> **Required reviewers на `production`.** Production деплоят тръгва от push на tag. Дайте на средата
> `production` required reviewers, за да изчаква ръчен клик „Review deployments“ — така tag, пуснат по
> грешка, не стига до production. Настройката е в repo Settings → Environments → `production`; дали е
> включена, се вижда там.

## 4. Деплой

Единственият workflow [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) преобразува git
събитие → среда и деплойва двата Worker-а:

- **Production** — push на version tag (издаване на release; преди това виж
  [runbooks/production-cutover.md](runbooks/production-cutover.md) и
  [runbooks/release-rollback.md](runbooks/release-rollback.md)):
  ```bash
  git tag vX.Y.Z && git push origin vX.Y.Z          # → production
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
ETL-ът по необходимост е отделен worker — той носи cron trigger-ите и класовете `RefreshWorkflow`,
`RegistryWorkflow`, `DeclarationsWorkflow` и `RebuildWorkflow`, както и контейнера на декларациите.

## 5. Верификация

- Отворете адреса на средата (`https://sigma.midt.bg/` или `https://sigma-stage.cf-midt.workers.dev/`)
  — началната страница показва реални суми и дата на последния договор.
- Dashboard → **Workflows** → refresh и registry Workflow-ите на средата са в списъка. Няма публичен
  HTTP trigger; ръчни/backfill стартирания минават през Dashboard или `wrangler workflows trigger
  <name>`. Cron-ът (`0 */6 * * *`) после стартира двата независимо.
- Уверете се, че production е **недокоснат**, когато деплойвате staging (различен worker + D1 + lane).

Когато нещо се обърка след деплоя — паднало обновяване, изостанал регистър, 503 от D1, смяна на
секрет, връщане назад — процедурите са в [runbooks/README.md](runbooks/README.md).

## 6. Публичност, Access и `workers.dev`

СИГМА е публичен портал за прозрачност. **Production (`sigma.midt.bg`) и staging са публични; нито една
среда не е зад Cloudflare Access.** Търсачките индексират само `sigma.midt.bg`: на всеки друг адрес —
staging, dev и `workers.dev` адресът на production — robots.txt е `Disallow: /` и всеки отговор носи
`X-Robots-Tag: noindex` (`apps/web/app/lib/indexing.ts`).

**`workers.dev` на production.** `apps/web/wrangler.jsonc` не задава `workers_dev`, затова деплоят
оставя автоматичния адрес `sigma.<sub>.workers.dev` включен (и preview адресите, ако са включени в
акаунта) — вторият публичен адрес на същия Worker. Той не се индексира, но минава покрай всичко, което
се настройва на ниво зона `midt.bg` (WAF и rate правила, purge на кеша, bot настройки). Текущото
състояние: Workers & Pages → `sigma` → Settings → Domains & Routes. Ако бъде изключен, това е
стойност само за production: `workers_dev: false` (и `preview_urls: false`) трябва да се рендерира
само за production, както имената, иначе ще изключи и `workers.dev` адреса на staging, който няма друг.
ETL worker-ите са без публична повърхност (`workers_dev = false` в `apps/etl/wrangler.toml`).

**Custom домейнът.** `midt.bg` е Cloudflare зона в същия акаунт; `sigma.midt.bg` е закачен към Worker-а
`sigma` като **Custom Domain** (Workers & Pages → `sigma` → Settings → Domains & Routes), не чрез
`routes` в конфигурацията — така staging деплоят не може да го докосне.

**Ако някога трябва да се заключи** (Access е по-силният избор пред парола в Worker-а: работи на ръба,
преди Worker-а и кеша, дава идентичност и audit и покрива статичните assets):

1. Zero Trust dashboard → Access → Applications → **Add → Self-hosted**: домейн `sigma.midt.bg` (или
   адресът на staging), policy **Allow** за списък имейли или група от identity provider; вход с
   One-time PIN или SSO.
2. Затворете заобикалянето: изключете `workers.dev` за същия Worker (виж по-горе) — иначе
   `workers.dev` адресът остава публичен.
3. Тест: адресът пренасочва към Access вход; имейл извън списъка е отказан; `workers.dev` не отговаря.
4. Отваряне без redeploy: изтрийте Access приложението или задайте policy **Bypass / Everyone**.

Ако нещо автоматизирано трябва да достига заключена среда (uptime проверка), добавете **Service Token**
policy или IP bypass. Access приложението и policy-то могат да се управляват и като код (Terraform
`cloudflare_zero_trust_access_application` / `_policy`).

## Гаранции за изолация — защо staging не може да докосне production

Три независими стени; всяка една е достатъчна:

1. **Различни worker имена.** Staging рендер произвежда `sigma-stage` / `sigma-etl-stage`;
   `wrangler deploy` презаписва само worker-а, именуван в неговата конфигурация — не може да пише в
   `sigma`.
2. **Различен D1.** Staging свързва id-то на своя слот (`sigma-stage-blue`/`sigma-stage-green`);
   слотовете на production (`sigma-green`/`sigma-blue`) никога не се именуват в staging рендер, а
   проверката преди запис отказва име, което не е слот на средата. Seed/provision скриптовете
   (`import.mjs` + всеки `load-*.mjs`) насочват към базата по име чрез `SIGMA_D1_NAME`.
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
> единственият текущ източник е EOP MinIO (`storage.eop.bg`).

Staging тръгва половин час след production: деплоят на `staging` задава `SIGMA_ETL_CRON_MINUTE=30` и
[scripts/wrangler-render.mjs](../scripts/wrangler-render.mjs) подменя минутата на всеки cron
(`30 */6 * * *`, `30 3 * * 1`), така че двете среди не удрят източниците (EOP, регистъра, декларациите)
в една и съща минута. Production остава с графика от `wrangler.toml`. `scheduled` разпознава неделния
тик без минутата.

## Декларациите: контейнер в Cloudflare

Заданието за свързаните лица върви в Cloudflare Container, координиран от Durable Object в etl
worker-а ([ADR-0045](adr/0045-declarations-in-a-cloudflare-container.md)); корпусът от декларации
живее в R2. GitHub само деплойва кода. Еднократно за всяка среда:

1. **R2 bucket:** `wrangler r2 bucket create <SIGMA_DECLARATIONS_BUCKET>` (staging:
   `sigma-declarations-stage`; production: `sigma-declarations`). Bucket-ът е празен; първият ход
   изтегля целия корпус (няколко часа, в няколко опита на контейнера, всеки до 60 минути изтегляне).
   Веднага след създаването — двете правила за живот на обектите, защото посредникът нарочно не
   разрешава триене на нищо освен печата на корпуса
   ([ADR-0049](adr/0049-a-run-that-survives-a-stopped-container.md)):

   ```sh
   wrangler r2 bucket lifecycle add <bucket> --name checkpoints --prefix declarations/corpus-v2/checkpoints/ --expire-days 7 -y
   wrangler r2 bucket lifecycle add <bucket> --name fetch-events --prefix declarations/corpus-v2/fetch-events/ --expire-days 30 -y
   ```

   Записите на подновяемия ход (около 60–70 MB на ход) и събитията от обхождането не се четат след
   края на хода; без тези правила биха останали в bucket-а завинаги. Деплоят проверява двете правила
   при всяко пускане и добавя липсващото (стъпка „Expire the declarations run's leftovers in R2");
   ако ключът за деплоя няма права за R2, дава предупреждение, не спира изданието, и правилата се
   добавят на ръка с командите по-горе.
2. **GitHub Environment:** променливите `SIGMA_DECLARATIONS_WORKFLOW_NAME`,
   `SIGMA_REBUILD_WORKFLOW_NAME` и `SIGMA_DECLARATIONS_BUCKET` (таблицата по-горе) и секретът `SUPPRESSION_SALT` (плюс
   `SUPPRESSION_KEY_VERSION` като променлива). Деплоят ги подава на etl worker-а като секрети.
3. **Деплой.** `wrangler deploy` строи образа от `containers/declarations/Dockerfile` (изпълнителят
   има Docker) и създава Durable Object namespace-а с миграцията `v1-declarations`. Инстанцията е
   **`standard-3`** — 2 ядра, 8 GiB памет, 16 GB диск.

   Защо готов тип, а не собствен размер: Cloudflare предлага шест предварително определени типа и
   държи подготвени машини на краен брой места. Дотогавашният размер (2 ядра, 10 GiB, 20 GB) не
   съвпадаше с нито един от тях — беше между `standard-3` и `standard-4` — и отказите „There is no
   container instance that can be provided to this Durable Object" бяха чести. `standard-3` е
   едновременно готов тип и **по-малък** от предишния, тоест се намества по-лесно.

   Защо стига: седмичният ход стига до около 2,3 GB памет и 5,5 GB диск, значи 8 GiB и 16 GB са
   тройно покритие. Пълното изграждане е по-гладно — държи едновременно слотовата база, копието ѝ за
   декларациите и работното копие на етапа с кандидатите — и при 12 GB дискът свърши с „database or
   disk is full"; 16 GB са с една трета повече от това. Ако изграждането пак опре до диска, вдигни
   типа на `standard-4` (4 ядра, 12 GiB, 20 GB) — единственият готов тип с 20 GB — и приеми, че
   седмичният ход ще чака за място по-често.

   Cloudflare иска поне 3 GiB памет на ядро и диск не повече от двойната памет; `standard-3` спазва
   и двете (4 GiB на ядро, 16 ≤ 2×8).
4. **Първи ход на ръка:** `wrangler workflows trigger <SIGMA_DECLARATIONS_WORKFLOW_NAME>` от
   `apps/etl` с `--config wrangler.deploy.toml`. Workflow-ът приключва с реалния резултат на хода;
   `declarations/corpus-v2/accepted.json` в bucket-а е разписката за одитирано и публикувано.
5. **Оттам нататък** седмичният cron (неделя, 03:00 UTC) стартира хода сам. Едновременно
   с него може да тече само един ход: Durable Object-ът връща текущия, ако вече има такъв.

**Докога шестчасовите задачи изчакват хода.** Докато ходът на декларациите тече, обновяването на
поръчките и регистърът не се пускат, за да не се движи входът под него
([ADR-0049](adr/0049-a-run-that-survives-a-stopped-container.md)). Границата е по възрастта на хода —
заседнал ход не бива да спре поръчките завинаги — и се задава в `apps/etl/wrangler.toml` като
`DECLARATIONS_STAND_ASIDE_MAX_HOURS` (8 часа; без стойност или с невалидна пак 8). Седмичният ход върху
пълен bucket трае час-два, така че 8 часа са със запас. Студеният ход върху празен bucket (около ден и
половина на staging, от първото теглене до публикуването) се пуска при издаване в rebuild runner-а,
който няма cron и не спира никого. Ако все пак тече в etl worker-а (нова среда или изпразнен bucket),
вдигнете стойността в `wrangler.toml` за този деплой (напр. `"48"`) и я върнете след хода. Стойността
не е секрет: ръчно зададен секрет със същото име би спрял деплоя. По-старата настройка
`DECLARATIONS_STAND_ASIDE_HOURS` (ръчен секрет, имало го е само на staging) вече не се чете и може да се
изтрие с `wrangler secret delete DECLARATIONS_STAND_ASIDE_HOURS --name <SIGMA_ETL_NAME>`.

Публикуването в D1 е размяна на таблици в една атомарна партида (`rp_next_*` → обслужвани →
`rp_prev_*`), затова не зависи от обема на промяната; предишното поколение стои до следващата
публикация.

### Първо пускане на среда след ADR-0045 (staging, после production)

Редът е един и същ за двете среди; production се пуска едва след като staging е минала целия път.

1. **Преди merge-а:** създайте R2 bucket-а на средата (стъпка 1 по-горе) и задайте в GitHub
   Environment-а двете нови променливи (стъпка 2). `SUPPRESSION_SALT` и `SUPPRESSION_KEY_VERSION` вече
   са там от предишното задание. Нищо друго от старото задание не се пренася: workflow-ът и кешът
   му на корпуса са премахнати с ADR-0045, а корпусът се тегли наново в R2.
2. **Merge и деплой.** Деплоят строи образа на контейнера, създава Durable Object namespace-а, подава
   секретите на etl worker-а и прилага схемата (включително `0022_person_relatives`). Web worker-ът
   работи и преди първия ход: заявките към липсващи или празни таблици на свързаните лица връщат
   празен резултат.
3. **Първи ход на ръка** (стъпка 4). Очаквайте няколко часа: корпусът (~180 000 документа) се
   тегли в R2 на опити по 60 минути, всеки следващ опит продължава от записаното; после извличане,
   регистърна снимка от D1 на средата, решения, одит, публикуване, търсещ индекс. Ходът се следи с
   `wrangler workflows instances describe <име> <instance>`; крайният резултат е `complete` с
   `audit` и `published`. Ако ходът спре на етап, различен от `fetch`, причината е в данните или
   одита и се чете от статуса, не се повтаря сляпо.
4. **Първото публикуване с правила `tr-rules-8`** ([ADR-0042](adr/0042-declarant-identifier-as-identity-evidence.md),
   [ADR-0046](adr/0046-company-is-its-eik-register-confirms.md)) слива лица, мести всички документи
   между тях и решава всички връзки без седалище. Размяната на таблици го прави като всяко друго
   публикуване; сравняващата промоция от по-старите версии не би го понесла. Публикуваните връзки
   се решават наново под новата версия на правилата; гейтът за монотонност сравнява с предишното
   поколение.
5. **Проверка:** `declarations/corpus-v2/accepted.json` в bucket-а; smoke по публичните пътища;
   профил на длъжностно лице с декларации и регистърни роли; страница на компания с група
   „длъжностни лица“; `/conflicts?stake=registry`. Предишното поколение стои като `rp_prev_*` до
   следващата публикация — при нужда връщането назад е размяната в обратна посока.
6. **Оттам нататък** cron-ът поема (стъпка 5). Следващата неделя проверете, че ходът е
   тръгнал сам и е завършил.

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
  ресурсите на средата са D1 слотовете, R2 кофите `sigma-csv-cache` (`CSV_CACHE`, кеш на CSV
  експорта), `sigma-reports` и `sigma-declarations`, Vectorize индексът `sigma-assistant` и
  контейнерът на декларациите — всички с env-рендерирани имена (таблицата по-горе), така че staging и
  production никога не споделят storage. CSV експортите не
  се кешират на ръба и са защитени от Workers Rate Limiting binding-а `CSV_RATE_LIMITER` (10/60s);
  cache miss-овете на началната страница, `/companies`, `/authorities`, `/contracts` (и всеки договор с
  неговия `.json`), `/flows`, `/network`, `/map`, `/trends`, `/analytics`, `/competition` и списъка
  `/conflicts` са защитени от `AGG_RATE_LIMITER` (30/60s). Страниците на отделните лица (`/persons/*`) са
  малки, кеширани четения и нямат лимит.
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
| **staging** | `sigma-stage-blue` · `sigma-stage-green` | `SIGMA_D1_ID` (staging env секрет) | `sigma-stage` / `sigma-etl-stage` / `sigma-refresh-stage` + `sigma-registry-stage` |
| **production** | `sigma-blue` · `sigma-green` | `SIGMA_D1_ID` (production env секрет) | `sigma` / `sigma-etl` / `sigma-refresh` + `sigma-registry` |

Рендерираният deploy config съдържа само целевия слот: `SIGMA_D1_NAME` + `SIGMA_D1_ID` винаги се
сменят като двойка. Командите `wrangler d1 execute <slot> --remote` резолвват слота по име и не
изискват двата слота да са едновременно bindings в committed config. Имената на worker/ETL/workflow
не се променят между reseed-ите.

> **Защо слотове вместо `<name>-next`:** името спира да има значение. Два стабилни етикета + указател
> (`SIGMA_D1_ID`) е стандартната blue-green форма; премахва изцяло проблема с преименуването (D1 не
> може да се преименува) и churn-а от create/delete.

> **Нюанс за байт-идентичността на prod.** Деплой-секцията по-горе пази prod рендера байт-идентичен,
> когато променливите за имена са незададени. `SIGMA_D1_NAME` задава само козметичния `database_name`
> (binding-ът е по id), а guard-ът срещу презаписване на грешния *worker* идва от
> `SIGMA_WEB_NAME`/и т.н., не от името на базата — затова насочването на prod към даден слот означава
> просто `SIGMA_D1_NAME=<slot>` (напр. `sigma-blue`). Двата стабилни prod слота са `sigma-blue` и
> `sigma-green` (виж таблицата по-горе); указателят `SIGMA_D1_ID` мърда между тях при суап. Няма слот
> с име `sigma` — списъкът се държи в синхрон с `PRODUCTION_SLOTS` в `scripts/ship-related-persons.mjs`.

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
2. `wrangler`, автентикиран към целевия акаунт, с правата от „Минимални scope-ове за API token“ (§0).
3. Пътят на локално обслужвания D1 sqlite:
   `apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<най-голям>.sqlite`.

> **Седмичният ход на декларациите пише в живия слот.** Контейнерът публикува таблиците на лицата в
> слота, който средата обслужва (`SIGMA_D1_ID`), с размяна на поколения (`rp_next_*` → обслужвани →
> `rp_prev_*`, виж [etl.md](etl.md), „Обработка на декларациите“): връщането е обратната размяна,
> не превключване на слот. Пълното изграждане на празния слот (по-долу) строи и лицата. Защо
> гейтовете четат живата база: [ADR-0038](adr/0038-reseed-writes-idle-slot-gates-read-live.md).

## Пълно изграждане на неактивния слот в контейнера

[ADR-0048](adr/0048-rebuild-the-idle-slot-in-the-container.md) замества ръчните стъпки 3–6 от процедурата
по-долу с един ход в контейнера за декларациите.

За пускане на ново издание изграждането не минава през ETL-а на средата, а през временен Worker само за
изграждане (`component: rebuild-runner` в Deploy, поток `sigma-rebuild-cutover`), за да не се смени ETL-ът,
който обслужва живия слот, преди превключването. Целият път е в
[runbooks/production-cutover.md](runbooks/production-cutover.md).

1. **Еднократно за средата:** GitHub Environment променлива `SIGMA_REBUILD_WORKFLOW_NAME` (например
   `sigma-rebuild-stage`). Деплоят създава работния поток заедно с etl worker-а.
2. **Пускане.** Работният поток получава името и id-то на **неактивния** слот. Координаторът отказва
   живия.

   ```bash
   wrangler workflows trigger <SIGMA_REBUILD_WORKFLOW_NAME> \
     '{"targetName":"<неактивен слот>","targetId":"<id на неактивния слот>"}'
   ```

3. **Наблюдение.** Използвайте `wrangler workflows instances describe <име> <instance>`. Етапите са
   `import` → `registry` → `precompute` → `declarations` (с етапите на хода за декларациите) → `search` →
   `ship` → `verify`. Ходът трае часове и прекъснат опит започва отначало. Не го пускайте в нощта срещу
   неделя, когато тръгва седмичният ход на декларациите.
4. **Резултат.** Ходът е `complete`, когато броят на редовете във всяка изпратена таблица съвпада със
   снимката и проверката за цялост е минала. Чак тогава слотът получава реда в `data_version` с версията
   на данните на кода и комита, от който е изграден. Живият слот не е пипнат.
5. **Превключване:** стъпки 6–10 от процедурата по-долу (preview на web, redeploy на ETL и web с новия
   `SIGMA_D1_ID` и `SIGMA_D1_NAME`, проверка). Предишният слот остава за връщане назад.

## Процедура: blue/green reseed (идентична за staging и prod)

Изпратете в **празния** слот, докато живият продължава да обслужва — без празен прозорец, нищо лошо не
се кешира.

1. **Създайте слотовете, ако липсват (първо възприемане само за ТАЗИ среда).** Ако `<env>-blue` /
   `<env>-green` още не съществуват, създайте само тях с `wrangler d1 create`. Staging-only деплой
   никога не създава и не проверява production слотовете. След това прескачайте тази стъпка.
2. **Определете празния слот.** `SIGMA_D1_ID` (env секретът) именува живия слот; другият е празен.
   `wrangler d1 list` за id-тата.
3. **Изравнете схемата на празния слот, после го изпразнете children-first.**
   `node scripts/release-schema.mjs apply <слот> --remote --yes` прилага липсващите миграции и проверява
   реалните колони, таблици и индекси спрямо веригата (виж „Схемата“). Едва след успешен паритет пуснете
   wipe-а; нищо още не сочи към този слот.
4. **Заредете пълна, проверена снимка.** Източникът трябва да съдържа и EOP, и registry/identity, и
   related-persons таблиците; domain-only локална база не е достатъчна. Голям D1 export разделяйте на
   retry-safe `INSERT OR IGNORE` части до около 25 000 реда и под 48 MB. Един файл около 700 MB може да
   върне `D1_RESET_DO` и да се отмени целият; отделните части се повтарят безопасно при временен 7009.
5. **Преизчислете derived таблиците на части.** Пускайте логическите секции на `precompute.sql`
   отделно. FTS договорите се зареждат на диапазони, а длъжностните лица — на малки групи; една обща
   заявка върху целия корпус надхвърля D1 CPU лимита.
6. **Верифицирайте празния слот** спрямо източника: точни броячи на всички data таблици,
   `PRAGMA foreign_key_check`, integrity gate, FTS броячи и `home_totals WHERE id=1`. След това качете
   web версия с `wrangler versions upload` и я проверете през preview URL — без да ѝ давате трафик.
7. **Обърнете указателите без downtime.** Уверете се, че няма активен ETL рън. Публикувайте първо ETL
   към новия слот, после web. За ETL използвайте `wrangler deploy`, защото `versions upload/deploy`
   сменя Worker версията, но не създава/обновява Workflow ресурсите и triggers. В същата операция
   обновете само GitHub Environment-а на средата: `SIGMA_D1_ID`, `SIGMA_D1_NAME` и двете Workflow
   имена. Така следващ merge не връща стария слот.
8. **Пуснете и наблюдавайте двата процеса поотделно.** Първо `sigma-refresh-<env>`, после
   `sigma-registry-<env>`. Изискайте `Completed`, успешен integrity gate, нула pending windows и leases,
   `baseline_status='ready'` и празна registry queue.
9. **Верифицирайте живото** (homepage, списъци, договор с лотове, компания, свързани лица, търсене и
   методология). Суапът минава през redeploy на web, който сменя ключовете на кеша на Worker-а (виж
   уговорката) — страниците от предишния слот не се обслужват след него.
10. **Rollback прозорец.** Предишният слот остава непокътнат като мигновен rollback — обърнете
   `SIGMA_D1_ID` обратно и redeploy. Той се **презаписва при следващия reseed**, така че rollback-ът е
   на дълбочина един reseed. Никога не изтривайте слот на горещия път.
11. **Изведете legacy базата (само при възприемане).** След като новият деплой е потвърден здрав,
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

> **Проверено на staging, 15.09.2026.** Cutover-ът `green → blue` мина без неуспешна публична заявка.
> Web smoke маршрутите върнаха 200 преди и след суапа; EOP refresh възстанови прекъснат 8-дневен
> прозорец и мина integrity gate, а отделният registry Workflow обработи новите победители. Green
> остана непокътнат за rollback.

## Резервен вариант: in-place reseed (само за запазване на едно фиксирано име, приема downtime)

Използвайте това *само* когато умишлено искате едно постоянно име на еднократна среда (staging) и
приемате цената — то **не** е по подразбиране. Има **~20-30 мин. влошен прозорец**; страница,
кеширана по време на празния прозорец, остава до ~1ч, ако web не се деплойне наново (виж
уговорката); и се нуждае от maintenance прозорец далеч от 6-часовите
ETL тиктакания (00/06/12/18 UTC). Предпочитайте blue/green слотове. Стъпки (верифицирайте при всяка):

1. **Backup:** `wrangler d1 export <env> --remote --output=/tmp/<env>-backup.sql`.
2. **Schema parity** (ако е добавена колона): `wrangler d1 execute <env> --remote --command "ALTER
   TABLE …; CREATE INDEX …"` (резолвва се по име; guard, ако съществува).
3. **Wipe `<env>`** с wipe.sql по-горе (`wrangler d1 execute <env> --remote --file wipe.sql`).
4. **Ship:** `SIGMA_D1_NAME=<env> node scripts/ship-domain.mjs --work-db=<local.sqlite> --remote --yes
   --replace` (+ precompute). Верифицирайте.
5. **Deploy** web после ETL, после trigger на workflow-а; верифицирайте живото.

## Schema-only / additive промяна (без пълен reseed, без downtime)

Добавяща промяна — нова таблица, индекс или колона със стойност по подразбиране, при която правилата за
изчисление не се променят — е нова миграция в `packages/db/migrations/` с нов ред в
`packages/db/migrations.lock`. Деплоят я прилага през журнала (виж „Схемата“) преди Worker-ите, така че
кодът, който чете новата колона, започва да обслужва, когато тя вече съществува. Стойности за
съществуващите редове миграцията дава само ако са повторими и не зависят от правилата за изчисление;
иначе промяната е пълно изграждане и превключване.

## Уговорка: остаряла страница и изчистване на кеша

Единственият кеш на страниците е Cache API (`caches.default`) в
[apps/web/workers/app.ts](../apps/web/workers/app.ts). Worker-ите се изпълняват **преди** кеша на
Cloudflare, така че пред worker-а няма друг кеш на HTML или `.data` отговорите: всяка заявка минава
през него и той сам решава дали да върне запис. Записът е в центъра на Cloudflare, който го е създал, и
живее до `s-maxage` на отговора (`publicCache(...)` в маршрута). Cache API не прави `stale-while-revalidate`: след срока следва
нова заявка към D1. Статичните файлове (`/assets/*`, `/.well-known/*`) идват от Workers Assets, а не
оттук.

Ключът е адресът на страницата с подредените параметри, които loader-ите четат, плюс `_dt=<DEPLOY_TAG>`
([cache-key.ts](../apps/web/workers/cache-key.ts)). `DEPLOY_TAG` се сменя при всеки build, затова:

- **Деплой на web изчиства всичко** на практика: новата версия не намира нито един стар запис, старите
  изтичат сами. Това е най-сигурният път и работи и на `*.workers.dev`.
- **Връщане към предишна версия** (`wrangler rollback`) връща и нейния таг: записите ѝ отпреди
  деплоя, ако още не са изтекли (до `s-maxage` им), пак се обслужват. Затова rollback-ът е последван от
  изчистване.
- **Purge Everything на зоната** (dashboard → Caching → Purge Everything или
  `POST /zones/{zone_id}/purge_cache` с `purge_everything`) маха и записите на Cache API във всички
  центрове — така пише документацията на Cloudflare („How the cache works" → purging assets stored with
  the Cache API). Зоната е `midt.bg`, значи се изчиства кешът на **всички** хостове в нея, не само на
  СИГМА. Не е проверено на живо.
- **Purge по URL не стига** до тези записи: ключът е зададен от worker-а (`_dt=…`), а Cloudflare не
  чисти по URL записи с ключ, зададен от worker. По таг също не: отговорите не носят `Cache-Tag`.
- **`cache.delete`** в worker-а чисти само един център — не е път за изчистване.
- **На `*.workers.dev`** няма зона и няма purge: остават деплоят на web или изтичането на записите.
  Данните са верни междувременно — проверявайте през некеширан route (напр. `*.csv` експорт).

**Спешно спиране на страница** (takedown, поправка): след записа в D1 страницата изчезва за всички
най-късно след `s-maxage` на страницата (час за страниците с лица и връзки). По-бързо: Purge Everything
на зоната `midt.bg` (с цената по-горе) или деплой на web (workflow „Deploy" за `production`, изисква
одобрение); след който и да е — некеширана проверка (`X-Edge-Cache: MISS` на първата заявка).
