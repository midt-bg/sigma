// The institution canonicalization moved to @sigma/shared so the pipeline and the web app fold one body
// the same way; the test moved with it. Same cases as before, in the package that owns the code.
// node:test — institution canonicalization (N10, review #226). The person grain is (name, institution);
// an official who writes „МВР" in one filing and „Министерство на вътрешните работи" in another must fold to
// ONE identity, not split into two person-pages. The map is CONSERVATIVE by design: only unambiguous,
// stable central-government abbreviations fold. An unknown/ambiguous abbreviation falls through unchanged —
// a SPLIT (safe: two pages for one person) is preferred over a wrong MERGE (libel: two people as one).
import { expect, test } from 'vitest';
import { canonicalInstitution, declarationInstitution, identityInstitution } from './institution';

const EQ = (a: unknown, b: unknown, m?: string) => expect(a, m).toBe(b);
const DEQ = (a: unknown, b: unknown, m?: string) => expect(a, m).toEqual(b);
const OK = (a: unknown, m?: string) => expect(a, m).toBeTruthy();

test('canonicalInstitution — folds an unambiguous ministry abbreviation to its full name', () => {
  const full = 'Министерство на вътрешните работи';
  EQ(canonicalInstitution('МВР'), full);
  EQ(canonicalInstitution('  мвр '), full); // case / whitespace insensitive
  EQ(canonicalInstitution('МВнР'), 'Министерство на външните работи');
  // the full name is already canonical → returned as itself (idempotent)
  EQ(canonicalInstitution(full), full);
  EQ(canonicalInstitution(canonicalInstitution('МВР')), full);
});

test('canonicalInstitution — leaves unknown / ambiguous institutions unchanged (prefer split over wrong merge)', () => {
  // МТ is ambiguous (транспорт vs туризъм over the years) → intentionally NOT in the map
  EQ(canonicalInstitution('МТ'), 'МТ');
  EQ(canonicalInstitution('Община Русе'), 'Община Русе');
  EQ(canonicalInstitution('Някаква непозната институция'), 'Някаква непозната институция');
});

test('canonicalInstitution — empty / nullish is empty (never a spurious canonical value)', () => {
  EQ(canonicalInstitution(''), '');
  EQ(canonicalInstitution('   '), '');
  EQ(canonicalInstitution(null), '');
  EQ(canonicalInstitution(undefined), '');
});

test('declarationInstitution — the listing names the institution unless it only names the declaration type', () => {
  const regular = { institution: 'Община Ямбол', category: 'Кметове и общински съветници' };
  EQ(declarationInstitution({ ...regular, work: 'Общински съвет Ямбол' }), 'Община Ямбол');
  const typeFolder = {
    institution: 'Встъпителни и финални декларации',
    category: 'Встъпителни и финални декларации',
  };
  EQ(declarationInstitution({ ...typeFolder, work: ' Община Ямбол ' }), 'Община Ямбол');
  // Unknown is not a declaration category posing as an institution.
  EQ(declarationInstitution({ ...typeFolder, work: '' }), '');
  EQ(declarationInstitution({ institution: '', work: 'Народно събрание' }), 'Народно събрание');
  EQ(declarationInstitution({}), '');
});

test('identityInstitution — one body under its different spellings is one key', () => {
  EQ(identityInstitution('НАРОДНО СЪБРАНИE'), 'НАРОДНО СЪБРАНИЕ'); // a Latin E
  EQ(identityInstitution('47-мо Народно събрание'), 'НАРОДНО СЪБРАНИЕ');
  EQ(identityInstitution('Народно събрание на РБ'), 'НАРОДНО СЪБРАНИЕ');
  for (const s of [
    'Община Карнобат',
    'ОбС Карнобат',
    'Общински съвет - Карнобат',
    'КАРНОБАТ',
    'гр. Карнобат',
  ])
    EQ(identityInstitution(s), 'КАРНОБАТ', s);
  EQ(identityInstitution('СОБАЛ ПРИМЕР ЕООД, гр. София'), 'СОБАЛ ПРИМЕР ЕООД');
  EQ(identityInstitution('Областна администрация - Смолян'), 'ОБЛАСТ СМОЛЯН');
  EQ(identityInstitution('Област - Смолян'), 'ОБЛАСТ СМОЛЯН');
  EQ(
    identityInstitution('Областна администрация - област Търговище'),
    identityInstitution('Област - Търговище'),
  );
  EQ(identityInstitution('МВР'), 'МИНИСТЕРСТВО НА ВЪТРЕШНИТЕ РАБОТИ'); // abbreviations still fold
});

test('identityInstitution — never joins two different bodies', () => {
  EQ(identityInstitution('Областна дирекция на МВР - Русе'), 'ОБЛАСТНА ДИРЕКЦИЯ НА МВР РУСЕ');
  EQ(identityInstitution('Общинска болница Карнобат'), 'ОБЩИНСКА БОЛНИЦА КАРНОБАТ');
  EQ(identityInstitution('Район Южен - Пловдив'), 'РАЙОН ЮЖЕН ПЛОВДИВ');
  EQ(identityInstitution('Община'), 'ОБЩИНА'); // a bare generic word is not folded to nothing
  expect(identityInstitution('Област Смолян')).not.toBe(identityInstitution('Смолян')); // oblast ≠ town
  EQ(identityInstitution(''), '');
});

test('declaration categories never survive missing workplace data or old category labels', () => {
  EQ(declarationInstitution({ institution: 'Ежегодни декларации' }), '');
  EQ(
    declarationInstitution({ institution: 'Държавни предприятия', work: 'Държавна компания' }),
    'Държавна компания',
  );
});

test('punctuation cannot split one institution, but substantive organisation names remain distinct', () => {
  EQ(
    identityInstitution('Диагностично-Консултативен Център 1 Девня ЕООД'),
    identityInstitution('Диагностично Консултативен Център 1 Девня ЕООД'),
  );
  EQ(
    identityInstitution('СУ „Тестово училище“ - София'),
    identityInstitution('СУ Тестово училище София'),
  );
  expect(identityInstitution('Министерство на икономиката и индустрията')).not.toBe(
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
    EQ(identityInstitution(input), expected);
    EQ(identityInstitution(identityInstitution(input)), expected);
  }
});
