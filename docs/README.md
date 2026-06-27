# Документация на СИГМА

Дизайнът, решенията и спецификациите на платформата за прозрачност на обществените поръчки живеят тук. За преглед на продукта и бърз старт вижте [`README.md`](../README.md) в корена; работните конвенции са в [`AGENTS.md`](../AGENTS.md).

- [`architecture.md`](architecture.md) — архитектурните решения: рендериране (React Router v7 SSR на Workers), сигурност и достъп до D1.
- [`etl.md`](etl.md) — ETL pipeline-ът и open-data емисията на ЦАИС ЕОП (`storage.eop.bg`): зареждане, опресняване и производни таблици.
- [`deploy.md`](deploy.md) — деплой към Cloudflare: двата Worker-а (`sigma`, `sigma-etl`) и споделеният D1 per environment.
- [`accessibility.md`](accessibility.md) — достъпност (WCAG 2.1 AA / EN 301 549): какво покрива платформата и наблюденията за вградената приставка за достъпност.
- [`spec/ai-assistant.md`](spec/ai-assistant.md) — спецификация на разговорния аналитичен слой над СИГМА (BgGPT, текст и глас).

## Стандарти за ревю

Повтарящите се бележки от ревютата, събрани като конкретни правила — следвайте ги, за да минава PR-ът на първи опит:

- [`review-accuracy.md`](review-accuracy.md) — точност и коректност (блокер за merge): единна база за стойността, непълни периоди, 404 за несъществуващи обекти.
- [`review-accessibility.md`](review-accessibility.md) — достъпност и UI: `sr-only role="status"` за авто-submit филтри, палитрени токени, графики и SVG.
- [`review-security.md`](review-security.md) — Cloudflare, кеш и сигурност: ключове за кеш (CWE-349), rate limiting, CSP, валидация, D1 индекси, AI асистент.
- [`review-testing.md`](review-testing.md) — тестове и CI: `pnpm typecheck` vs vitest, регресионни тестове, `pnpm audit`, integrity gate.
- [`review-code-and-process.md`](review-code-and-process.md) — структура на кода и PR процес: преизползване, SQL в `@sigma/db`, координация на merge, конвенции.
