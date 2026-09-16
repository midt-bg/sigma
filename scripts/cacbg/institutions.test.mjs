// node:test — institution canonicalization (N10, review #226). The person grain is (name, institution);
// an official who writes „МВР" in one filing and „Министерство на вътрешните работи" in another must fold to
// ONE identity, not split into two person-pages. The map is CONSERVATIVE by design: only unambiguous,
// stable central-government abbreviations fold. An unknown/ambiguous abbreviation falls through unchanged —
// a SPLIT (safe: two pages for one person) is preferred over a wrong MERGE (libel: two people as one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalInstitution,
  declarationInstitution,
  identityInstitution,
} from './institutions.mjs';

test('canonicalInstitution — folds an unambiguous ministry abbreviation to its full name', () => {
  const full = 'Министерство на вътрешните работи';
  assert.equal(canonicalInstitution('МВР'), full);
  assert.equal(canonicalInstitution('  мвр '), full); // case / whitespace insensitive
  assert.equal(canonicalInstitution('МВнР'), 'Министерство на външните работи');
  // the full name is already canonical → returned as itself (idempotent)
  assert.equal(canonicalInstitution(full), full);
  assert.equal(canonicalInstitution(canonicalInstitution('МВР')), full);
});

test('canonicalInstitution — leaves unknown / ambiguous institutions unchanged (prefer split over wrong merge)', () => {
  // МТ is ambiguous (транспорт vs туризъм over the years) → intentionally NOT in the map
  assert.equal(canonicalInstitution('МТ'), 'МТ');
  assert.equal(canonicalInstitution('Община Русе'), 'Община Русе');
  assert.equal(
    canonicalInstitution('Някаква непозната институция'),
    'Някаква непозната институция',
  );
});

test('canonicalInstitution — empty / nullish is empty (never a spurious canonical value)', () => {
  assert.equal(canonicalInstitution(''), '');
  assert.equal(canonicalInstitution('   '), '');
  assert.equal(canonicalInstitution(null), '');
  assert.equal(canonicalInstitution(undefined), '');
});

test('declarationInstitution — the listing names the institution unless it only names the declaration type', () => {
  const regular = { institution: 'Община Ямбол', category: 'Кметове и общински съветници' };
  assert.equal(
    declarationInstitution({ ...regular, work: 'Общински съвет Ямбол' }),
    'Община Ямбол',
  );
  const typeFolder = {
    institution: 'Встъпителни и финални декларации',
    category: 'Встъпителни и финални декларации',
  };
  assert.equal(declarationInstitution({ ...typeFolder, work: ' Община Ямбол ' }), 'Община Ямбол');
  // Unknown is not a declaration category posing as an institution.
  assert.equal(declarationInstitution({ ...typeFolder, work: '' }), '');
  assert.equal(
    declarationInstitution({ institution: '', work: 'Народно събрание' }),
    'Народно събрание',
  );
  assert.equal(declarationInstitution({}), '');
});

test('identityInstitution — one body under its different spellings is one key', () => {
  assert.equal(identityInstitution('НАРОДНО СЪБРАНИE'), 'НАРОДНО СЪБРАНИЕ'); // a Latin E
  assert.equal(identityInstitution('47-мо Народно събрание'), 'НАРОДНО СЪБРАНИЕ');
  assert.equal(identityInstitution('Народно събрание на РБ'), 'НАРОДНО СЪБРАНИЕ');
  for (const s of [
    'Община Карнобат',
    'ОбС Карнобат',
    'Общински съвет - Карнобат',
    'КАРНОБАТ',
    'гр. Карнобат',
  ])
    assert.equal(identityInstitution(s), 'КАРНОБАТ', s);
  assert.equal(identityInstitution('СОБАЛ ПРИМЕР ЕООД, гр. София'), 'СОБАЛ ПРИМЕР ЕООД');
  assert.equal(identityInstitution('Областна администрация - Смолян'), 'ОБЛАСТ СМОЛЯН');
  assert.equal(identityInstitution('Област - Смолян'), 'ОБЛАСТ СМОЛЯН');
  assert.equal(
    identityInstitution('Областна администрация - област Търговище'),
    identityInstitution('Област - Търговище'),
  );
  assert.equal(identityInstitution('МВР'), 'МИНИСТЕРСТВО НА ВЪТРЕШНИТЕ РАБОТИ'); // abbreviations still fold
});

test('identityInstitution — never joins two different bodies', () => {
  assert.equal(
    identityInstitution('Областна дирекция на МВР - Русе'),
    'ОБЛАСТНА ДИРЕКЦИЯ НА МВР РУСЕ',
  );
  assert.equal(identityInstitution('Общинска болница Карнобат'), 'ОБЩИНСКА БОЛНИЦА КАРНОБАТ');
  assert.equal(identityInstitution('Район Южен - Пловдив'), 'РАЙОН ЮЖЕН ПЛОВДИВ');
  assert.equal(identityInstitution('Община'), 'ОБЩИНА'); // a bare generic word is not folded to nothing
  assert.notEqual(identityInstitution('Област Смолян'), identityInstitution('Смолян')); // oblast ≠ town
  assert.equal(identityInstitution(''), '');
});

test('declaration categories never survive missing workplace data or old category labels', () => {
  assert.equal(declarationInstitution({ institution: 'Ежегодни декларации' }), '');
  assert.equal(
    declarationInstitution({ institution: 'Държавни предприятия', work: 'Държавна компания' }),
    'Държавна компания',
  );
});

test('punctuation cannot split one institution, but substantive organisation names remain distinct', () => {
  assert.equal(
    identityInstitution('Диагностично-Консултативен Център 1 Девня ЕООД'),
    identityInstitution('Диагностично Консултативен Център 1 Девня ЕООД'),
  );
  assert.equal(
    identityInstitution('СУ „Тестово училище“ - София'),
    identityInstitution('СУ Тестово училище София'),
  );
  assert.notEqual(
    identityInstitution('Министерство на икономиката и индустрията'),
    identityInstitution('Министерство на икономиката, инвестициите и индустрията'),
  );
});

test('nested council and settlement prefixes normalize once without erasing territorial distinctions', () => {
  for (const [input, expected] of [
    ['Общински съвет гр.Монтана', 'МОНТАНА'],
    ['Общински съвет гр. Сливен', 'СЛИВЕН'],
    ['Общински съвет Община Павликени', 'ПАВЛИКЕНИ'],
    ['Областна администрация Смолян', 'ОБЛАСТ СМОЛЯН'],
  ]) {
    assert.equal(identityInstitution(input), expected);
    assert.equal(identityInstitution(identityInstitution(input)), expected);
  }
});
