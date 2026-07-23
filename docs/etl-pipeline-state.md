# Sigma ETL Pipeline — анализ на текущото състояние

Контекст за дискусията #139 / #154 / #158. Карта на това какво реално прави деплойнатият pipeline, кои проверки текат къде и къде е дупката.

---

## 1. `assertIntegrity` — какво проверява

**Файл:** `scripts/integrity-checks.mjs`

Reconciliation gate от 6 модулни проверки, всяка с инжектиран `runner(sql) => rows[]`. `assertIntegrity(runner, { label, exit })` пуска всички, разпечатва резултата и излиза с код 1 при провал.

| # | Проверка | Клас | Какво валидира |
|---|----------|------|----------------|
| 0 | **Non-empty corpus** | 🟥 блокираща | `COUNT(contracts) > 0` — хваща катастрофален upstream провал или счупен derive, оставил 0 реда. |
| 1 | **Rollup ↔ contracts** | 🟥 блокираща | `SUM(authority_totals.spent_eur)` = сумата по contracts; същото за `company_totals`, `flow_pairs`, `home_totals`; **точно 0 orphan реда** (договори без authority/bidder/tender). Толеранс ±5.0 EUR за float reassociation върху ~200k реда. |
| 2 | **No negative values** | 🟥 / 🟨 | `value_flag='ok' AND amount_eur < 0` → **блокира** (бъг в Sigma). Негатив без ok-flag (upstream дефект) → само **WARN**. |
| 3 | **EIK validity** | 🟥 блокираща | `eik_valid=1` ⇒ нормализиран 9/13-цифрен ЕИК; `eik_valid≠1` ⇒ `eik_normalized IS NULL`. Доказва, че normalize гаранцията е удържала. |
| 4 | **Date sanity** | 🟨 предупредителна | Брои `signed_at` извън `[2007-01-01, днес]`. **Винаги връща ok:true** — upstream data quality, което Sigma не може да коригира (реален пример: `signed_at='2029-05-14'`). |
| 5 | **Staging → domain** | 🟥 блокираща | От `pipeline_stats`: `inserted ≤ candidates` (без фантомни договори над source кандидатите). Self-skip ако таблицата липсва. |

**Толеранс:** само `EPS_EUR = 5.0` за float reassociation. Структурните изключения (orphan редове) се асъртват **точно = 0**. На пълния корпус 2020–2026 (193,902 договора / €51.7 млрд) наблюдаваният остатък е точно 0.00.

➡️ Разделението блокираща / предупредителна **вече съществува в кода** — въпросът е само към кой канал да вържем всеки клас.

---

## 2. `refresh-slice.sql` — обхват и записи

**Файл:** `scripts/refresh-slice.sql`

Scoped, идемпотентен дневен delta refresh. Заменя само `c:e:` / `c:o:` (OCDS/EOP) договорите от текущия прозорец. Admin-derived `c:` редове не се пипат. EOP печели над OCDS при еднакъв публичен номер.

**Записва директно в live (served) таблици — няма blue-green swap:**
- contracts (DELETE стари `c:e:`/`c:o:` от прозореца → INSERT нови с `amount_eur`)
- `authority_totals`, `company_totals`, `flow_pairs`, `home_totals`, `sector_totals`, `facet_counts` (DELETE + REPLACE на засегнатите rollup-и)
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

**Стъпки в `RefreshWorkflow`:**
1. `drop-stale-transient-staging`
2. `plan-catchup` (изчислява прозореца от последната заредена дата)
3. `create-transient-staging`
4. `ingest-storage-eop-bucket` (чете storage.eop.bg → raw_* таблици)
5. за всеки batch: `derive-slice:{batch}` (пуска refresh-slice групите)
6. `derive-slice:count`
7. `drop-transient-staging` (в `finally`)

❌ **Не вика `assertIntegrity`.** ❌ **Не вика `load-fx`.**

➡️ Точно автономният път — този без надзор — няма нито reconciliation проверка, нито FX зареждане.

---

## 4. `load-fx` — конверсия в EUR

**Файл:** `scripts/load-fx.mjs`

Тегли ECB референтни курсове от `frankfurter.dev`, попълва таблицата `fx_rates`, използвана за конверсия на чужда валута → каноничен EUR по курса към датата на подписване.

