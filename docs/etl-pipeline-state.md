# Sigma ETL Pipeline — анализ на текущото състояние

Контекст за дискусията #139 / #154 / #158. Карта на това какво реално прави деплойнатият pipeline, кои проверки текат къде и къде е дупката.

---

## 1. `assertIntegrity` — какво проверява

**Файл:** `scripts/integrity-checks.mjs`

Reconciliation gate от 8 модулни проверки (6 при #97; +current-amount-parity и amendment-twin-dedup по-късно; редът е този на `runIntegrityChecks`), всяка с инжектиран `runner(sql) => rows[]`. `assertIntegrity(runner, { label, exit })` пуска всички, разпечатва резултата и излиза с код 1 при провал.

| # | Проверка | Клас | Какво валидира |
|---|----------|------|----------------|
| 0 | **Non-empty corpus** | 🟥 блокираща | `COUNT(contracts) > 0` — хваща катастрофален upstream провал или счупен derive, оставил 0 реда. |
| 1 | **Rollup ↔ contracts** | 🟥 блокираща | `SUM(authority_totals.spent_eur)` = сумата по contracts; същото за `company_totals`, `flow_pairs`, `home_totals`; **точно 0 orphan реда** (договори без authority/bidder/tender). Толеранс ±5.0 EUR за float reassociation върху ~200k реда. |
| 2 | **Current-amount parity** | 🟥 блокираща | `current_value_eur` е съгласувано с `amount_eur` там, където и двете са налични - една и съща стойност не може да се сервира с две различни суми. |
| 3 | **No negative values** | 🟥 / 🟨 | `value_flag='ok' AND amount_eur < 0` → **блокира** (бъг в Sigma). Негатив без ok-flag (upstream дефект) → само **WARN**. |
| 4 | **EIK validity** | 🟥 блокираща | `eik_valid=1` ⇒ нормализиран 9/13-цифрен ЕИК; `eik_valid≠1` ⇒ `eik_normalized IS NULL`. Доказва, че normalize гаранцията е удържала. |
| 5 | **Date sanity** | 🟨 предупредителна | Брои `signed_at` извън `[2007-01-01, днес]`. **Винаги връща ok:true** — upstream data quality, което Sigma не може да коригира (реален пример: `signed_at='2029-05-14'`). |
| 6 | **Staging → domain** (`staging-reconciliation`) | 🟥 блокираща | От `pipeline_stats`: `inserted ≤ candidates` (без фантомни договори над source кандидатите). Self-skip ако таблицата липсва. |
| 7 | **Amendment twin dedup** | 🟥 блокираща | Няма EOP/OCDS близнаци на един анекс в `amendments` (#286/#303). |

**Толеранс:** само `EPS_EUR = 5.0` за float reassociation. Структурните изключения (orphan редове) се асъртват **точно = 0**. На пълния корпус 2020–2026 (193,902 договора / €51.7 млрд) наблюдаваният остатък е точно 0.00.

➡️ Разделението блокираща / предупредителна **вече съществува в кода** — въпросът е само към кой канал да вържем всеки клас.

---

## 2. `refresh-slice.sql` — обхват и записи

**Файл:** `scripts/refresh-slice.sql`

Scoped, идемпотентен дневен delta refresh. Заменя само `c:e:` / `c:o:` (OCDS/EOP) договорите от текущия прозорец. Admin-derived `c:` редове не се пипат. EOP печели над OCDS при еднакъв публичен номер.

**Записва директно в live (served) таблици — няма blue-green swap:**
- contracts (DELETE стари `c:e:`/`c:o:` от прозореца → INSERT нови с `amount_eur`)
- `authority_totals`, `company_totals`, `flow_pairs`, `home_totals`, `sector_totals`, `facet_counts`, `cpv_division_stats` (DELETE + REPLACE на засегнатите rollup-и)
- `search_index`, `data_freshness`

**Извиква се от:**
- Worker: `apps/etl/src/index.ts` → `RefreshWorkflow` → `runRefreshSliceStatementGroup()`
- CLI: `scripts/import.mjs` → `runSliceDerive()`

⚠️ Ключово: записът е **in-place върху live таблиците**. Тоест всяка проверка след него вече е „post-publish".

---

## 3. Деплойнатият `sigma-etl` cron

**Файлове:** `apps/etl/wrangler.toml` + `apps/etl/src/index.ts`

- **График:** `0 */6 * * *` (UTC, на всеки 6 часа). Само cron, без публичен HTTP route.
- **Entrypoint:** `scheduled()` → пуска един `RefreshWorkflow` instance.

**Стъпки в `RefreshWorkflow`** (към 02.09.2026; стъпките, отбелязани с ⛨, минават през оградата на
lease-а - подновяват го и спират, ако вече не е техен):
1. `acquire-refresh-lease` - при държан от жива инстанция lease бягът се оттегля (`skipped: 'lease-held'`)
2. ⛨ `drop-stale-transient-staging`
3. `pending-window` - чете обещанията на предишни незавършени бягове (ако има)
4. `plan-catchup` (изчислява прозореца от последната заредена дата; началото се връща до
   най-старото незавършено обещание преди тавана от 21 дни, краят е собственият `today` -
   прекъснат бяг се преиграва в рамките на тавана)
5. ⛨ `record-window` - записва точното покритие на този бяг като обещание (отрязания прозорец,
   не обвивката)
6. ⛨ `create-transient-staging`
7. ⛨ `ingest-storage-eop-bucket` (чете storage.eop.bg → raw_* таблици)
8. `pending-touched` - празен прозорец прескача derive-а само ако няма чакащи докоснати ID-та
   И няма наследен незавършен прозорец (тогава ⛨ `settle-windows-empty` погасява само собственото обещание); наследено обещание се
   удостоверява само от derive + гейт
9. ⛨ `load-fx` (#158)
10. ⛨ за всеки batch: `derive-slice:{batch}` (пуска refresh-slice групите)
11. ⛨ `derive-slice:count`
12. ⛨ `integrity-gate` (#156; post-commit аларма, грешката именува падналите проверки)
13. ⛨ `settle-windows` - чак след минал гейт: изважда покритието от обещанията (покритите
    изчезват, частично покритите се свиват, извън обсега остават и се логват); наследено обещание
    се погасява само ако бягът е видял поне един bucket (иначе `etl_refresh_replay_unverified`)
14. `drop-transient-staging` (в `finally`; само ако lease-ът е още наш)
15. `release-refresh-lease` (в `finally`, винаги; собствен провал се логва, не подменя грешката на бяга)

✅ **Зарежда FX** — `load-fx` стъпка след ingest, преди derive групите (Worker-native, само реални дупки в покритието; виж `docs/adr/0029-worker-native-fx-load.md`). ❌ **Не вика `assertIntegrity`** — reconciliation гейтът пристига с #156 (ред: FX → derive → gate).

---

## 4. `load-fx` — конверсия в EUR

**Файл:** `scripts/load-fx.mjs`

Тегли ECB референтни курсове от `frankfurter.dev`, попълва таблицата `fx_rates`, използвана за конверсия на чужда валута → каноничен EUR по курса към датата на подписване.

- **CLI:** `import.mjs` (`runFullDerive`, `runSliceDerive`) пуска `load-fx.mjs --apply` **преди** `normalize-raw.sql`.
- **Cron пътят** зарежда курсове Worker-native през споделената логика в `packages/ingest/src/fx.ts` — само реалните дупки в покритието, идемпотентно (`INSERT OR REPLACE`).
- BGN не минава оттук — пегът 1.95583 е hardcode-нат в `normalize-raw.sql`.

➡️ Затворено с #263 (#158): cron-ът вече зарежда курсовете преди derive. Остатъчен случай: валута извън ECB/frankfurter остава `NULL`, но видимо — всеки run логва `etl_fx_uncovered`.

---

## 5. Дупката (#97)

**Commit:** `996f4b9` — `feat(etl): pipeline reconciliation gate (#97)`. **Док:** `docs/integrity-gate.md`.

Gate-ът е вързан **само в operator скриптовете** (`import.mjs`, `ship-domain.mjs`), при това **post-publish**: `assertIntegrity` тече *след* като `precompute.sql` вече е записал served D1 (D1 няма евтин blue-green swap). На violation `process.exit(1)` спира run-а, но грешните числа вече се сервират — съзнателен **„ship-and-alert"** компромис (док, редове 126–142).

**Worker cron пътят изобщо липсва от тази картина** — не минава през никаква reconciliation проверка.
  _(Историческо, към #97. От #156 (23.07.2026) cron-ът пуска същия gate в стъпка `integrity-gate` след всеки slice derive - post-commit аларма, виж [`etl.md`](etl.md).)_

Известни ограничения в обхвата на #97:
- **Invariant 1 total-preservation blind spot:** ако договор се припише на *грешна* институция, но грандтоталът се запази, gate-ът минава (per-grain проверка → tracked като #99 golden totals).
- **Silent under-insertion:** `inserted ≤ candidates` хваща само *over*-insertion; ако половината кандидати изпаднат при dedup, проверката пак минава (#99).

---

## 6. Scoped vs full rollup при частично опресняване

`refresh-slice` е scoped — пише само за „touched" entity-та. Но не всички rollup-и са scoped:

| Rollup | Поведение | Глобална консистентност |
|--------|-----------|--------------------------|
| `company_totals`, `authority_totals` | **scoped** към touched множеството (`refresh-slice.sql:1262`) | зависи от touched множеството |
| `home_totals`, `sector_totals`, `facet_counts`, `flow_pairs`, `cpv_division_stats`, `data_freshness` | **full-recompute** всеки run | по конструкция ✅ |

_(Към #97; вече не е така, виж бележката по-долу.)_ Touched множеството се строеше от **новата** атрибуция (`refresh-slice.sql:1198–1239`), след DELETE+INSERT на договорите. Contract id-то вгражда `bidder_key` (`refresh-slice.sql:527`), а DELETE-ът мачва само по `contract_number + tender` (ред 499).

_(Към 02.09.2026: всеки batch записва докоснатите ID-та в себе си - `contracts` и преди DELETE-а (старата атрибуция), и след INSERT-ите (новата, плюс съвъзложителите); `amendments` записва точно редовете на `amend_contract_base`; `refresh_touched_*` преживяват abort. Виж [`etl.md`](etl.md), „Прекъснат derive".)_

➡️ **Out-of-window staleness.** Преатрибутиран договор (нов bidder/authority) → ново id → DELETE на стар ред + INSERT на нов. Touched хваща новия entity; **старият** се преизчислява само ако е иначе в прозореца. Иначе scoped-ият му rollup остава stale (брои изтрит договор). Това е тих overcount, независим от observe-vs-gate — проследен в #160.

**Следствие за gate-а при частично опресняване:**

- Slice-local проверка е **негодна** — старият entity по дефиниция е извън touched множеството. Само **глобалната** реконсилиация (`assertIntegrity` Invariant 1) го лови (двойно броене → `SUM(rollup) > SUM(contracts)`).
  _(Към 02.09.2026 това вече не важи: `contracts` записва старата атрибуция - изпълнител, водещ и съвъзложители - ПРЕДИ DELETE-а, в същия batch, така че и старият субект се преизчислява.)_
- Глобалната сума пак има **#99 blind spot**: симетричната in-window re-attribution запазва грандтотала → минава, докато и двете страници са грешни.
- В staging→promote модел глобалната проверка иска **композитно четене**: touched(staging) ∪ untouched(live) ∪ contracts; атомична промоция само при pass.
- Връщането при провал е **чисто** тук: само slice-ът се е сменил, тоест „остави live недокоснат" = напълно консистентна предишна версия на данните (последните валидни данни).
- **Поправка (02.09.2026):** „чисто" важеше за slice-а, не за rollup-ите. Бяг, умрял между
  `contracts` и rollup-ите, оставяше вкараните договори без запис кои субекти са докоснати
  (записът беше в края на `amendments`, а `setup` DROP-ваше `refresh_touched_*`) - 19 дни такива
  бягове дадоха −139 M€ / −200 M€ дрейф в `authority_totals` / `company_totals`. Сега докоснатите
  множества преживяват abort, записват се в същия batch като промяната, и Worker-ът не прескача
  derive-а при празен прозорец, докато има чакащи ID-та (виж [`etl.md`](etl.md), „Прекъснат derive").

**Операционно (към #97; от #156 cron-ът gate-ва):** cron-ът дотогава никога не беше gate-вал → възможна натрупана staleness. Първо пълен CLI rebuild → зелена базова линия → чак тогава cron gate.

---

## TL;DR

| Компонент | Реконсилиация | FX | Бележка |
|-----------|---------------|-----|---------|
| CLI (`import.mjs`, `ship-domain.mjs`) | ✅ (но post-publish) | ✅ | „ship-and-alert" |
| **Worker cron (`sigma-etl`)** | ✅ от #156 (post-commit, `integrity-gate`) | ✅ от #158 (`load-fx`) | към #97 беше ❌/❌; от 02.09.2026 и lease + трайни докоснати множества |

Изводи и решение → #139 (observe), #154 (gate преди публикуване), #158 (FX стъпка), #160 (scoped rollup staleness), #99 (golden totals).
