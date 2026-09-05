# Документация на СИГМА

Дизайнът, решенията и спецификациите на платформата за прозрачност на обществените поръчки живеят тук. За преглед на продукта и бърз старт вижте [`README.md`](../README.md) в корена; работните конвенции са в [`AGENTS.md`](../AGENTS.md).

- [`architecture.md`](architecture.md) — преглед на системата (поток на данните, двата Worker-а) и карта към решенията.
- [`adr/`](adr/README.md) — Architecture Decision Records: по едно архитектурно решение на файл, с индекс и шаблон.
- [`runbooks/related-persons-suppression.md`](runbooks/related-persons-suppression.md) — оперативен наръчник за сваляне/поправка на връзка от свързани лица (версиониран списък с HMAC-отпечатък, спешна процедура, ротация на salt-а).
- [`core-scope.md`](core-scope.md) — доменният модел и **речникът на данните**: таблици, rollup-и, `value_flag`/`date_flag`, семантиката на `amount_eur`.
- [`etl.md`](etl.md) — ETL pipeline-ът и open-data емисията на ЦАИС ЕОП (`storage.eop.bg`): зареждане, опресняване и производни таблици.
- [`etl-pipeline-state.md`](etl-pipeline-state.md) — анализ на текущото състояние на ETL pipeline-а.
- [`etl-architecture.md`](etl-architecture.md) — целевата ETL архитектура (RFC): предложение за състоянието и реда на изпълнение.
- [`v1-implementation-plan.md`](v1-implementation-plan.md) — precompute слоят и пагинацията (защо rollup-и и keyset вместо per-request GROUP BY / OFFSET).
- [`implementation-plans/286-ocds-amendment-unp.md`](implementation-plans/286-ocds-amendment-unp.md) — защо OCDS анексите не се свързват с договор (OCID вместо УНП) и планът за поправка през bridge-а `tender.id → УНП` + prefer-EOP dedup (#286).
- [`implementation-plans/306-amendment-contract-namespace-link.md`](implementation-plans/306-amendment-contract-namespace-link.md) — защо 1 937 EOP анекса не се свързват с договор (номерът на анекса е в друго именно пространство от деловодния номер) и планът за поправка чрез value-anchor (`value_before → signing_value`, 99.99% точност) (#306).
- [`implementation-plans/305-amendment-value-double-count.md`](implementation-plans/305-amendment-value-double-count.md) — защо стойността на анекс се удвоява (ЦАИС ЕОП слага новия **тотал** в полето за промяна) и планът за откриване/поправка: `annex_total_suspect` флаг + текстова хеуристика за възстановяване на истинския тотал (#305).
- [`implementation-plans/287-conflicts-person-table.md`](implementation-plans/287-conflicts-person-table.md) — преработка на `/conflicts` от карта-на-връзка към `DataTable` с ред-на-лице, преместване на детайлите на страницата на лицето/дружеството и поправка на подвеждащия текст „само собствен дял" (ADR-0032) (#287).
- [`integrity-gate.md`](integrity-gate.md) — reconciliation gate-ът: hard asserts върху тоталите при import/CI.
- [`anomaly-report.md`](anomaly-report.md) — cross-row аномалии при опресняване: какво `value_flag` не хваща на ниво отделен договор.
- [`deploy.md`](deploy.md) — деплой към Cloudflare: двата Worker-а (`sigma`, `sigma-etl`) и споделеният D1 per environment.
- [`dev-environments.md`](dev-environments.md) — дълготрайната **dev** среда и ephemeral preview-та за всеки PR: как се деплойва произволен branch.
- [`dev-environments-setup.md`](dev-environments-setup.md) — точните стъпки за provisioning на dev + preview (wrangler auth, D1/R2, secrets).
- [`api.md`](api.md) — публичните данни и машинно четими endpoint-и (CSV/JSON/sitemap), query грамата на филтрите и лицензът — за разработчици, които строят върху данните.
- [`accessibility.md`](accessibility.md) — достъпност (WCAG 2.1 AA / EN 301 549): какво покрива платформата и наблюденията за вградената приставка за достъпност.
- [`spec/integration-testing.md`](spec/integration-testing.md) — ADR-0002 за интеграционната тест-лента на `apps/web`: `wrangler.getPlatformProxy` + in-memory D1 + `caches` polyfill (issue `#94`); практическото ръководство за пускане живее в [`apps/web/test/README.md`](../apps/web/test/README.md).
- [`spec/ai-assistant.md`](spec/ai-assistant.md) — спецификация на разговорния аналитичен слой над СИГМА (BgGPT, текст и глас).
- [`spec/assistant-contracts.md`](spec/assistant-contracts.md) — контрактите BE↔FE за AI асистента (Фаза 1 → Фаза 2).
- [`spec/related-persons-foundation.md`](spec/related-persons-foundation.md) — спецификация на „свързани лица" (декларирани интереси × обществени поръчки): обхват, модел на данните, съпоставяне, гаранции.
- [`spec/related-persons-lia.md`](spec/related-persons-lia.md) — оценка на законния интерес и баланса за публикуване на дял на свързано лице (ЗДОИ чл. 41и, C-184/20, Wypych/Satamedia); придружава [ADR-0032](adr/0032-family-ownership-published-under-public-interest.md).

## Стандарти за ревю

Повтарящите се бележки от ревютата, събрани като конкретни правила — следвайте ги, за да минава PR-ът на първи опит:

- [`review-accuracy.md`](review-accuracy.md) — точност и коректност (блокер за merge): единна база за стойността, непълни периоди, 404 за несъществуващи обекти.
- [`review-accessibility.md`](review-accessibility.md) — достъпност и UI: `sr-only role="status"` за авто-submit филтри, палитрени токени, графики и SVG.
- [`review-security.md`](review-security.md) — Cloudflare, кеш и сигурност: ключове за кеш (CWE-349), rate limiting, CSP, валидация, D1 индекси, AI асистент.
- [`review-testing.md`](review-testing.md) — тестове и CI: `pnpm typecheck` vs vitest, регресионни тестове, `pnpm audit`, integrity gate.
- [`review-code-and-process.md`](review-code-and-process.md) — структура на кода и PR процес: преизползване, SQL в `@sigma/db`, координация на merge, конвенции.
