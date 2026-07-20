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

// listAuthorities chooses its FROM clause from the active filters (see authorities.ts `needsBase`):
// the precomputed `authority_totals` rollup for a plain leaderboard, a scoped base aggregation over
// `contracts` once a sector/year/EU cross-cut is set. There's no real D1 here, so the branch-selection
// tests pin that choice by matching the table source in the prepared SQL. Naming the two markers keeps
// the assertions reading as intent rather than raw query text, and localises any future table rename.
const usesRollup = (sql: string) => sql.includes('FROM authority_totals');
const usesBaseAggregation = (sql: string) => sql.includes('FROM contracts c');

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

// A SQL-capturing fake DB for the branch-selection tests: records every prepared statement and returns
// one authority row regardless of query, so we can assert *which* table source ran. (Deliberately not a
// wrapper over fakeDb above — its facet branch would hijack the base-aggregation page query, which also
// contains `type_group` + `GROUP BY`, and feed back a facet-shaped row that toAuthorityListItem can't map.)
function spyDb(): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = {
    prepare(q: string) {
      sql.push(q);
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: [authorityRow] as T[] };
        },
        async first<T>() {
          return { n: 1 } as T;
        },
      };
    },
  } as D1Database;
  return { db, sql };
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
    const { db, sql } = spyDb();

    await listAuthorities(db, { sectors: ['45'], pageSize: 10 });

    expect(sql.some(usesBaseAggregation)).toBe(true);
  });

  it('uses the authority_totals rollup when no cross-cut filters are set', async () => {
    const { db, sql } = spyDb();

    await listAuthorities(db, { pageSize: 10 });

    expect(sql.some(usesRollup)).toBe(true);
    expect(sql.every((s) => !usesBaseAggregation(s))).toBe(true);
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
    const db = {
      prepare(_sql: string) {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
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
