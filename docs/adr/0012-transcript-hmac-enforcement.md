# ADR-0012 — Налагане на подписа по живия път: filter-on-ingest (sanitize, не reject), ENVIRONMENT-gating, ключ и ротация

- **Статус:** Прието
- **Дата:** 2026-07-07
- **Обхват:** AI асистент, спец. §9.3. Живият път — `assistant.chat.tsx` (ingest), `agent.ts` (emit), докът (`useAssistantChat.ts`, `condense.ts`), провизиониране (`wrangler`, `docs/deploy.md`). Стъпва на схемата от [ADR-0011](0011-transcript-hmac-signing.md).

## Контекст

Криптографският слой E1/E2 ([ADR-0011](0011-transcript-hmac-signing.md)) е налице и unit-тестван, **но не е
включен по живия път**: `assistant.chat.tsx` подава входящите `messages` на модела **без верификация**, никъде
няма `conversationId`, нищо не подписва изходящите, клиентът не round-trip-ва подпис, ключът не е провизиониран.
Защитата съществува като спящ код. Това ADR фиксира решенията по включването.

## Решение

**1. Sign-on-emit, filter-on-ingest.** Сървърът `attachSignature`-ва всяко `assistant`/`tool` съобщение, което
излъчва; на следващата заявка `filterIncomingTranscript` тече **преди** моделът да види каквото и да е.

**2. Sanitize, не reject.** Подправените/неподписани/replay/out-of-order/cross-conversation съобщения се
**дропват** от полезрението на модела и ходът продължава; причините се логват като metadata-only телеметрия.
Никога не връщаме 500 при подправен вход — **„fail toward the model seeing less, never fabricated more"**.
Съответства на observation-only философията на рамката. `user` съобщенията винаги се пазят (недоверен вход,
никога авторитетен).

**3. Транспорт.** `sig` + слот (`turnIndex`, `position`) + `reports[]` пътуват в **`UIMessage.metadata`**,
записана чрез `message-metadata` stream part при finish на хода (същият механизъм като съществуващите
`data-dedup` части). `conversationId` пътува в тялото на POST-а. `prepareChatBody` **запазва** metadata-та.

**4. Сървърът владее summarization-а.** Под §9.3 POST-ът носи **дословните подписани** съобщения (bounded по
байтове), а сървърът ги E2-trim-ва в **подписан** summary. Клиентският `condense` recap става **display-only**:
той е неподписан `assistant` текст → `filterIncomingTranscript` го дропва по дефиниция. Така авторитетното
свиване е сървърно и не може да се използва за laundering. (Виж [[thread-compression-already-exists]] —
клиентският recap беше и досега evictable; тук той просто губи авторитет.)

**5. Gating по runtime `ENVIRONMENT` binding, не по build константа.** Решението prod-vs-preview се взима от
**runtime** env binding, **не** от `import.meta.env.PROD`. `import.meta.env.PROD` се inline-ва като `true` за
**всеки** production build (Vite), а deploy-ът билдва staging със същия `react-router build` → staging би се
представил за prod. (Точно този анти-патерн е маркиран в ревюто на #64 и вече присъства на ред
`assistant.chat.tsx` за `isProd`; не го разпространяваме за HMAC гейта.) **Стабилните публични среди
(`production` + `staging`, и двете live/неавтентикирани):** ключът е задължителен — липсва ли, асистентът
отказва (fail-closed, като Turnstile). **Ephemeral preview + dev:** fail-open (може да вървят само-UI без
ключа); провизионира се dev ключ само за да се упражнява пътят. Гейтът приема булев `requireKey`
(`ENVIRONMENT ∈ {production, staging}`), а не самото `isProduction` — за да не се третира публичен staging
като dev.

