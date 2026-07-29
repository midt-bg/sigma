# ADR-0013 — Voice lane през AI Gateway (provider endpoints, без dynamic routes)

- **Статус:** Прието
- **Дата:** 2026-07-08
- **Обхват:** assistant voice lane (`/assistant/transcribe`), AI Gateway `sigma-assistant`

## Контекст

PR #66 извикваше BgGPT Whisper **директно, без AI Gateway**, защото gateway-ът логва payload-и, а аудиото
не бива да се персистира. Минаваме все пак през gateway-а заради единна cost/latency/rate observability —
но при **твърдо условие**: аудиото остава transient. Моделите са само транскрибери: `audio → text`, а
текстът отива към главния chat модел; **нищо (D1/R2/KV/disk/gateway logs/cache) не персистира аудио**.

Емпирично установено (2026-07-08), защо **dynamic routing не става за глас**:

- Един route с primary+fallback не работи — gateway-ът препраща тялото непроменено, а провайдърите искат
  несъвместими формати (BgGPT = multipart; Workers AI whisper = JSON `{audio: base64}`, multipart → 400;
  Deepgram = raw bytes), и няма CF-native STT с multipart.
- По-фундаментално: **dynamic route изобщо не приема аудио.** Единственият вход е
  `compat/chat/completions` (`model: "dynamic/<route>"`), а `compat/audio/transcriptions` е изрично
  неподдържан (Cloudflare `2019`). Chat body към whisper route дава `5006` „required '/audio'". Значи
  route-ът се резолвва, но само за chat — никога с аудио.

Работи обаче директното извикване на **provider endpoints** през gateway-а — проверено: Workers AI whisper
на `.../sigma-assistant/workers-ai/@cf/openai/whisper-large-v3-turbo` с JSON base64 → **HTTP 200 +
транскрипция**.

## Решение

- **Без dynamic routes.** Voice lane-ът вика **provider endpoints директно през gateway-а**, всеки в своя
  native формат (code-level, lane на Niki):
  - primary — `POST .../sigma-assistant/custom-bggpt-voice/audio/transcriptions` (multipart, BgGPT ключ);
  - fallback — `POST .../sigma-assistant/workers-ai/@cf/openai/whisper-large-v3-turbo` (JSON base64, CF токен).
  App-ът решава fallback-а в кода (както #66 вече прави), но и двата крака минават през gateway-а.
- **Provider-only provisioning.** Единственият voice-specific обект е custom provider-ът `bggpt-voice`;
  `workers-ai` е built-in (не иска provisioning). `scripts/ensure-voice-provider.mjs` (--apply в CI)
  идемпотентно налага само gateway-а + `bggpt-voice`. Няма route JSON, няма route-конвергенция.
- **Аудиото не се персистира.** Всяка STT заявка носи `cf-aig-collect-log: false` (спира body-логването);
  `cache_ttl=0`. **Load-bearing** — ако log-suppression не пази аудиото, връщаме се на директни извиквания
  без gateway.

## Последствия

- И двата STT крака минават през gateway-а → observability на primary **и** fallback (директният
  `env.AI.run` bypass не даваше това), при запазена transient-аудио гаранция.
- Sovereignty: fallback е CF-native (Workers AI) — без audio egress към US (Groq/OpenAI отхвърлени).
- По-просто от dynamic routes: без route-графи, без версии/deployments, без convergence логика.
- **DoW/rate защита не идва оттук** ([0009](0009-global-bggpt-cap-is-a-durable-object.md) — DO); wallet
  защитата на voice зависи DO-то да покрива `/assistant/transcribe` — отделен follow-up.

## Отхвърлена алтернатива

Dynamic routes `voice` + `voice-fallback` (custom-bggpt-voice / workers-ai) — вдигнати, после **премахнати**:
dynamic routing е за chat/LLM маршрутизиране, приема аудио само през несъществуващ audio-compat вход. Не
опитвай пак за транскрипция. Причината е записана тук, за да не се преоткрива.

## Верификация (data-plane, проверено 2026-07-08)

- ✅ **primary** — `POST .../sigma-assistant/custom-bggpt-voice/audio/transcriptions` (multipart, реалният
  VOICE ключ) → 200 + BG транскрипция. Работят и двата суфикса `/audio/transcriptions` и
  `/v1/audio/transcriptions`.
- ✅ **fallback** — `POST .../sigma-assistant/workers-ai/@cf/openai/whisper-large-v3-turbo` (JSON base64,
  CF токен) → 200 + транскрипция.
- ✅ **no-persist (load-bearing)** — A/B през Logs API: заявка **без** `cf-aig-collect-log: false` оставя
  запис (аудио се логва); заявка **с** хедъра не оставя никакъв запис. Значи хедърът спира логването
  изцяло — аудиото не се персистира.

Остава за code-level (lane на Niki): тест, че `cf-aig-collect-log: false` **винаги** присъства във voice
заявките (иначе гаранцията пада); и DoW cap ([0009](0009-global-bggpt-cap-is-a-durable-object.md) — DO)
да покрива `/assistant/transcribe`.
