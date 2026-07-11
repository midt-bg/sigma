import { describe, expect, it } from 'vitest';
import {
  authorityIdFromSlug,
  authoritySlug,
  bidderIdFromSlug,
  companySlug,
  contractIdFromSlug,
  contractSlug,
  hrefForEntity,
  personIdFromSlug,
  personSlug,
} from './identity';

describe('company slug', () => {
  it('uses the bare ЕИК for valid bidders (clean, shareable)', () => {
    expect(companySlug('eik:103267194')).toBe('103267194');
    expect(bidderIdFromSlug('103267194')).toBe('eik:103267194');
  });
  it('reversibly encodes name-keyed bidders (incl. Cyrillic, no collisions)', () => {
    const id = 'name:МЕДЕКС ООД; АЛТА ФАРМАСЮТИКЪЛС ООД';
    const slug = companySlug(id);
    expect(slug.startsWith('n')).toBe(true);
    expect(slug).not.toContain(' ');
    expect(bidderIdFromSlug(slug)).toBe(id);
  });
  it('round-trips a 13-digit ЕИК', () => {
    expect(bidderIdFromSlug(companySlug('eik:1234567890123'))).toBe('eik:1234567890123');
  });
});

describe('authority / contract slugs', () => {
  it('round-trips authority ЕИК', () => {
    expect(authoritySlug('auth:000695089')).toBe('000695089');
    expect(authorityIdFromSlug('000695089')).toBe('auth:000695089');
  });
  it('round-trips contract rowid', () => {
    expect(contractSlug('c:52')).toBe('52');
    expect(contractIdFromSlug('52')).toBe('c:52');
  });
  it('round-trips normalized EOP/OCDS contract ids', () => {
    const eopId = 'c:e:UNP-1:CONTRACT-1:2026-06-13';
    const ocdsId = 'c:o:UNP-1:CONTRACT-1:2026-06-13';

    expect(contractIdFromSlug(contractSlug(eopId))).toBe(eopId);
    expect(contractIdFromSlug(contractSlug(ocdsId))).toBe(ocdsId);
  });
});

describe('person slug (свързани лица)', () => {
  it('reversibly encodes a person id (Cyrillic name key, URL-safe)', () => {
    const id = 'person:ИВАН ПЕТРОВ ГЕОРГИЕВ';
    const slug = personSlug(id);
    expect(slug).not.toContain(' ');
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('+');
    expect(personIdFromSlug(slug)).toBe(id);
  });
  it('round-trips a key that itself contains a pipe (never split-parsed)', () => {
    // person_id feeds link_key as `person_id|eik`; the slug must not depend on that separator.
    const id = 'person:ФИРМА | ЕООД';
    expect(personIdFromSlug(personSlug(id))).toBe(id);
  });
  it('returns null for an undecodable slug rather than throwing', () => {
    expect(personIdFromSlug('!!!not base64!!!')).toBeNull();
  });
});

describe('hrefForEntity', () => {
  it('maps a raw domain id (FTS ref) to its route', () => {
    expect(hrefForEntity('authority', 'auth:000695089')).toBe('/authorities/000695089');
    expect(hrefForEntity('company', 'eik:103267194')).toBe('/companies/103267194');
    expect(hrefForEntity('contract', 'c:52')).toBe('/contracts/52');
  });
});