**6. Ключ и ротация — авто-провизиониране от CI.** `ASSISTANT_HMAC_KEY` е **wrangler secret**, но понеже е
чисто **вътрешен** ключ (никога не напуска Cloudflare, няма човешка стойност), не се управлява ръчно: CI го
провизира по същия модел като `LOG_IP_KEY` — `scripts/ensure-worker-secret.mjs` го **генерира само ако
липсва** (256-bit) и го оставя непроменен при redeploy, wire-нат в `deploy.yml` (prod/staging) и `preview.yml`
(previews). Стабилен ключ през redeploy-и е задължителен: транскриптите живеят в клиента, а ротирането при
всеки deploy би обезсилило наведнъж всеки in-flight транскрипт. За **умишлена** ротация verify приема **два**
ключа в прозорец: `ASSISTANT_HMAC_KEY` (+ опционален `ASSISTANT_HMAC_KEY_PREVIOUS`, verify-only); подписваме
само с текущия. Ключът се генерира in-process и се стриймва към `wrangler secret put` през stdin — не се
появява в лог, затова няма нужда от `::add-mask::`. `SIGMA_ENVIRONMENT` (GitHub Environment променлива) храни
`ENVIRONMENT` binding-а, който решава fail-closed vs fail-open (виж §5).

## Последствия

- **Защитата става активна:** подправена/replay/пренаредена/cross-conversation история и laundering на chips
  се отрязват преди модела; телеметрията прави атаките броими.
- **Компромиси:** POST-ът носи дословни подписани съобщения (не клиентски recap) → по-голям upload, ограничен
  от съществуващите капове (`MAX_BODY_BYTES`, `MAX_MESSAGES`, `MAX_MESSAGE_CHARS`); +1 secret на среда;
  прозорец за ротация за документиране.
- **Fail-closed в prod:** забравен/ротиран ключ спира асистента, а не тихо изключва интегритета — огледава
  fail-closed rate limiter-ите и Turnstile.
- **Staging на доставката:** първият PR включва filter-on-ingest + sign-on-emit + `conversationId` +
  клиентски round-trip + ключ/среда. Под §9.3 клиентът праща **дословни подписани** съобщения (recap-ът е
  подтиснат), ограничени от съществуващите капове (`MAX_MESSAGES`/байтове) — гаранцията за интегритет
  (отрязване на подправеното) държи и без E2. **Wiring на E2 `transcript-trim`** (summary-based retention
  върху филтрираните съобщения) е обособен follow-up: библиотеката е готова и тествана, включването ѝ е
  context-management, не security-critical.
- **SDK-assembler симетрия (pin + tripwire):** подписът работи само ако `MessageAssembler` възпроизвежда
  точно chunk→`parts` сглобяването на клиентския SDK. Затова `ai` и `@ai-sdk/react` са **pin-нати точно**
  (без `^`), а `transcript-sdk-symmetry.test.ts` пуска реалния `ai` `readUIMessageStream` и verify-ва подписа
  срещу сглобеното от SDK съобщение — така минорен bump, който чупи симетрията, пада в CI, вместо тихо да
  дропне цялата история в prod (единственият сигнал иначе е `console.warn`). `data-report-ready` е сега
  bound в подписа (беше allowlist-нат през phase filter-а, но не и в тупъла).
- **Провизиониране (в този PR):** `ENVIRONMENT` binding се stamp-ва per-target от `wrangler-render.mjs`
  (от `SIGMA_ENVIRONMENT`), а `ASSISTANT_HMAC_KEY` се генерира-ако-липсва от `scripts/ensure-worker-secret.mjs`
  (адверсарно unit-тестван), wire-нат в `deploy.yml` + `preview.yml`. Така feature-ът е self-contained: и
  ключът, и средата се появяват в един и същ deploy, без ръчни стъпки.
- **Follow-up:** `import.meta.env.PROD` → runtime `ENVIRONMENT` да се уеднакви и за съществуващия `isProd` път
  (breaker/Turnstile) в отделен PR (използва вече stamp-натия `ENVIRONMENT`).
- Индексиране: този ADR и [ADR-0011](0011-transcript-hmac-signing.md) в `docs/adr/README.md`; провизионирането
  в `docs/deploy.md` (docs-integrity гейт).
