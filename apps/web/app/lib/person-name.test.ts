import { expect, it } from 'vitest';
import { personName } from './person-name';

it.each([
  ['ФИДАНКА ДИМИТРОВА ЦИРОВА', 'Фиданка Димитрова Цирова'],
  ['иван петров', 'Иван Петров'],
  ['ТАНЯ ТОДОРОВА МИТЕВА-КАРАКАШ', 'Таня Тодорова Митева-Каракаш'],
  ['АННА МАРИЯ–ПОПОВА', 'Анна Мария–Попова'],
  ['ИВАН П. ПЕТРОВ', 'Иван П. Петров'],
  ["D’ANGELO O'NEILL", "D’Angelo O'Neill"],
  ['Веселин Тодоров Даскалов', 'Веселин Тодоров Даскалов'],
  ['Jean de La Fontaine', 'Jean de La Fontaine'],
  ['Anne McDonald', 'Anne McDonald'],
  ['', ''],
])('formats the display name %s without changing its spelling', (source, expected) => {
  expect(personName(source)).toBe(expected);
  expect(personName(expected)).toBe(expected);
});
