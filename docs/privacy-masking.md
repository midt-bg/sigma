# Маскиране на естествени лица и `X-Robots-Tag: noindex` — ръководство за разработчици

Това е оперативното ръководство за механиката зад политиката от [ADR-0007](adr/0007-privacy-masking.md) и решението за централизация от [ADR-0008](adr/0008-centralized-x-robots-tag-worker.md). За потребителското описание виж [`apps/web/app/routes/privacy.tsx`](../apps/web/app/routes/privacy.tsx) (`#natural-person-data`).

## Как работи механиката

Идеята е **разделяне на отговорностите**: route-овете решават *дали* даден отговор съдържа маскирани естествено-личностни данни; worker-ът решава *как* да се излъчи публичният `X-Robots-Tag: noindex`.

```
loader / helper                worker (hardenResponse)            edge cache / client
─────────────────              ────────────────────────           ────────────────────
X-Privacy-Mask: applied  ──►   applyPrivacyMaskHeaders()    ──►   X-Robots-Tag: noindex
                               ├─ превежда маркера в noindex       (маркерът е изтрит)
                               └─ delete X-Privacy-Mask
```

- **Маркер:** `X-Privacy-Mask: applied` (вътрешен — никога не напуска worker-а). Константите `PRIVACY_MASK_MARKER` / `PRIVACY_MASK_APPLIED` са в [`apps/web/app/lib/security.ts`](../apps/web/app/lib/security.ts).
- **Слагане:** `markPrivacyMaskApplied(headers)` — route или helper го вика, когато тялото съдържа маскирани данни.
- **Превод:** `applyPrivacyMaskHeaders(headers)` — вика се **само** от `hardenResponse` в [`apps/web/workers/app.ts`](../apps/web/workers/app.ts). Това е единственото място, което пише `X-Robots-Tag: noindex`.
- **Предикат:** `isNaturalPersonBidder(displayName, legalForm)` от [`packages/shared/src/format.ts`](../packages/shared/src/format.ts) — единственият източник на истината дали даден запис е естествено лице / едноличен търговец. HTML, CSV и JSON споделят него; няма дублирани хардкоднати правила в route-овете.

## Повърхности, които маркират днес

| Повърхност | Маркира в | Маскиране на тялото |
|---|---|---|
| `/contracts/:id.json` | `apps/web/app/routes/contract.json.tsx` | ЕИК→`null`, име→`MASKED_NATURAL_PERSON_LABEL` |
| `/contracts.csv`, `/companies.csv`, `/authorities.csv` | `apps/web/app/lib/csv-export.ts` (4 клона) | ЕИК→празен низ, име→`MASKED_NATURAL_PERSON_LABEL` (`authorities.csv` без маскиране) |
| `/companies/:eik` (HTML) | `apps/web/app/routes/company.tsx` `headers()` препраща маркера | `company.eik = null` в loader-а |
| `/companies/:eik.data` (single-fetch twin) | същият loader (споделен с HTML) | автоматично — споделя loader-а |

## Как да добавите нова машинно-четима повърхност

1. В loader-а / helper-а, когато отговорът съдържа (или може да съдържа) естествено-личностни данни, извикайте `markPrivacyMaskApplied(headers)` върху изходящите `Headers`.
2. Ако повърхността е HTML document route (не resource route), експортирайте `headers({ loaderHeaders })`, който препраща `X-Privacy-Mask: applied` — React Router не авто-пропагира loader хедърите (само `Set-Cookie`). Виж примера в `company.tsx`.
3. Нищо друго не е нужно — `hardenResponse` в worker-а ще преведе маркера в `X-Robots-Tag: noindex` и ще изтрие маркера преди кеш/клиент.
4. Ако повърхността сервира сурови идентификатори (ЕИК/име), маскирайте ги в тялото преди маркировката (ЕТ→`null`/празен низ, име→`MASKED_NATURAL_PERSON_LABEL`).

> Никога не пишете `X-Robots-Tag: noindex` директно в route или helper — това нарушава единственото авторско място (C1 от критериите за приемане). Единственото изключение е тестов код.

## Тестване

Тестовете са разделени според разделението на отговорностите:

- **Loader/helper тестове** твърдят: маркерът `X-Privacy-Mask: applied` присъства **и** `X-Robots-Tag` **липсва** на loader output-а (преводът е работа на worker-а).
  - [`apps/web/app/lib/security.test.ts`](../apps/web/app/lib/security.test.ts)
  - [`apps/web/app/routes/contract.json.test.ts`](../apps/web/app/routes/contract.json.test.ts)
  - [`apps/web/app/lib/csv-export.test.ts`](../apps/web/app/lib/csv-export.test.ts)
  - [`apps/web/app/routes/company.data.test.ts`](../apps/web/app/routes/company.data.test.ts) — `.data` twin: `eik: null` + маркер след `hardenResponse`; edge-cache HIT път; без хедър за юридическо лице.
- **Worker тестове** твърдят превода маркер → `X-Robots-Tag: noindex` и изтриването на маркера.
  - [`apps/web/workers/app.nofollow.test.ts`](../apps/web/workers/app.nofollow.test.ts)
