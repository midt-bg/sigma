# Документация на СИГМА

Дизайнът, решенията и спецификациите на платформата за прозрачност на обществените поръчки живеят тук. За преглед на продукта и бърз старт вижте [`README.md`](../README.md) в корена; работните конвенции са в [`AGENTS.md`](../AGENTS.md).

- [`architecture.md`](architecture.md) — преглед на системата (поток на данните, двата Worker-а) и карта към решенията.
- [`adr/`](adr/README.md) — Architecture Decision Records: по едно архитектурно решение на файл, с индекс и шаблон.
- [`core-scope.md`](core-scope.md) — доменният модел и **речникът на данните**: таблици, rollup-и, `value_flag`/`date_flag`, семантиката на `amount_eur`.
- [`etl.md`](etl.md) — ETL pipeline-ът и open-data емисията на ЦАИС ЕОП (`storage.eop.bg`): зареждане, опресняване и производни таблици.
- [`etl-pipeline-state.md`](etl-pipeline-state.md) — анализ на текущото състояние на ETL pipeline-а.
- [`etl-architecture.md`](etl-architecture.md) — целевата ETL архитектура (RFC): предложение за състоянието и реда на изпълнение.
- [`v1-implementation-plan.md`](v1-implementation-plan.md) — precompute слоят и пагинацията (защо rollup-и и keyset вместо per-request GROUP BY / OFFSET).
- [`integrity-gate.md`](integrity-gate.md) — reconciliation gate-ът: hard asserts върху тоталите при import/CI.
- [`anomaly-report.md`](anomaly-report.md) — cross-row аномалии при опресняване: какво `value_flag` не хваща на ниво отделен договор.
- [`deploy.md`](deploy.md) — деплой към Cloudflare: двата Worker-а (`sigma`, `sigma-etl`) и споделеният D1 per environment.
- [`deploy-assistant.md`](deploy-assistant.md) — пускане на AI асистента: Vectorize/R2/KV/AI Gateway ресурсите, тайните и променливите, seed-ът и `ASSISTANT_ENABLED` над базовия деплой.
- [`dev-environments.md`](dev-environments.md) — дълготрайната **dev** среда и ephemeral preview-та за всеки PR: как се деплойва произволен branch.
- [`dev-environments-setup.md`](dev-environments-setup.md) — точните стъпки за provisioning на dev + preview (wrangler auth, D1/R2, secrets).
- [`api.md`](api.md) — публичните данни и машинно четими endpoint-и (CSV/JSON/sitemap), query грамата на филтрите и лицензът — за разработчици, които строят върху данните.
- [`accessibility.md`](accessibility.md) — достъпност (WCAG 2.1 AA / EN 301 549): какво покрива платформата и наблюденията за вградената приставка за достъпност.
- [`spec/ai-assistant.md`](spec/ai-assistant.md) — спецификация на разговорния аналитичен слой над СИГМА (BgGPT, текст и глас).
- [`spec/assistant-contracts.md`](spec/assistant-contracts.md) — контрактите BE↔FE за AI асистента (Фаза 1 → Фаза 2).
- [`spec/ai-assistant-dedup.md`](spec/ai-assistant-dedup.md) — дедупликацията на справките (Lane F): freshness token, слоеве L0–L2.5, само за приключени периоди.
- [`spec/ai-assistant-agent-team.md`](spec/ai-assistant-agent-team.md) — многоагентният модел на асистента: роли ①–④ и оркестрацията им.
- [`spec/assistant-starter-prompts.md`](spec/assistant-starter-prompts.md) — примерните начални въпроси, показвани в дока на асистента.
- [`implementation-plans/assistant-stream-phases.md`](implementation-plans/assistant-stream-phases.md) — план: фазите на стрийминг на отговора на асистента.
- [`implementation-plans/assistant-large-data-summary.md`](implementation-plans/assistant-large-data-summary.md) — план: обобщаване на голям резултатен набор преди отговор.
- [`implementation-plans/assistant-voice-transcribe.md`](implementation-plans/assistant-voice-transcribe.md) — план: гласов вход (`/assistant/transcribe`) — запис, транскрипция, тишина/халюцинации и достъпност.
- [`ai-assistant-chat-testing-2026-07-02.md`](ai-assistant-chat-testing-2026-07-02.md) — запис от Playwright обхода на чат-дока (2026-07-02): prose-таблици vs `emit_report`.

## Стандарти за ревю

Повтарящите се бележки от ревютата, събрани като конкретни правила — следвайте ги, за да минава PR-ът на първи опит:

- [`review-accuracy.md`](review-accuracy.md) — точност и коректност (блокер за merge): единна база за стойността, непълни периоди, 404 за несъществуващи обекти.
- [`review-accessibility.md`](review-accessibility.md) — достъпност и UI: `sr-only role="status"` за авто-submit филтри, палитрени токени, графики и SVG.
- [`review-security.md`](review-security.md) — Cloudflare, кеш и сигурност: ключове за кеш (CWE-349), rate limiting, CSP, валидация, D1 индекси, AI асистент.
- [`review-testing.md`](review-testing.md) — тестове и CI: `pnpm typecheck` vs vitest, регресионни тестове, `pnpm audit`, integrity gate.
- [`review-code-and-process.md`](review-code-and-process.md) — структура на кода и PR процес: преизползване, SQL в `@sigma/db`, координация на merge, конвенции.
