import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declarationContinuity, CONTINUITY_RULE } from './declaration-continuity.mjs';

test('acts are scoped to the original office, type and report year; candidate generation is deterministic', () => {
  const doc = {
    folder: '2026',
    xmlFile: 'a.xml',
    sourceHash: 'a'.repeat(64),
    person: 'Иван Петров Примеров',
    work: 'Община А',
    declaredPosition: 'Архитект',
    year: 2023,
    declarationType: 'Vacate',
    appointmentNumber: '201',
    appointmentDate: '21.12.',
  };
  const copy = { ...doc, xmlFile: 'b.xml', appointmentDate: '21.12' };
  const records = [
    doc,
    copy,
    { ...doc, xmlFile: 'c.xml', year: 2026 },
    { ...doc, xmlFile: 'd.xml', work: 'Община Б' },
    { ...doc, xmlFile: 'e.xml', person: 'Иван Примеров' },
    { ...doc, xmlFile: 'f.xml', declaredPosition: '', position: 'Архитект' },
  ];
  const edges = declarationContinuity(records, () => assert.fail('No companies'));
  assert.equal(edges.length, 1);
  assert.equal(JSON.parse(edges[0].facts).basis, 'appointment_act');
  assert.deepEqual(declarationContinuity([...records].reverse()), edges);
  const changedType = declarationContinuity([doc, { ...copy, declarationType: 'Entry' }]);
  assert.equal(JSON.parse(changedType[0].facts).basis, 'employment_years');
});

test('municipal administration wording preserves employment continuity without folding the council', () => {
  const doc = {
    folder: '2025',
    xmlFile: 'a.xml',
    sourceHash: 'a'.repeat(64),
    person: 'Иван Петров Примеров',
    work: 'Община Тест',
    declaredPosition: 'Главен архитект',
    year: 2023,
  };
  const next = { ...doc, xmlFile: 'b.xml', work: 'Oбщинска администрация град Тест', year: 2024 };
  const council = { ...next, xmlFile: 'c.xml', work: 'Общински съвет Тест' };
  const edges = declarationContinuity([doc, next, council]);
  assert.equal(edges.length, 1);
  assert.deepEqual(
    JSON.parse(edges[0].facts).documents.map((d) => d.id),
    ['cacbg:2025:a.xml', 'cacbg:2025:b.xml'],
  );
});

// The register's own listing writes a municipality both ways, and read with the exact-match key those
// were two employers: one person's filings then stayed in separate records over a spelling. Measured on
// the dev corpus, 146 names carry exactly this split.
test('one municipality written two ways is one employer; an oblast and a town are not', () => {
  const base = {
    folder: '2025',
    sourceHash: 'a'.repeat(64),
    person: 'Иван Петров Примеров',
    declaredPosition: 'Главен архитект',
    year: 2023,
  };
  const edgeCount = (works) =>
    declarationContinuity(
      works.map((work, i) => ({ ...base, xmlFile: `${i}.xml`, work, year: 2023 + i })),
    ).length;
  // Една община, три изписвания — един работодател (групата дава верига от две ребра).
  assert.equal(edgeCount(['Община Две Могили', 'Две Могили', 'гр. Две Могили']), 2);
  // Областната администрация е самата област.
  assert.equal(edgeCount(['Областна администрация Търговище', 'Област - Търговище']), 1);
  // Област и едноименен град остават различни работодатели.
  assert.equal(edgeCount(['Област Смолян', 'Смолян']), 0);
  // Друго ведомство в същия град също.
  assert.equal(edgeCount(['РЗИ Русе', 'Община Русе']), 0);
});

// One field can name several employers. A chief architect shared by three municipalities writes them all
// in one line; read as a single string it matched no filing naming just one of them — including his own
// next declaration, which then arrived as a second profile carrying nothing but declarations.
test('a field naming several employers joins a filing that names one of them', () => {
  const f = (xmlFile, work) => ({
    folder: '2018',
    xmlFile,
    sourceHash: xmlFile,
    person: 'ПЛАМЕН ТОТЕВ МАРИНОВ',
    year: '2018',
    work,
    declaredPosition: 'ГЛАВЕН АРХИТЕКТ',
    companyEvidence: [],
  });
  const edges = declarationContinuity(
    [f('a.xml', 'ОБЩИНА ДВЕ МОГИЛИ; ОБЩИНА БОРОВО И ОБЩИНА ТУТРАКАН'), f('b.xml', 'ОБЩИНА ДВЕ МОГИЛИ')],
    () => ({}),
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].rule_version, CONTINUITY_RULE);

  // A comma is NOT a separator: institution names carry them, and splitting there invents employers.
  assert.equal(
    declarationContinuity(
      [f('c.xml', 'МИНИСТЕРСТВО НА ТУРИЗМА, ДИРЕКЦИЯ ПРАВНА'), f('d.xml', 'ДИРЕКЦИЯ ПРАВНА')],
      () => ({}),
    ).length,
    0,
  );
  // And the split never joins a council to its municipality, which the fold deliberately keeps apart.
  assert.equal(
    declarationContinuity(
      [f('e.xml', 'ОБЩИНА БЯЛА И ОБЩИНСКИ СЪВЕТ БЯЛА'), f('h.xml', 'ОБЩИНСКИ СЪВЕТ БЯЛА')],
      () => ({}),
    ).every((x) => x),
    true,
  );
});
