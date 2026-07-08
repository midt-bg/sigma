import { describe, expect, it } from 'vitest';
import {
  authorityIdFromSlug,
  authoritySlug,
  bidderIdFromSlug,
  companySlug,
  contractIdFromSlug,
  contractSlug,
  hrefForEntity,
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
  it('round-trips normalized EOP/OCDS contract ids (no "/" in id)', () => {
    const eopId = 'c:e:UNP-1:CONTRACT-1:2026-06-13';
    const ocdsId = 'c:o:UNP-1:CONTRACT-1:2026-06-13';

    expect(contractIdFromSlug(contractSlug(eopId))).toBe(eopId);
    expect(contractIdFromSlug(contractSlug(ocdsId))).toBe(ocdsId);
  });
  it('percent-encodes path-unsafe chars so the URL segment is always valid', () => {
    // "/" splits the route into multiple segments → 404 without encoding.
    const id = 'c:e:00797-2020-0039:93-ОП20-42/22/:5:eik:102130456:1';
    const slug = contractSlug(id);
    expect(slug).not.toContain('/');
    expect(slug).toContain('%2F');
    // The reading side: React Router decodes params.id before contractIdFromSlug sees it.
    expect(contractIdFromSlug(decodeURIComponent(slug))).toBe(id);

    // Bare "%" must not produce a malformed percent sequence → URIError in React Router.
    const idWithPercent = 'c:e:UNP:50%ADVANCE:_:eik:123456789:1';
    const slugWithPercent = contractSlug(idWithPercent);
    expect(slugWithPercent).toContain('%25');
    expect(() => decodeURIComponent(slugWithPercent)).not.toThrow();
    expect(contractIdFromSlug(decodeURIComponent(slugWithPercent))).toBe(idWithPercent);

    // "?" and "#" are structural URL separators; encode them too.
    const idWithSpecial = 'c:e:UNP:CONTRACT?v=2#note:_:eik:123456789:1';
    const slugWithSpecial = contractSlug(idWithSpecial);
    expect(slugWithSpecial).not.toMatch(/[?#]/);
    expect(() => decodeURIComponent(slugWithSpecial)).not.toThrow();
    expect(contractIdFromSlug(decodeURIComponent(slugWithSpecial))).toBe(idWithSpecial);
  });
});

describe('hrefForEntity', () => {
  it('maps a raw domain id (FTS ref) to its route', () => {
    expect(hrefForEntity('authority', 'auth:000695089')).toBe('/authorities/000695089');
    expect(hrefForEntity('company', 'eik:103267194')).toBe('/companies/103267194');
    expect(hrefForEntity('contract', 'c:52')).toBe('/contracts/52');
  });
  it('produces a URL-safe href for contract ids containing "/"', () => {
    const href = hrefForEntity('contract', 'c:e:UNP:ОП20-42/22/');
    expect(href).not.toContain('/contracts/e:UNP:ОП20-42/22/');
    expect(href).toBe('/contracts/e:UNP:ОП20-42%2F22%2F');
  });
});
