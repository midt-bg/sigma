# Документация на СИГМА

Дизайнът, решенията и спецификациите на платформата за прозрачност на обществените поръчки живеят тук. За преглед на продукта и бърз старт вижте [`README.md`](../README.md) в корена; работните конвенции са в [`AGENTS.md`](../AGENTS.md).

- [`architecture.md`](architecture.md) — архитектурните решения: рендериране (React Router v7 SSR на Workers), сигурност и достъп до D1.
- [`etl.md`](etl.md) — ETL pipeline-ът и open-data емисията на ЦАИС ЕОП (`storage.eop.bg`): зареждане, опресняване и производни таблици.
- [`deploy.md`](deploy.md) — деплой към Cloudflare: двата Worker-а (`sigma`, `sigma-etl`) и споделеният D1 per environment.
- [`accessibility.md`](accessibility.md) — достъпност (WCAG 2.1 AA / EN 301 549): какво покрива платформата и наблюденията за вградената приставка за достъпност.
- [`spec/integration-testing.md`](spec/integration-testing.md) — ADR-0002 за интеграционната тест-лента на `apps/web`: `wrangler.getPlatformProxy` + in-memory D1 + `caches` polyfill (issue `#94`); практическото ръководство за пускане живее в [`apps/web/test/README.md`](../apps/web/test/README.md).
- [`spec/ai-assistant.md`](spec/ai-assistant.md) — спецификация на разговорния аналитичен слой над СИГМА (BgGPT, текст и глас).
