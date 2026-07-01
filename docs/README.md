# Документация на СИГМА

Дизайнът, решенията и спецификациите на платформата за прозрачност на обществените поръчки живеят тук. За преглед на продукта и бърз старт вижте [`README.md`](../README.md) в корена; работните конвенции са в [`AGENTS.md`](../AGENTS.md).

- [`architecture.md`](architecture.md) — преглед на системата (поток на данните, двата Worker-а) и карта към решенията.
- [`adr/`](adr/README.md) — Architecture Decision Records: по едно архитектурно решение на файл, с индекс и шаблон.
- [`core-scope.md`](core-scope.md) — доменният модел и **речникът на данните**: таблици, rollup-и, `value_flag`/`date_flag`, семантиката на `amount_eur`.
- [`etl.md`](etl.md) — ETL pipeline-ът и open-data емисията на ЦАИС ЕОП (`storage.eop.bg`): зареждане, опресняване и производни таблици.
- [`etl-pipeline-state.md`](etl-pipeline-state.md) — анализ на текущото състояние на ETL pipeline-а.
- [`v1-implementation-plan.md`](v1-implementation-plan.md) — precompute слоят и пагинацията (защо rollup-и и keyset вместо per-request GROUP BY / OFFSET).
- [`integrity-gate.md`](integrity-gate.md) — reconciliation gate-ът: hard asserts върху тоталите при import/CI.
- [`deploy.md`](deploy.md) — деплой към Cloudflare: двата Worker-а (`sigma`, `sigma-etl`) и споделеният D1 per environment.
- [`accessibility.md`](accessibility.md) — достъпност (WCAG 2.1 AA / EN 301 549): какво покрива платформата и наблюденията за вградената приставка за достъпност.
- [`spec/ai-assistant.md`](spec/ai-assistant.md) — спецификация на разговорния аналитичен слой над СИГМА (BgGPT, текст и глас).
- [`spec/assistant-contracts.md`](spec/assistant-contracts.md) — контрактите BE↔FE за AI асистента (Фаза 1 → Фаза 2).