- **Извиква се само от CLI:** `import.mjs` (`runFullDerive`, `runSliceDerive`) пуска `load-fx.mjs --apply` **преди** `normalize-raw.sql`.
- **Cron пътят не я вика** — приема, че курсовете вече са заредени.
- BGN не минава оттук — пегът 1.95583 е hardcode-нат в `normalize-raw.sql`.

➡️ Договор в чужда валута, подписан след последния CLI backfill → `amount_eur = NULL` → изпада от всички суми, без флаг. (Изведено в #158.)

---

## 5. Дупката (#97)

**Commit:** `996f4b9` — `feat(etl): pipeline reconciliation gate (#97)`. **Док:** `docs/integrity-gate.md`.

Gate-ът е вързан **само в operator скриптовете** (`import.mjs`, `ship-domain.mjs`), при това **post-publish**: `assertIntegrity` тече *след* като `precompute.sql` вече е записал served D1 (D1 няма евтин blue-green swap). На violation `process.exit(1)` спира run-а, но грешните числа вече се сервират — съзнателен **„ship-and-alert"** компромис (док, редове 126–142).

**Worker cron пътят изобщо липсва от тази картина** — не минава през никаква reconciliation проверка.

Известни ограничения в обхвата на #97:
- **Invariant 1 total-preservation blind spot:** ако договор се припише на *грешна* институция, но грандтоталът се запази, gate-ът минава (per-grain проверка → tracked като #99 golden totals).
- **Silent under-insertion:** `inserted ≤ candidates` хваща само *over*-insertion; ако половината кандидати изпаднат при dedup, проверката пак минава (#99).

---

## 6. Scoped vs full rollup при частично опресняване

`refresh-slice` е scoped — пише само за „touched" entity-та. Но не всички rollup-и са scoped:

| Rollup | Поведение | Глобална консистентност |
|--------|-----------|--------------------------|
| `company_totals`, `authority_totals` | **scoped** към touched множеството (`refresh-slice.sql:1262`) | зависи от touched множеството |
| `home_totals`, `sector_totals`, `facet_counts`, `flow_pairs`, `data_freshness` | **full-recompute** всеки run | по конструкция ✅ |

Touched множеството се строи от **новата** атрибуция (`refresh-slice.sql:1198–1239`), след DELETE+INSERT на договорите. Contract id-то вгражда `bidder_key` (`refresh-slice.sql:527`), а DELETE-ът мачва само по `contract_number + tender` (ред 499).

➡️ **Out-of-window staleness.** Преатрибутиран договор (нов bidder/authority) → ново id → DELETE на стар ред + INSERT на нов. Touched хваща новия entity; **старият** се преизчислява само ако е иначе в прозореца. Иначе scoped-ият му rollup остава stale (брои изтрит договор). Това е тих overcount, независим от observe-vs-gate — проследен в #160.

**Следствие за gate-а при частично опресняване:**

- Slice-local проверка е **негодна** — старият entity по дефиниция е извън touched множеството. Само **глобалната** реконсилиация (`assertIntegrity` Invariant 1) го лови (двойно броене → `SUM(rollup) > SUM(contracts)`).
- Глобалната сума пак има **#99 blind spot**: симетричната in-window re-attribution запазва грандтотала → минава, докато и двете страници са грешни.
- В staging→promote модел глобалната проверка иска **композитно четене**: touched(staging) ∪ untouched(live) ∪ contracts; атомична промоция само при pass.
- Връщането при провал е **чисто** тук: само slice-ът се е сменил, тоест „остави live недокоснат" = напълно консистентна предишна версия на данните (последните валидни данни).

**Операционно:** cron-ът никога не е gate-вал → възможна натрупана staleness. Първо пълен CLI rebuild → зелена базова линия → чак тогава cron gate.

---

## TL;DR

| Компонент | Реконсилиация | FX | Бележка |
|-----------|---------------|-----|---------|
| CLI (`import.mjs`, `ship-domain.mjs`) | ✅ (но post-publish) | ✅ | „ship-and-alert" |
| **Worker cron (`sigma-etl`)** | ❌ | ❌ | автономният път, без предпазна мрежа |

Изводи и решение → #139 (observe), #154 (gate преди публикуване), #158 (FX стъпка), #160 (scoped rollup staleness), #99 (golden totals).
