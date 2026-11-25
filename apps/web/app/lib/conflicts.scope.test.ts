import { describe, expect, it } from 'vitest';
import {
  conflictFacets,
  conflictListFilters,
  conflictScopeLine,
  legacyConflictSearch,
  listConflictPeople,
  type ConflictPersonRow,
} from './conflicts';

// The scope of the /conflicts list: by default ownership or management with a contract inside the overlap
// of the office and the tie; two independent checkboxes widen it.
const row = (over: Partial<ConflictPersonRow>): ConflictPersonRow => ({
  official: 'Лице Тестово',
  officialSlug: 'x',
  personIdentity: over.officialSlug ?? 'x',
  institution: null,
  position: null,
  companyCount: 1,
  soleCompany: null,
  contractCount: 1,
  contractValueEur: 100,
  contemporaneousValueEur: null,
  stakeKind: 'self',
  ownInstitution: false,
  hasContemporaneous: false,
  ...over,
});

const inPeriod = { hasContemporaneous: true, contemporaneousValueEur: 50 };
const everyone: ConflictPersonRow[] = [
  // A declared stake with a contract in the period: in every scope.
  row({ officialSlug: 'own-in', ...inPeriod, ownInstitution: true, declaredInstitutions: [] }),
  // A relative's declared stake, contracts only outside the period — or a period that cannot be told.
  row({ officialSlug: 'family-out', stakeKind: 'family' }),
  // The register alone: ownership in the period.
  row({ officialSlug: 'reg-in', stakeKind: 'registry', ...inPeriod, direct: undefined }),
  // The register alone: only a seat on a board, in the period.
  row({
    officialSlug: 'seat-in',
    stakeKind: 'registry',
    ...inPeriod,
    companies: [{ company: 'Б', eik: '2', self: 0, family: 0, registry: 1, registryRole: 'board' }],
    direct: null,
  }),
  // The register alone: only a seat, outside the period.
  row({
    officialSlug: 'seat-out',
    stakeKind: 'registry',
    companies: [{ company: 'В', eik: '3', self: 0, family: 0, registry: 1, registryRole: 'board' }],
    direct: null,
  }),
];
const slugs = (qs: string) =>
  listConflictPeople(everyone, conflictListFilters(new URLSearchParams(qs)))
    .map((r) => r.officialSlug)
    .sort();

describe('/conflicts scope', () => {
  it('lists by default only ownership or management with a contract in the period', () => {
    expect(slugs('')).toEqual(['own-in', 'reg-in']);
  });

  it('widens to the ties without a contract in the period, seats left out', () => {
    expect(slugs('include=outside')).toEqual(['family-out', 'own-in', 'reg-in']);
  });

  it('widens to the seats on governing bodies, still with a contract in the period', () => {
    expect(slugs('include=boards')).toEqual(['own-in', 'reg-in', 'seat-in']);
  });

  it('widens to both at once', () => {
    expect(slugs('include=outside&include=boards')).toEqual([
      'family-out',
      'own-in',
      'reg-in',
      'seat-in',
      'seat-out',
    ]);
  });

  it('keeps a person whose period is unknown out of the default list, and reachable through the widened scope', () => {
    // No overlap could be established: the query leaves hasContemporaneous false and the period value null.
    const unknown = row({ officialSlug: 'unknown', contemporaneousValueEur: null });
    const ids = (qs: string) =>
      listConflictPeople([unknown], conflictListFilters(new URLSearchParams(qs))).map(
        (r) => r.officialSlug,
      );
    expect(ids('')).toEqual([]);
    expect(ids('include=outside')).toEqual(['unknown']);
  });

  it('applies each source and the buyer filter inside the scope', () => {
    expect(slugs('include=outside&source=self')).toEqual(['own-in']);
    expect(slugs('include=outside&source=family')).toEqual(['family-out']);
    expect(slugs('include=outside&source=registry')).toEqual(['reg-in']);
    expect(slugs('include=outside&include=boards&source=registry')).toEqual([
      'reg-in',
      'seat-in',
      'seat-out',
    ]);
    expect(slugs('source=family')).toEqual([]);
    expect(slugs('buyer=own')).toEqual(['own-in']);
    expect(slugs('include=outside&include=boards&buyer=own')).toEqual(['own-in']);
  });

  it('counts each choice with every other filter kept, and a scope checkbox by the people it adds', () => {
    const facets = conflictFacets(everyone, conflictListFilters(new URLSearchParams()));
    expect(facets.source).toEqual({ all: 2, self: 1, family: 0, registry: 1 });
    expect(facets.buyer).toEqual({ all: 2, own: 1 });
    expect(facets.include).toEqual({ outside: 1, boards: 1, both: 5 });
    const wide = conflictFacets(
      everyone,
      conflictListFilters(new URLSearchParams('include=outside&include=boards')),
    );
    expect(wide.source).toEqual({ all: 5, self: 1, family: 1, registry: 3 });
    expect(wide.include).toMatchObject({ outside: 2, boards: 2 });
  });

  it('describes the current scope in one sentence', () => {
    const line = (qs: string) => conflictScopeLine(conflictListFilters(new URLSearchParams(qs)));
    expect(line('')).toMatch(/^Собственост или управление с договори в периода на длъжността/);
    expect(line('include=boards')).toMatch(/управителен орган с договори в периода/);
    expect(line('include=outside')).toMatch(
      /със или без договори.*периодът не може да се установи/,
    );
  });
});

describe('old /conflicts filter addresses', () => {
  const legacy = (qs: string) => legacyConflictSearch(new URLSearchParams(qs))?.toString() ?? null;

  it('leaves a new address alone', () => {
    expect(legacy('')).toBeNull();
    expect(legacy('source=self&include=boards&q=тест')).toBeNull();
  });

  it('maps each old parameter to the new one and keeps every other filter', () => {
    expect(legacy('stake=self')).toBe('source=self');
    expect(legacy('stake=family&sort=total')).toBe('sort=total&source=family');
    expect(legacy('stake=registry&role=all')).toBe('source=registry&include=boards');
    expect(legacy('role=all&include=outside')).toBe('include=outside&include=boards');
    expect(legacy('signal=own&institution=Община+Тест&q=x&authority=000000000')).toBe(
      'institution=%D0%9E%D0%B1%D1%89%D0%B8%D0%BD%D0%B0+%D0%A2%D0%B5%D1%81%D1%82&q=x&authority=000000000&buyer=own',
    );
    // A contract in the period is now the default: the old signal for it has nothing left to ask.
    expect(legacy('signal=window')).toBe('');
    expect(legacy('stake=bogus&role=bogus')).toBe('');
  });

  it('reads the mapped address as the same selection', () => {
    const mapped = legacyConflictSearch(new URLSearchParams('stake=family&role=all&signal=own'))!;
    expect(conflictListFilters(mapped)).toMatchObject({
      stake: 'family',
      role: 'all',
      period: 'overlap',
      ownBuyer: true,
    });
  });
});
