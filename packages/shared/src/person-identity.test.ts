import { describe, expect, it } from 'vitest';
import {
  collectivePersonName,
  personalRegistryIndent,
  personNameKey,
  personNamesAlike,
} from './person-identity';

describe('personNameKey', () => {
  it('compares letters only, in one case and one Unicode form', () => {
    expect(personNameKey('  Иван   Петров-Иванов, ')).toBe('ИВАН ПЕТРОВ ИВАНОВ');
    expect(personNameKey('Йордан')).toBe(personNameKey('Йордан'.normalize('NFD')));
  });

  it('is empty for a value without letters', () => {
    expect(personNameKey(null)).toBe('');
    expect(personNameKey(undefined)).toBe('');
    expect(personNameKey('123 — 456')).toBe('');
  });
});

describe('collectivePersonName', () => {
  it('recognises heirs and co-owners by name', () => {
    expect(collectivePersonName('Наследници на Иван Петров')).toBe(true);
    expect(collectivePersonName('СЪСОБСТВЕНИЦИ')).toBe(true);
  });

  it('recognises more than one full name under one holder', () => {
    expect(collectivePersonName('Иван Петров и Мария Петрова')).toBe(true);
    expect(collectivePersonName('Иван Петров; Мария Петрова')).toBe(true);
  });

  it('keeps one person, including a single-word part beside the name', () => {
    expect(collectivePersonName('Иван Петров Иванов')).toBe(false);
    expect(collectivePersonName('Иван Петров, адвокат')).toBe(false);
  });
});

describe('personalRegistryIndent', () => {
  const hash = 'A'.repeat(64);

  it('accepts a hashed personal number of a person', () => {
    expect(personalRegistryIndent(hash, 'EGN')).toBe(true);
    expect(personalRegistryIndent(hash.toLowerCase(), 'lnch')).toBe(true);
  });

  it('rejects other identifier types and malformed identifiers', () => {
    expect(personalRegistryIndent(hash, 'BirthDate')).toBe(false);
    expect(personalRegistryIndent(hash, null)).toBe(false);
    expect(personalRegistryIndent('a'.repeat(63), 'EGN')).toBe(false);
  });
});

describe('personNamesAlike', () => {
  it('accepts an added or dropped surname, one typo, and a surname taken on marriage', () => {
    expect(personNamesAlike('Ивана Петрова Тестова-Примерова', 'ИВАНА ПЕТРОВА ТЕСТОВА')).toBe(true);
    expect(personNamesAlike('Ивана Петрова Иванова Тестов', 'Ивана Петрова Иванова Тестова')).toBe(
      true,
    );
    expect(personNamesAlike('Георги Боянов Примеров', 'Георги Боянов Примееров')).toBe(true);
    expect(personNamesAlike('Мария Петрова Иванова', 'Мария Петрова Георгиева')).toBe(true);
    expect(personNamesAlike('Иван Петров Иванов', 'ИВАН ПЕТРОВ ИВАНОВ')).toBe(true);
  });

  it('keeps apart different people with close names', () => {
    // Siblings: every name differs by one letter.
    expect(personNamesAlike('Стефан Петров Иванов', 'Стефана Петрова Иванова')).toBe(false);
    // A man's surname does not change on marriage.
    expect(personNamesAlike('Иван Петров Иванов', 'Иван Петров Георгиев')).toBe(false);
    // Short given names get no tolerance.
    expect(personNamesAlike('Иван Петров Иванов', 'Ивана Петров Иванов')).toBe(false);
    // A typo in a given name and a different surname are two differences.
    expect(personNamesAlike('Мария Петрова Иванова', 'Марина Петрова Георгиева')).toBe(false);
    expect(personNamesAlike('Иван Иванов', 'Иван Иванов Петров')).toBe(false);
    expect(personNamesAlike('Иван Петров Иванов', 'Петър Иванов Иванов')).toBe(false);
  });
});
