import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declarationContinuity } from './declaration-continuity.mjs';

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
