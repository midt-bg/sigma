# ADR-0009 — Глобалният BgGPT лимит се налага от Durable Object, не от AI Gateway

- **Статус:** Прието (заменя твърдение в `spec/ai-assistant-agent-team.md`)
- **Дата:** 2026-07-06
- **Обхват:** AI асистент, launch gate — `apps/web/workers/assistant/bggpt-circuit-breaker.ts`,
  `apps/web/workers/bggpt-global-rate-limit.ts`

## Контекст

Два документа описват глобалния (account-wide) circuit-breaker пред платеното BgGPT извикване
по **противоположни** начини:

- **Базовата §7** (`spec/ai-assistant.md`): „глобален circuit-breaker — rolling-minute брояч
  (**Durable Object** или KV) на BgGPT извикванията… когато наближи `BGGPT_RATE_LIMIT_RPM`".
- **Addendum-ът за агентния екип** (`spec/ai-assistant-agent-team.md`): че лимитът „**се мести в
  глобалния rate limit на AI Gateway**", че „DO повече не държи брояча" и че това „**заменя**" реда за
  отделен circuit-breaker DO — „едно определение, не две".

Реализацията (#135) достави **брояча като Durable Object**: `BgGptCircuitBreaker`
(`idFromName('global')`, in-memory `RpmWindow`, лимит от `BGGPT_RATE_LIMIT_RPM`, по подразбиране 120).
Извиква се на платения път в `assistant.chat.tsx` през `rateLimitBgGptGlobal(...)` и е **fail-closed** в
prod (липсваща/грешаща DO обвивка → 503, а не неограничен разход).

PR #39 (превключване към BgGPT през AI Gateway) използва Gateway **само за маршрутизиране** на модела
(custom provider) — не мести лимита в Gateway и не премахва DO-то. Тоест твърдението на addendum-а
описва реалност, която никога не е доставена.

## Решение

Глобалният account-wide лимит се налага от **`BgGptCircuitBreaker` Durable Object (#135)**, не от AI
Gateway. AI Gateway дава **маршрутизиране, observability и защитен път за mid-stream 429**
(`isGatewayRateLimit` в `stream-errors.ts`), но **не** е мястото на наложения лимит.

Базовата §7 е коректна и остава. Редовете в agent-team addendum-а, които твърдят „лимитът е в AI
Gateway / заменя DO брояча", се коригират да сочат насам. Многоагентният „екип" и Orchestrator DO от
addendum-а остават **перспективни**: Фаза 1 доставя единичния agent loop + детерминистичния SQL guard
+ ④ Verifier, без Orchestrator DO.

## Последствия

- **+** Документите съвпадат с доставения код; едно място на истината за account-wide лимита.
- **+** Fail-closed поведението (Denial-of-Wallet backstop зад per-IP лимитера) е ясно записано.
- **−** Ако по-късно наистина искаме лимита в AI Gateway, това е **код-промяна** (махане на DO +
  конфигурация на Gateway rate limit) с нов ADR — не документна поправка. Отбелязано като follow-up
  на #39.
