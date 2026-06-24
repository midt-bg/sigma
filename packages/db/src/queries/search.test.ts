import { describe, expect, it } from 'vitest';
import {
  MAX_QUERY_CHARS,
  MAX_QUERY_TOKENS,
  search,
  searchMatchQuery,
  searchMoreHref,
} from './search';

function searchDb(): D1Database {
  const companyRows = [
    {
      ref: 'name:А1 БЪЛГАРИЯ ЕАД; БЕТА ООД',
      title: 'А1 БЪЛГАРИЯ ЕАД; БЕТА ООД',
      ident: '',
      subtitle: null,
      amount: 2000,
      entity_kind: 'consortium',
      ownership_kind: null,
      eik_valid: 0,
    },
    {
      ref: 'name:No EIK Company',
      title: 'No EIK Company',
      ident: '',
      subtitle: null,
      amount: 1500,
      entity_kind: 'company',
      ownership_kind: null,
      eik_valid: 0,
    },
    ...Array.from({ length: 4 }, (_, i) => ({
      ref: `eik:11111111${i}`,
      title: `Company ${i}`,
      ident: `11111111${i}`,
      subtitle: null,
      amount: 1000 + i,
      entity_kind: 'company',
      ownership_kind: i === 0 ? 'state' : null,
      eik_valid: 1,
    })),
  ];
  const contractRows = Array.from({ length: 6 }, (_, i) => ({
    ref: `c:${i}`,
    title: `Contract ${i}`,
    ident: `UNP-${i}`,
    subtitle: null,
    amount: 1000 + i,
  }));

  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        async all<T>() {
          if (sql.includes('COUNT(*) AS n')) {
            return {
              results: [
                { kind: 'company', n: 7 },
                { kind: 'contract', n: 6 },
              ] as T[],
            };
          }

          const kind = bound[0];
          if (kind === 'company') return { results: companyRows as T[] };
          if (kind === 'contract') return { results: contractRows as T[] };
          return { results: [] as T[] };
        },
      };
    },
  } as D1Database;
}

describe('search helpers', () => {
  it('builds list hrefs with an encoded q filter', () => {
    const href = searchMoreHref('company', 'строителство София');
    const url = new URL(`https://sigma.test${href}`);

    expect(url.pathname).toBe('/companies');
    expect(url.searchParams.get('q')).toBe('строителство София');
  });

  it('caps over-long MATCH queries at the shared chokepoint', () => {
    const q = Array.from({ length: 32 }, (_, i) => `word${i}`).join(' ');
    expect(q.length).toBeGreaterThan(MAX_QUERY_CHARS);

    const match = searchMatchQuery(q);
    const terms = match?.split(' ') ?? [];

    expect(terms.length).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
    expect(match?.length).toBeLessThanOrEqual(MAX_QUERY_CHARS + MAX_QUERY_TOKENS);
  });

  it('keeps normal short MATCH query behavior unchanged', () => {
    expect(searchMatchQuery('Стрoителствo София 123')).toBe('строителство* софия* 123*');
  });

  it('drops single-character terms so a 1-char prefix cannot scan the whole index', () => {
    // Every token is one char → nothing survives the min-length filter → empty query.
    expect(searchMatchQuery('и а с по')).toBe('по*');
    expect(searchMatchQuery('и')).toBeNull();
    expect(searchMatchQuery('a b c')).toBeNull();
  });
});

describe('search', () => {
  it('sets moreHref only for truncated groups', async () => {
    const results = await search(searchDb(), 'строителство');
    const company = results.groups.find((g) => g.kind === 'company');
    const contract = results.groups.find((g) => g.kind === 'contract');
    const authority = results.groups.find((g) => g.kind === 'authority');

    expect(company?.moreHref).toBe(
      '/companies?q=%D1%81%D1%82%D1%80%D0%BE%D0%B8%D1%82%D0%B5%D0%BB%D1%81%D1%82%D0%B2%D0%BE',
    );
    expect(contract?.moreHref).toBeNull();
    expect(authority?.moreHref).toBeNull();
  });

  it('flags company search exceptions without exposing consortium member piles as titles', async () => {
    const results = await search(searchDb(), 'а1');
    const hits = results.groups.find((g) => g.kind === 'company')?.hits ?? [];

    expect(hits[0]).toMatchObject({
      title: 'А1 БЪЛГАРИЯ ЕАД и др.',
      ident: null,
      isConsortium: true,
      hasEik: false,
      memberCount: 2,
    });
    expect(hits[1]).toMatchObject({
      title: 'No EIK Company',
      ident: null,
      isConsortium: false,
      hasEik: false,
      memberCount: null,
    });
    expect(hits[2]).toMatchObject({
      title: 'Company 0',
      ownershipKind: 'state',
    });
  });
});
