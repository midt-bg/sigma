# ADR-0004 — `style-src` запазва `'unsafe-inline'` (CSP)

- **Статус:** Прието
- **Дата:** 2026-06-30 (записано със задна дата)
- **Обхват:** Итерация 1 — CSP в [`apps/web/app/lib/security.ts`](../../apps/web/app/lib/security.ts). Свързано с #11 (follow-up от security-audit PR #6).

## Контекст

`script-src` вече е строг: per-request nonce за некешираната SSR и per-script SHA-256 hash-ове за
edge-кеширания HTML (`workers/app.ts`) — без `'unsafe-inline'`. `style-src` обаче пази
`'unsafe-inline'`, защото приложението слага inline `style={…}` атрибути за динамични стойности.

Ключов факт: **CSP nonce се прилага към `<style>`/`<script>` _елементи_, не към inline `style=`
_атрибути_.** Затова единственият начин да падне `'unsafe-inline'` от `style-src` е SSR HTML-ът да
съдържа **нула** inline `style=` атрибута.

## Решение

Запазваме `'unsafe-inline'` в `style-src` засега. Понеже днес няма HTML-injection sink (текстът от
АОП се escape-ва от React, никога `dangerouslySetInnerHTML`), това е **defense-in-depth с нисък
приоритет**, а не активна дупка.

## Последствия

- Проследено като follow-up: премахване на inline `style=` атрибутите → сваляне на `'unsafe-inline'`.
- Не е merge-блокер; преразглежда се, когато динамичните стилове минат към класове/CSS променливи.
