import { describe, expect, it } from 'vitest';
import { canonicalPathname } from './canonical-path';

describe('canonicalPathname', () => {
  it('keeps canonical paths as they are', () => {
    for (const p of ['/', '/companies', '/companies/123456789', '/contracts/e:12:%D0%94%D0%97-1'])
      expect(canonicalPathname(p)).toBe(p);
  });

  it('drops a trailing slash', () => {
    expect(canonicalPathname('/companies/')).toBe('/companies');
    expect(canonicalPathname('/companies//')).toBe('/companies');
  });

  it('lower-cases the route name only', () => {
    expect(canonicalPathname('/Companies')).toBe('/companies');
    expect(canonicalPathname('/COMPANIES/nQUJD')).toBe('/companies/nQUJD');
    expect(canonicalPathname('/Contracts/e:AB')).toBe('/contracts/e:AB');
  });

  it('lower-cases a person id', () => {
    const id = 'ABCDEF0123456789'.repeat(4);
    expect(canonicalPathname(`/Persons/${id}`)).toBe(`/persons/${id.toLowerCase()}`);
    // A slug that is not a 64-hex id stays as it is.
    expect(canonicalPathname('/persons/cGVyc29uOkFC')).toBe('/persons/cGVyc29uOkFC');
  });
});
