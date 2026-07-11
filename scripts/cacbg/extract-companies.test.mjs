import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyCandidates, declaredEiks } from './extract-companies.mjs';
const { companyNameKey } = await import('../../packages/shared/src/company-name-key.ts');

test('companyCandidates pulls „NAME" ФОРМА out of prose', () => {
  assert.deepEqual(companyCandidates('"ТРАНСПОМЕД" ЕООД, ЕИК 101677351'), ['"ТРАНСПОМЕД" ЕООД']);
  assert.deepEqual(companyCandidates('"Кристална вода" АД София'), ['"Кристална вода" АД']);
  // prose sentence with the real company buried
  assert.ok(
    companyCandidates('2 дружествени дяла на „ЕН-ФРЕШ" ООД, прехвърлени нотариално').some((c) =>
      /ЕН-ФРЕШ/.test(c),
    ),
  );
  // no legal form → no candidate (we don't guess bare words)
  assert.deepEqual(companyCandidates('някакъв текст без фирма'), []);
});

test('companyCandidates keeps a mid-name form-token word intact (greedy, no truncation over-merge)', () => {
  // „БЪЛГАРСКА АД ГРУП" ООД contains „АД" as a MIDDLE word. A lazy match truncated the candidate at that
  // first „АД" → key „БЪЛГАРСКА АД", which could exact-match an unrelated short bidder of that name and
  // attach ITS contracts (ADR-0016 libel class). Greedy must capture the full name instead.
  const keys = companyCandidates('„БЪЛГАРСКА АД ГРУП" ООД, ЕИК 100000008').map(companyNameKey);
  assert.ok(keys.includes('БЪЛГАРСКА АД ГРУП ООД'), 'full name key present');
  assert.ok(!keys.includes('БЪЛГАРСКА АД'), 'no truncated key that would over-merge');
});

test('companyCandidates handles «…» guillemet quotes and non-listed legal forms (recall)', () => {
  // The «…» quote style previously produced zero candidates (char-class asymmetry) — a silent recall miss.
  assert.deepEqual(companyCandidates('«Кристала» АД').map(companyNameKey), ['КРИСТАЛА АД']);
  // КООПЕРАЦИЯ / ФОНДАЦИЯ / СДРУЖЕНИЕ are real BG forms (present in classify.mjs) — must be recognised too.
  assert.ok(companyCandidates('„НАПРЕДЪК" КООПЕРАЦИЯ').length > 0, 'cooperative form recognised');
  assert.ok(companyCandidates('„ДОБРО ДЕЛО" ФОНДАЦИЯ').length > 0, 'foundation form recognised');
});

test('declaredEiks finds 9/13-digit ЕИК but not 10-digit ЕГН/date shapes', () => {
  assert.deepEqual(declaredEiks('"ТРАНСПОМЕД" ЕООД, ЕИК 101677351'), ['101677351']);
  assert.deepEqual(declaredEiks('ЕИК 2016176540070 нещо'), ['2016176540070']); // 13-digit
  assert.deepEqual(declaredEiks('вх.№ 2018060520 от регистъра'), []); // 10 digits ≠ ЕИК
  assert.deepEqual(declaredEiks('няма номер'), []);
});

// The declared_eik cross-check (load.mjs / audit.mjs) confirms a typo'd ЕИК by requiring the winner's фирма
// to appear in the declared text. That confirmation MUST be boundary-safe: the winner name „СТРОЙ 1" is a
// mid-token substring of an unrelated фирма „МЕГАСТРОЙ 15", so a raw substring check would falsely confirm it
// and attach СТРОЙ 1's contracts to an official who declared МЕГАСТРОЙ 15 — a fabricated conflict (ADR-0016).
test('declared_eik name-confirm is boundary-safe: an embedded winner name does NOT over-merge', () => {
  const entity = 'дял в „МЕГАСТРОЙ 15" ООД, ЕИК 100000008';
  const confirms = (winnerName) =>
    companyCandidates(entity).some((c) => companyNameKey(c) === companyNameKey(winnerName));

  // The surviving candidate-based check (the only leg load.mjs/audit.mjs keep) rejects the embedded name…
  assert.equal(confirms('СТРОЙ 1'), false);
  // …while still confirming the ACTUAL declared фирма (recall for the legitimate case is preserved).
  assert.equal(confirms('МЕГАСТРОЙ 15 ООД'), true);
  // Documents the removed bug: the old `companyNameKey(text).includes(winnerKey)` leg WOULD have confirmed it.
  assert.equal(companyNameKey(entity).includes(companyNameKey('СТРОЙ 1')), true);
});
