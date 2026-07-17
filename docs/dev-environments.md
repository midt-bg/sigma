# Dev среда и ephemeral PR preview-та

Този документ описва как да се деплойва **произволен branch** към дълготрайна **dev** среда и как
работят **ephemeral preview средите за всеки PR**. Допълва [`deploy.md`](deploy.md) (production /
staging) — прочетете първо него за модела на средите и rendering механизма.

Целта: **лесно да виждаме всеки branch на живо**, без да преправяме код и без да зареждаме данни
наново за всяка среда.

## Накратко

| | dev (дълготрайна) | PR preview (ephemeral) |
|---|---|---|
| Кога | ръчно, при поискване (`workflow_dispatch`) | автоматично, за всеки отворен PR |
| Worker-и | `sigma-dev` + `sigma-etl-dev` | само `sigma-pr-<номер>` (web; **без ETL**) |
| URL | `sigma-dev.<subdomain>.workers.dev` | `sigma-pr-<номер>.<subdomain>.workers.dev` |
| D1 | собствена база `sigma-dev` | **споделя** dev базата (read-only от worker-а) |
| Данни | пълен корпус, веднъж; cron-ът поддържа свежи | наследени от dev — без зареждане per-PR |
| Workflow | `.github/workflows/deploy.yml` | `.github/workflows/preview.yml` |
| GitHub Environment | `dev` | `preview` |
| Премахване | дълготрайна (не се трие) | при затваряне на PR-а (`teardown-remote.mjs`) |

Защо preview-тата споделят dev базата: D1 няма евтин clone/snapshot, а пълно зареждане отнема ~20 мин.
Затова за PR преглед е безсмислено да зареждаме данни наново — web worker-ът само **чете**, така че
всички preview-та сочат към **същата** dev D1 (`SIGMA_D1_ID` на `preview` средата = id-то на dev
базата). ETL worker-ът **пише** в D1 и е cron-only — затова **не** пускаме негово per-PR копие.

---

## Част 1 — дълготрайна dev среда

### 1.1 Еднократно провизиониране на Cloudflare ресурси

От машина с `wrangler login` (или scoped token). Имената идват от същите env променливи, които
deploy workflow-ът ползва:

```bash
# D1 (сервираните данни) — отпечатва database_id
SIGMA_D1_NAME=sigma-dev node scripts/bootstrap.mjs --apply

# R2 (CSV-export кеш) — отделен скрипт, за да остане bootstrap.mjs непокътнат в този PR
SIGMA_CSV_CACHE_NAME=sigma-csv-cache-dev node scripts/bootstrap-r2.mjs --apply
```

Това създава **D1 базата** `sigma-dev` и **R2 bucket-а** `sigma-csv-cache-dev`. Запишете отпечатания
от `wrangler d1 create` **`database_id`** — той става `SIGMA_D1_ID` по-долу. (Rate-limit
"namespace"-ите не се провизионират — те са integer id-та, споделени между средите, виж
`apps/web/wrangler.jsonc`.)

### 1.2 GitHub Environment `dev`

В *Settings → Environments → New environment → `dev`*. **Без** required reviewers (иначе всеки
ръчен dev деплой ще чака одобрение).

Secrets:

| Secret | Стойност |
|---|---|
| `CLOUDFLARE_API_TOKEN` | scoped token (Workers Scripts\:Edit, D1\:Edit, R2\:Edit, Account\:Read) |
| `CLOUDFLARE_ACCOUNT_ID` | id-то на акаунта |
| `SIGMA_D1_ID` | `database_id` на `sigma-dev` от стъпка 1.1 |

Variables (не secrets):

| Variable | Стойност |
|---|---|
| `SIGMA_WEB_NAME` | `sigma-dev` |
| `SIGMA_ETL_NAME` | `sigma-etl-dev` |
| `SIGMA_WORKFLOW_NAME` | `sigma-refresh-dev` |
| `SIGMA_D1_NAME` | `sigma-dev` |
| `SIGMA_CSV_CACHE_NAME` | `sigma-csv-cache-dev` |

> Guard-ът в `deploy.yml` отказва non-production деплой, ако някое от тези имена липсва или съвпада с
> production default-а — така че всичките пет трябва да са зададени.

### 1.3 Зареждане на данни (веднъж)

Миграции + пълен корпус към отдалечената dev D1, по work-DB пътя (директен `--remote` import не минава
заради лимита ~30s/заявка на D1 — виж [`deploy.md`](deploy.md)):

```bash
# Първо приложи схемата по име (dev името не е в migrate config-а, затова `d1 execute`, не `migrations apply`):
wrangler d1 execute sigma-dev --remote --file packages/db/migrations/0000_init.sql

# Изгражда локален work SQLite и го изпраща на chunk-ове към sigma-dev, после precompute на таргета.
SIGMA_D1_NAME=sigma-dev \
node scripts/import.mjs --work-db=data/work/backfill.sqlite --remote
```

> `scripts/ship-domain.mjs` пуска `wrangler d1 migrations apply $SIGMA_D1_NAME`, който резолвва само
> имена от `apps/web/wrangler.jsonc` — `sigma-dev` не е там, затова тази стъпка дава грешка. Схемата
> вече е приложена с `d1 execute` по-горе, така че за този еднократен seed добави **временен,
> некомитнат** `d1_databases` запис за `sigma-dev` в `apps/web/wrangler.jsonc` за времето на зареждането,
> после го върни.

