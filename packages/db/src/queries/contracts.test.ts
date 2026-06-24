import { describe, expect, it } from 'vitest';
import { getContractFacets, listContracts, normalizeContractSort } from './contracts';

describe('normalizeContractSort', () => {
  it('passes known sort keys through', () => {
    expect(normalizeContractSort('date-asc')).toBe('date-asc');
    expect(normalizeContractSort('value-desc')).toBe('value-desc');
  });
  it('collapses unknown / missing / prototype keys to the default', () => {
    expect(normalizeContractSort(null)).toBe('value-desc');
    expect(normalizeContractSort('')).toBe('value-desc');
    expect(normalizeContractSort('../../etc')).toBe('value-desc');
    expect(normalizeContractSort('__proto__')).toBe('value-desc');
    expect(normalizeContractSort('toString')).toBe('value-desc');
  });
});

const contractRow = {
  id: 'c:1',
  subject: 'Subject',
  unp: 'UNP-1',
  cpv_code: '45000000',
  eu_funded: 0,
  authority_id: 'auth:123456789',
  authority_name: 'Authority',
  bidder_id: 'eik:111111111',
  bidder_name: 'Bidder',
  bidder_kind: 'company' as const,
  procedure_type: 'Открита процедура',
  signed_at: '2024-01-01',
  bids_received: 3,
  amount_eur: 1000,
  sort_value: 1000,
};

function fakeDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: (sql.includes('1=0') ? [] : [contractRow]) as T[] };
        },
        async first<T>() {
          const total = sql.includes('1=0') ? 0 : 1;
          return { total, eur: total ? 1000 : 0, suspect: 0 } as T;
        },
      };
    },
  } as D1Database;
}

describe('listContracts', () => {
  it('returns no rows for an undecodable bidder slug', async () => {
    const page = await listContracts(fakeDb(), { bidder: 'n%', pageSize: 10 });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('falls back to the default sort instead of throwing (sort=toString)', async () => {
    await expect(
      listContracts(fakeDb(), { sort: 'toString' as never, pageSize: 10 }),
    ).resolves.toBeDefined();
  });

  it('ignores a reserved value-bucket key instead of a destructure TypeError (value=toString)', async () => {
    await expect(
      listContracts(fakeDb(), { valueBucket: 'toString', pageSize: 10 }),
    ).resolves.toBeDefined();
  });
});

describe('getContractFacets', () => {
  it('counts sectors from the same CPV division expression used by list filters', async () => {
    const seenSql: string[] = [];
    const db = {
      prepare(sql: string) {
        seenSql.push(sql);
        return {
          async all<T>() {
            if (sql.includes('facet_counts')) return { results: [] as T[] };
            if (sql.includes('substr(t.cpv_code, 1, 2)')) {
              return { results: [{ division: '45', contracts: 7 }] as T[] };
            }
            return { results: [] as T[] };
          },
        };
      },
    } as D1Database;

    const facets = await getContractFacets(db);

    expect(seenSql.some((sql) => sql.includes('JOIN tenders t ON t.id = c.tender_id'))).toBe(true);
    expect(facets.sectors.find((sector) => sector.value === '45')?.count).toBe(7);
  });

  it('folds future signed-year buckets into unknown without hiding the rows', async () => {
    const currentYear = new Date().getUTCFullYear();
    const futureYear = String(currentYear + 3);
    const db = {
      prepare(sql: string) {
        return {
          async all<T>() {
            if (sql.includes('facet_counts')) return { results: [] as T[] };
            if (sql.includes('substr(t.cpv_code, 1, 2)')) return { results: [] as T[] };
            return {
              results: [
                { key: String(currentYear), contracts: 4 },
                { key: futureYear, contracts: 1 },
                { key: 'unknown', contracts: 2 },
              ] as T[],
            };
          },
        };
      },
    } as D1Database;

    const facets = await getContractFacets(db);

    expect(facets.years.find((year) => year.value === String(currentYear))?.count).toBe(4);
    expect(facets.years.find((year) => year.value === futureYear)).toBeUndefined();
    expect(facets.years.find((year) => year.value === 'unknown')).toMatchObject({
      label: 'Неизвестна',
      count: 3,
    });
  });
});
