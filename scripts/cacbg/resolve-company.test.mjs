import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyNameKey } from '../../packages/shared/src/company-name-key.ts';
import { resolveDeclaredCompany } from './resolve-company.mjs';
const companies = [
  ['111111119', 'АЛФА ЕООД'],
  ['222222229', 'БЕТА ЕООД'],
  ['333333338', 'ГЕНЕРИК ООД'],
  ['444444447', 'ГЕНЕРИК ООД'],
];
const byKey = new Map(),
  bidderByEik = new Map();
for (const [eik, name] of companies) {
  const key = companyNameKey(name),
    rows = byKey.get(key) ?? new Map();
  rows.set(eik, { eik, name, valid: true });
  byKey.set(key, rows);
  bidderByEik.set(eik, { eik, name });
}
const resolve = (text) => resolveDeclaredCompany(text, { byKey, bidderByEik });
test('clean names and one corroborated EIK retain their exact source identity', () => {
  assert.deepEqual(resolve('„Алфа“ ЕООД'), { eik: '111111119', method: 'exact_name_key' });
  assert.deepEqual(resolve('Алфа ЕООД, ЕИК 111111119'), {
    eik: '111111119',
    method: 'declared_eik',
  });
  assert.deepEqual(resolve(',,Алфа" ЕООД'), { eik: '111111119', method: 'extracted_name' });
});
test('a conflicting or unknown stated EIK cannot fall back to the company name', () => {
  for (const text of [
    'Алфа ЕООД, ЕИК 222222229',
    'Алфа ЕООД, ЕИК 999999999',
    'Алфа ЕООД, ЕИК 111111119 или 222222229',
  ])
    assert.deepEqual(resolve(text), { ambiguous: true }, text);
});
test('multiple company candidates cannot select the first, even if only one is a known bidder', () => {
  for (const text of [
    '„Алфа" ЕООД; „Бета" ЕООД',
    '„Алфа" ЕООД; „Неизвестна" ЕООД',
    '„Алфа" ЕООД; „Бета" ЕООД, ЕИК 111111119',
  ])
    assert.deepEqual(resolve(text), { ambiguous: true }, text);
});
test('a name collision needs a single stated EIK with the same full name', () => {
  assert.deepEqual(resolve('Генерик ООД'), { ambiguous: true });
  assert.deepEqual(resolve('Генерик ООД, ЕИК 333333338'), {
    eik: '333333338',
    method: 'declared_eik',
  });
  assert.equal(resolve('неразпознаваемо поле'), null);
  assert.equal(resolve(''), null);
});

test('an unknown prefixed company cannot match a known shorter bidder', () => {
  assert.equal(resolve('ГД „Алфа“ ЕООД'), null);
  assert.deepEqual(resolve('ГД „Алфа“ ЕООД, ЕИК 111111119'), { ambiguous: true });
});