След това деплойнатият `sigma-etl-dev` cron (на всеки 6h) поддържа базата свежа. За схемна промяна или
reset — reseed по blue/green модела от [`deploy.md`](deploy.md).

### 1.4 Деплой на произволен branch към dev

От Actions таба (*Deploy → Run workflow → Branch: <твоят branch>, environment: dev*) или:

```bash
gh workflow run deploy.yml --ref <branch> -f environment=dev
```

`detect` job-ът насочва `workflow_dispatch` към избраната среда; rendering-ът подменя имената и
`SIGMA_D1_ID` от `dev` средата. Деплоят **не** мигрира и **не** зарежда данни — само качва кода.

---

## Част 2 — ephemeral PR preview-та

`.github/workflows/preview.yml` се задейства на `pull_request` (`opened`, `synchronize`, `reopened`,
`closed`).

- **При отваряне/push** → деплойва `sigma-pr-<номер>` (само web), сочещ към споделената dev D1, и
  публикува/обновява коментар в PR-а с URL-а.
- **При затваряне** → трие worker-а със `scripts/teardown-remote.mjs` (споделените dev D1/R2 **не** се
  пипат — скриптът отказва защитените дълготрайни имена).
- **Авто-почистване (reaper)** → `.github/workflows/preview-reap.yml` се пуска по график и трие всеки
  `sigma-pr-<номер>`, който е стоял **5 дни** без нов деплой (конфигурира се с `PREVIEW_MAX_AGE_DAYS`).
  Хваща два случая, които teardown-ът при затваряне изпуска: idle, но още отворени PR preview-та, и
  orphan-и, чийто teardown при затваряне е пропаднал. Нов push към PR-а ре-деплойва preview-то. Reaper-ът
  ползва същия allowlist като `teardown-remote.mjs` — споделените dev D1/R2 и дълготрайните worker-и са защитени.

Поведение:

- **Само същият репозиторий.** PR-и от fork нямат достъп до secrets, затова preview job-овете се
  пропускат за fork-ове (fork PR-ите пак минават обикновеното CI от `ci.yml`).
- **Concurrency** per PR с `cancel-in-progress` — бърза поредица от push-ове не трупа деплои.
- **Без ETL, без данни per-PR** — preview-то показва същите данни като dev.

### 2.1 GitHub Environment `preview`

В *Settings → Environments → `preview`*. **Без** required reviewers.

Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, и `SIGMA_D1_ID` **= id-то на dev базата**
(`sigma-dev`) — така preview-тата споделят dev данните.

Опционално: `ASSISTANT_API_KEY` — ключът на доставчика на AI асистента (BgGPT/mamay). Тъй като secret-ите
са **per-worker-script**, ефемерният `sigma-pr-<номер>` НЕ наследява ключа от dev worker-а; затова
`preview.yml` го `wrangler secret put`-ва на preview worker-а след deploy. Ако не е зададен тук, deploy-ът
минава, но `/assistant/chat` връща контролирано **503** (preview само с UI). Моделът се достига през
Cloudflare AI Gateway (var-овете `AI_GATEWAY_BASE_URL`/`AI_GATEWAY_ID` в `wrangler.jsonc`). Vectorize
индексът + R2 кофата на асистента са глобални за акаунта и се споделят с dev (без per-preview seed).

Variables: `SIGMA_D1_NAME` = `sigma-dev`, `SIGMA_CSV_CACHE_NAME` = `sigma-csv-cache-dev`.

(`SIGMA_WEB_NAME` не се задава тук — workflow-ът го изчислява като `sigma-pr-<номер>`.)

### 2.2 Когато PR-ът пипа миграции/схема

Preview-то споделя dev базата, затова PR с **нова миграция** не бива да я прилага върху споделената
dev D1 от preview потока. За такива PR-и: или прегледай схемната промяна първо в локален dev
(`pnpm setup` + миграции), или провизионирай отделна еднократна D1 и насочи ръчен dev деплой към нея.
Автоматизиран per-PR изолиран D1 (с lightweight seed) е възможно разширение — не е включено тук, за да
останат preview-тата без разходи.

---

## Ограничения и разходи

- **D1 няма clone/fork/snapshot.** Споделянето на dev базата е умишлено — алтернативата (пълен корпус
  per branch, ~20 мин) е скъпа и бавна.
- **Rate-limit namespace-ите** (`1001`/`1002` в `apps/web/wrangler.jsonc`) са account-scoped и се
  споделят от всички среди — приемливо за dev/preview; при нужда от изолация се параметризират.
- **Cloudflare Access** се конфигурира извън кода (Zero Trust dashboard) и не се прилага за
  `*.workers.dev` preview URL-и — те са незащитени; не пускайте чувствително съдържание там.
- **Изисква Workers Paid plan** (Workflows + размера на D1).
- **Почистване**: при затваряне на PR worker-ът се трие автоматично, а reaper-ът трие idle preview-та
  след 5 дни без деплой (`PREVIEW_MAX_AGE_DAYS`); dev средата е дълготрайна.
