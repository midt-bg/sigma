import { expect, it } from 'vitest';
import { personName } from './person-name';

it.each([
  ['МАРИНА ПЕТРОВА ТЕСТОВА', 'Марина Петрова Тестова'],
  ['иван петров', 'Иван Петров'],
  ['ЕЛЕНА ИВАНОВА ТЕСТОВА-ПРИМЕРОВА', 'Елена Иванова Тестова-Примерова'],
  ['АННА МАРИЯ–ПОПОВА', 'Анна Мария–Попова'],
  ['ИВАН П. ПЕТРОВ', 'Иван П. Петров'],
  ["D’ANGELO O'NEILL", "D’Angelo O'Neill"],
  ['Стефан Иванов Тестов', 'Стефан Иванов Тестов'],
  ['Jean de La Fontaine', 'Jean de La Fontaine'],
  ['Anne McDonald', 'Anne McDonald'],
  ['', ''],
])('formats the display name %s without changing its spelling', (source, expected) => {
  expect(personName(source)).toBe(expected);
  expect(personName(expected)).toBe(expected);
});

// The register's own spelling carries stray runs of whitespace, which show as a visible gap on a page
// that names a person. Identity keys are built from the source value, never from this one.
it('collapses the register’s stray whitespace without touching the spelling', () => {
  expect(personName('МАРИЯ  ВАСИЛЕВА  КАПОН')).toBe('Мария Василева Капон');
  expect(personName('  Иван Петров Тестов  ')).toBe('Иван Петров Тестов');
  expect(personName('Иван\tПетров\nТестов')).toBe('Иван Петров Тестов');
  expect(personName('Иван Петров Тестов')).toBe('Иван Петров Тестов');
});
