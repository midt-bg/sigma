import { describe, expect, it } from 'vitest';
import { collectivePersonName, personalRegistryIndent, personNameKey } from './person-identity';

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
