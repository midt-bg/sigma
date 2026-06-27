# AI асистент — контракти между BE и FE (Фаза 1 → Фаза 2)

> Три замразени контракта, за да тръгнат FE и BE паралелно срещу fixtures, без да чакат BE
> имплементацията. Източник на истината са типовете в `apps/web/app/lib/assistant/report-schema.ts`
> (block-spec) и `agent.ts`/`assistant.chat.tsx` (SSE). Машинните fixtures са в
> [`apps/web/app/lib/assistant/fixtures/`](../../apps/web/app/lib/assistant/fixtures/).
>
> Версия на контракта: **v1**. Промяна → bump на `schemaVersion` в R2 обекта + ред в „Промени" долу.

Свързано: [`ai-assistant.md`](ai-assistant.md) (§4 block-spec, §5 R2, §9 hardening). Owner на трите
контракта: BE integrity core (`apps/web/app/lib/assistant/*`). FE lane-овете ги **консумират, без да ги
пипат**.

---

## 1. Block-spec (`ResolvedReport`) — входът на renderer-а

Това, което `/reports/:id` и chat-картите рендират. Това е **bound** формата: сървърът вече е свързал
реалните стойности от изпълнените резултати (`bindReport`), така че renderer-ът никога не вижда
референции към хендъли, а готови стойности. Числата се **владеят от сървъра** (§9.1) — renderer-ът
само форматира и линква.

```ts
type CellFormat = 'money' | 'number' | 'percent' | 'date' | 'text';
type EntityKind = 'company' | 'authority' | 'contract';

interface ResolvedReport {
  title: string;
  question: string; // зададеният въпрос — показва се като watermark (§9.12)
  blocks: ResolvedBlock[];
  watermark: 'ai-generated'; // renderer-ът ВИНАГИ показва „AI-генерирано, неофициално"
}

type ResolvedBlock =
  | { type: 'text'; md: string } // прозата е markdown БЕЗ raw HTML (вж. гаранции)
  | { type: 'callout'; title: string; md: string }
  | { type: 'totals'; items: { label: string; value: string | number | null; format: CellFormat }[] }
  | { type: 'facts'; items: { term: string; value: string | number | null; sub?: string }[] }
  | { type: 'table'; columns: ResolvedColumn[]; rows: ResolvedRow[]; truncated?: boolean }
  | { type: 'bar'; points: { label: string | number | null; value: number }[]; truncated?: boolean }
  | { type: 'flows'; edges: { from: string; to: string; valueEur: number }[]; truncated?: boolean }
  | {
      type: 'timeseries';
      points: { period: string | number | null; value: number }[];
      truncated?: boolean;
    };

interface ResolvedColumn {
  key: string;
  header: string;
  align?: 'left' | 'right';
  format: CellFormat;
  link?: { kind: EntityKind; idCol: string }; // renderer строи каноничния /companies/:eik и т.н.
}

interface ResolvedRow {
  cells: (string | number | null)[]; // подравнени с `columns`
  links?: (string | null)[]; // подравнени с `columns`: raw id за колоните с `link`, иначе null
}
```

**Линкове в таблица:** за колона `i` с `link`, href-ът е `entityHref(column.link.kind, row.links[i])`.
`links[i]` е `null`, ако колоната няма `link` или id-то липсва. Така id-то **не е видима колона**, а
неизменният R2 обект пак може да реконструира линковете.

**Форматиране и линкове — НЕ ги преоткривай.** Ползвай `render-format.ts`:

