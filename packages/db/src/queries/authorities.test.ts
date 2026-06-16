import { describe, expect, it } from 'vitest';
import { getAuthorityFacets, listAuthorities, streamAuthoritiesCsv } from './authorities';

const authorityRow = {
  authority_id: 'auth:000695089',
  name: 'Министерство на финансите',
  type_group: 'министерство',
  settlement: 'София',
  region: 'Столична',
  spent_eur: 1000000,
  contracts: 100,
  suppliers: 30,
  avg_eur: 10000,
  primary_sector: '45',
  eu_eur: 200000,
  first_date: '2020-01-01',
  last_date: '2024-12-31',
  sort_value: 1000000,
};

function fakeDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          if (sql.includes('type_group') && sql.includes('GROUP BY')) {
            return { results: [{ type_group: 'министерство', n: 10 }] as T[] };
          }
          if (sql.includes('sector_totals')) {
            return { results: [{ division: '45', value_eur: 500000 }] as T[] };
          }
          return { results: [authorityRow] as T[] };
        },
        async first<T>() {
          return { n: 1 } as T;
        },
      };
    },
  } as D1Database;
}

describe('listAuthorities', () => {
  it('returns a page with items and total for an unfiltered request', async () => {
    const page = await listAuthorities(fakeDb(), { pageSize: 10 });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.items[0]!.slug).toBe('000695089');
    expect(page.items[0]!.spentEur).toBe(1000000);
  });

  it('falls back to the default sort instead of throwing for an invalid sort key', async () => {
    await expect(
      listAuthorities(fakeDb(), { sort: 'invalid' as never, pageSize: 10 }),
    ).resolves.toBeDefined();
  });

  it('uses the base aggregation source when sector filters are present', async () => {
    const seenSql: string[] = [];
    const db = {
      prepare(sql: string) {
        seenSql.push(sql);
        return {
          bind() { return this; },
          async all<T>() { return { results: [authorityRow] as T[] }; },
          async first<T>() { return { n: 1 } as T; },
        };
      },
    } as D1Database;

    await listAuthorities(db, { sectors: ['45'], pageSize: 10 });

    expect(seenSql.some((sql) => sql.includes('FROM contracts c'))).toBe(true);
  });

  it('uses the authority_totals rollup when no cross-cut filters are set', async () => {
    const seenSql: string[] = [];
    const db = {
      prepare(sql: string) {
        seenSql.push(sql);
        return {
          bind() { return this; },
          async all<T>() { return { results: [authorityRow] as T[] }; },
          async first<T>() { return { n: 1 } as T; },
        };
      },
    } as D1Database;

    await listAuthorities(db, { pageSize: 10 });

    expect(seenSql.some((sql) => sql.includes('FROM authority_totals'))).toBe(true);
    expect(seenSql.every((sql) => !sql.includes('FROM contracts c'))).toBe(true);
  });
});

describe('getAuthorityFacets', () => {
  it('returns type and sector facets', async () => {
    const facets = await getAuthorityFacets(fakeDb());

    expect(facets.types).toHaveLength(1);
    expect(facets.types[0]!.value).toBe('министерство');
    expect(facets.types[0]!.count).toBe(10);
  });

  it('only returns sectors that have a non-zero value from sector_totals', async () => {
    const facets = await getAuthorityFacets(fakeDb());

    expect(facets.sectors.length).toBeGreaterThanOrEqual(1);
    expect(facets.sectors.every((s) => s.count > 0)).toBe(true);
  });

  it('includes a valid CPV sector code and label in the sectors facet', async () => {
    const facets = await getAuthorityFacets(fakeDb());
    const sector45 = facets.sectors.find((s) => s.value === '45');

    expect(sector45).toBeDefined();
    expect(typeof sector45?.label).toBe('string');
  });
});

describe('streamAuthoritiesCsv', () => {
  it('returns a Response with CSV content-type and attachment disposition', () => {
    const db: D1Database = {
      prepare() {
        return {
          bind() { return this; },
          async all<T>() { return { results: [] as T[] }; },
        };
      },
    } as D1Database;

    const response = streamAuthoritiesCsv(db, {});

    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    expect(response.headers.get('Content-Disposition')).toContain('sigma-authorities.csv');
  });
});
