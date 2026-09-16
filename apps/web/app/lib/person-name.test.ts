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