- `formatCell(value, format)` → display низ (делегира на `@sigma/shared` money/count/pct/date, за да
  съвпада с останалата част от сайта; `money` е в EUR, `percent` очаква 0..1 ratio; празно → „—").
- `entityHref(kind, id)` → каноничен вътрешен href (делегира на `@sigma/db` `hrefForEntity`).
  `table.columns[].link.idCol` сочи коя колона на реда носи raw id-то.

**Гаранции на binding слоя (на какво можеш да разчиташ):**

1. **Числата са на сървъра.** Всяка стойност в `totals`/`facts`/table-cells/points/edges идва от
   реално изпълнен SQL резултат, не от модела (§9.1). `bar`/`flows`/`timeseries` стойностите са вече
   числа (невалидните → `0`).
2. **Без raw HTML — нийде.** `text`/`callout` прозата е tag-stripped (`sanitizeProse`). **Също и
   текстовите data-cells** (имена на фирми/възложители) се tag-strip-ват при bind — повлияемото от
   подателя съдържание не носи markup (затваря stored-XSS на публичния `/reports/:id`, §7). Renderer-ът
   въпреки това трябва да третира всичко като текст (React escape-ва по подразбиране — не ползвай
   `dangerouslySetInnerHTML` за data-cells/прозата).
3. **Таблиците са „as-is".** `rows` са точно редовете на резултата — нито повече, нито по-малко.
4. **Watermark винаги.** `watermark: 'ai-generated'` присъства винаги; показвай етикета + `question`.
5. **Числа в проза:** `text`/`callout` минават детерминистична проверка „без едри числа/валута в
   прозата" (guardrail E2) преди да станат справка — така прозата не носи неподкрепено число.
6. **`truncated`.** `table`/`bar`/`flows`/`timeseries` носят опционален `truncated?: boolean` — `true`,
   когато подлежащият резултат е ударил byte cap-а на `run_sql`. Renderer-ът показва индикатор
   „резултатите са отрязани", за да не се чете отрязана таблица/графика като пълна.

Fixture: [`fixtures/report.fixture.json`](../../apps/web/app/lib/assistant/fixtures/report.fixture.json).

---

## 2. R2 report object — неизменният артефакт (§5)

Output-ът на агента се записва като **един неизменен JSON обект** в R2 под случаен, непогадаем id.
`/reports/:id` чете точно този обект и го рендира server-side (`Cache-Control: immutable`, CDN edge) —
**никога не пуска агента отново и не докосва D1**.

```ts
interface StoredReport {
  schemaVersion: 1;
  id: string; // случаен, непогадаем (= R2 ключът и /reports/:id сегментът)
  createdAt: string; // ISO-8601 UTC
  model: string; // напр. "bggpt-gemma-3-27b-fp8" — за прозрачност
  report: ResolvedReport; // т.1 по-горе — носи целия snapshot на данните
  provenance: {
    question: string; // дублира report.question за удобство при индексиране
    queries: { handle: string; sql: string; rows: number }[]; // SQL-ите, които я произведоха
    freshness?: string; // свежест по източник, цитирана в callout (§9.7)
  };
}
```

- **id**: непогадаемият id е единствената (мека) privacy граница — unlisted-by-link, без auth за
  гледане. Минимум 128 бита ентропия, URL-safe (base64url/hex).
- **Immutable**: написва се веднъж, не се пипа. Lifecycle правила на R2 може да изтрият стари справки
  (остарял линк → 404, приемливо).
- `provenance.queries.sql` е за одит/прозрачност (как е получено числото) — не се пуска повторно.

Fixture: [`fixtures/r2-report-object.fixture.json`](../../apps/web/app/lib/assistant/fixtures/r2-report-object.fixture.json).

---

## 3. SSE протокол за чата — `POST /assistant/chat`

Stateless resource route. Клиентът post-ва скорошната история като UIMessages; сървърът пуска един ход
на агента (BgGPT през AI Gateway + read-only tool loop) и **стриймва** обратно UI-message stream-а на
Vercel AI SDK (v6).

**Заявка:**

```http
POST /assistant/chat
Content-Type: application/json

{ "messages": UIMessage[] }   // историята + новото съобщение; виж @ai-sdk/react useChat
```

**Отговор:** `text/event-stream` (UI message stream на AI SDK). **Препоръчан начин на консумиране от
FE: `useChat` от `@ai-sdk/react`** — той парсва протокола и попълва `message.parts`; не парсвай SSE
ръчно. Справката пристига като tool-part за `emit_report`:

```ts
// в рамките на message.parts на асистента:
{ type: 'tool-emit_report', toolCallId: string, state: 'output-available',
  output: { ok: true, report: ResolvedReport } | { ok: false, errors: string[] } }
```

Renderer-ът на dock-а: при `tool-emit_report` с `output.ok === true` рендира `output.report` с block
renderer-а (т.1) като карта; иначе показва нормалната проза/текст части. Текстовите части (`type:
'text'`) са разговорният control-plane; продуктът е справката.

**Устойчивост и матрица на грешките (на какво да разчита FE):**

Грешки връщат **два различни слоя**: rate-limit слоят (worker-level, **преди** route-а) и самият
route. Телата им се различават по форма — затова FE-то **не бива да приема `{ "error": … }` JSON при
всяка не-2xx**: rate-limit отговорите са `text/plain`, route отговорите са JSON.

| Статус | Слой / условие | Тяло | Форма | `Retry-After` |
| ------ | -------------- | ---- | ----- | ------------- |
| `429` | rate-limit: надхвърлен per-IP лимит | `Твърде много заявки към асистента. Опитай отново след малко.` | `text/plain` | `60` |
| `503` | rate-limit: fail-closed (липсващ/счупен binding, само прод) | `Rate limiting unavailable` (infra-level, EN) | `text/plain` | `60` |
| `405` | route: метод ≠ `POST` | `{ "error": "методът не е разрешен" }` | JSON | — |
| `403` | route: cross-site заявка (`Sec-Fetch-Site`) | `{ "error": "заявка от друг произход не е разрешена" }` | JSON | — |
| `415` | route: `Content-Type` ≠ `application/json` | `{ "error": "изисква се Content-Type: application/json" }` | JSON | — |
| `413` | route: тялото надхвърля ~256 KB | `{ "error": "историята е твърде голяма" }` | JSON | — |
| `413` | route: едно съобщение надхвърля ~64 KB | `{ "error": "съобщението е твърде дълго" }` | JSON | — |
| `400` | route: невалиден JSON | `{ "error": "невалиден JSON" }` | JSON | — |
| `400` | route: няма годни `messages` | `{ "error": "няма съобщения" }` | JSON | — |
| `503` | route: липсва `BGGPT_API_KEY` (непровизиран) | `{ "error": "Асистентът все още не е конфигуриран." }` | JSON | — |
| `503` | route: грешка при стартиране на хода | `{ "error": "Асистентът временно не е достъпен. Опитай отново след малко." }` | JSON | — |
| `200` | **грешка по време на streaming** (BgGPT outage/timeout) | четим текст в стрийма през `onError`: `Асистентът временно не е достъпен. Опитай отново след малко.` | в SSE стрийма | — |

- **First-party guard (CSRF/DoW):** ендпойнтът приема само `POST` с `Content-Type: application/json`
  от същия произход (`useChat` праща точно това). Cross-site / `text/plain` / `<form>` заявки се
  отхвърлят с `403`/`415`/`405` **преди** платения ход, така че чужда страница не може да стартира
  BgGPT turn от браузъра на жертвата (review #80).
- **Грешка СЛЕД като стриймът е тръгнал** не е HTTP грешка: status-ът е вече `200`, а съобщението идва
  като четим текст в стрийма (не като счупена връзка). `useChat` го показва като нормална реплика.
- **`Retry-After: 60`** има само на `429` и rate-limit `503` — FE-то може да го ползва за backoff;
  route-овите `4xx`/`503` нямат заглавка за повторен опит.
- **Език:** всички съобщения, които достигат потребител, са на български. Единственото изключение е
  infra-level `Rate limiting unavailable` (`503` при непровизиран лимитер — състояние от провизиране,
  не потребителско). FE-то така или иначе показва собствена приятелска реплика и оставя retry на
  потребителя.

Fixture (примерна последователност от raw SSE chunk-ове, за reference): [`fixtures/sse-stream.fixture.txt`](../../apps/web/app/lib/assistant/fixtures/sse-stream.fixture.txt).

---

## Промени

| Версия | Дата       | Промяна                                  |
| ------ | ---------- | ---------------------------------------- |
| v1     | 2026-06-21 | Първоначални три контракта (Фаза 1 → 2). |
