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

## Golden dataset (#99)

- `packages/db/src/golden-dataset.test.ts` прекарва малък синтетичен корпус (2 възложители × 3
  изпълнители × 8 договора: всичките 5 `value_flag` изхода, трите валутни пътя BGN/EUR/чужда,
  анекси, state-owned ЕИК) през **реалния** derive ред (`derive-amendments` → `normalize-raw` →
  `promote-amendments` → `precompute`) и асъртва **абсолютни, ръчно сметнати** стойности на всяко
  зърно — по-договор, `company_totals`, `authority_totals`, `sector_totals`, `facet_counts`,
  `flow_pairs`, `home_totals`, разпределението на `value_flag`. Хваща каквото reconciliation
  gate-ът структурно не може: дрейф, който запазва грандтотала (вж.
  [`integrity-gate.md`](integrity-gate.md), „Limits of the guarantee").
- **Процедура при умишлена промяна на golden числата.** Когато промяна в правилата легитимно мести
  стойности (нов праг на `value_flag`, нова стойностна база): (1) прочетете кой асърт е червен и
  защо; (2) пресметнете засегнатите очаквания **на ръка от fixture-а и новите правила** — никога не
  копирайте изхода на pipeline-а в константите (така бихте благословили точно бъга, който тестът
  пази); (3) обновете `GOLDEN` заедно с деривационните коментари; (4) обяснете дрейфа в PR
  описанието. Умишлено няма `--update` скрипт.

Свързано: [`review-accuracy.md`](review-accuracy.md).
