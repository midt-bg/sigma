# Тестове и CI (при ревю)

> Изведено от повтарящи се бележки в ревютата. Какво ревюто очаква, преди да даде зелено.

## Type gate

- **`pnpm typecheck` е авторитетната проверка на типове — vitest транспилира без проверка на
  типове.** Fixture с липсващо задължително поле минава vitest, но пада на CI. Пускайте и двете.
- `pnpm audit --audit-level=high` трябва да излиза с 0 — фиксирайте transitive advisory-та в
  `pnpm.overrides`; то блокира CI за всички отворени PR-и, затова го мърджвайте с приоритет.

## Регресионни тестове

- Всяка поправка на коректностен бъг идва с тест, който заключва точния инвариант — така че revert
  или преформатиране го прави червен.
- Тестовете са състезателни, не „за отметка": проверявайте гранични и враждебни входове
  (`__proto__`/`toString` ключове, cursor над лимита, fail-open пътища, празен корпус, surrogate на
  границата на cap-а), не само щастливия път.
- Чисти помощни функции (`seoMeta`, `xmlEscape`, `moneyBare`, `escapeSqlText`…) имат unit тестове —
  особено клонът „липсващ/null вход".

## Слой за данни

- Целият SQL живее в `@sigma/db` с тестове; loader-ите викат експортирани функции (вж.
  [`review-code-and-process.md`](review-code-and-process.md)).
- Тествайте кой клон се избира между rollup таблица (`FROM authority_totals`/`FROM flow_pairs`) и
  базова таблица (`FROM contracts c`) — точно това регресира тихо.
- Стил на DB-тестове: `spyDb()` helper + именувани предикати, не `sql.includes('FROM …')`.
- Всеки пакет с тестове закача `"test": "vitest run"` в turbo графа — `apps/etl` (`eop.test.ts`)
  беше тихо прескачан от `turbo run test`, докато това не се поправи.

## Coverage ratchet

- Локално: `pnpm test -- --coverage && pnpm check:coverage`. CI пуска същото — покритието се
  измерва с `@vitest/coverage-v8` през общия preset (`vitest.shared.ts`), по workspace.
- Ratchet правилото: lines% и branches% на всеки workspace не може да падне под комитнатия
  `coverage-baseline.json` с повече от 0.5pp (толерансът поглъща шум от малките пакети с 1–2
  тестови файла). Спад ⇒ червено CI; PR-ът показва таблицата с делтите (step summary + sticky
  коментар за същия-repo PR-и, artifact за форкове).
- Покачване с >1pp ⇒ скриптът подканя `node scripts/check-coverage.mjs --update` — прегледайте и
  комитнете новия baseline в същия PR. Умишлен, ревюиран спад се изразява със сваляне на числото
  в `coverage-baseline.json`, не с изключване на проверката.
- Нов workspace с тестове се добавя и в `coverage-baseline.json` (и получава `vitest.config.ts`
  с `sharedCoverage(...)`); `packages/api-contract` е освободен, докато няма тестове.

## Integrity gate

- Пуска се върху обслужвания D1 след `precompute` в `ship-domain.mjs` и след `runSliceDerive()` в
  `import.mjs`.
- Безусловна проверка за непразен корпус (`COUNT(contracts) > 0`, без self-skip) — празна served D1
  не бива да минава зелено.
- Тестовете асъртват, че задължителните проверки **не** са се skip-нали (тих skip ≠ зелено);
  `tableExists` guard дава чист SKIP вместо `no such table` срив.
- WARN срещу твърд провал: дефекти, които СИГМА контролира, провалят (`value_flag='ok'` с
  отрицателен `amount_eur`, отрицателни rollup тотали, `inserted > candidates`); дефекти от
  upstream EOP емисията дават WARN — не чупят дневния импорт, но се сурфейсват шумно (вж.
  [`integrity-gate.md`](integrity-gate.md)).

Свързано: [`review-accuracy.md`](review-accuracy.md).
