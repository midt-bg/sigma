import { describe, expect, it } from 'vitest';
import { listCompanies, streamCompaniesCsv, type CompanyListParams } from './companies';
import type { CompanyTotalsRow } from './rows';

const filteredRows: (CompanyTotalsRow & { sort_value: number })[] = [
  {
    bidder_id: 'eik:111111113',
    name: 'Филтрирана фирма',
    kind: 'company',
    ownership_kind: null,
    eik: '111111113',
    eik_valid: 1,
    settlement: 'София',
    won_eur: 1000,
    contracts: 2,
    authorities: 1,
    primary_sector: '45',
    eu_eur: 1000,
    first_date: '2024-01-01',
    last_date: '2024-01-02',
    sort_value: 1000,
  },
];

const unfilteredRows: (CompanyTotalsRow & { sort_value: number })[] = [
  ...filteredRows,
  {
    bidder_id: 'eik:999999995',
    name: 'Нефилтрирана фирма',
    kind: 'company',
    ownership_kind: null,
    eik: '999999995',
    eik_valid: 1,
    settlement: 'Пловдив',
    won_eur: 900,
    contracts: 1,
    authorities: 1,
    primary_sector: '72',
    eu_eur: 0,
    first_date: '2023-01-01',
    last_date: '2023-01-02',
    sort_value: 900,
  },
];

function usesFilteredCompanySource(sql: string): boolean {
  return sql.includes('FROM (') && sql.includes('substr(t.cpv_code, 1, 2)');
}

function fakeDb(): D1Database {
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        async all<T>() {
          const rows = usesFilteredCompanySource(sql) ? filteredRows : unfilteredRows;
          if (sql.includes('ORDER BY bidder_id')) {
            const afterId = bound.at(-2) as string;
            return { results: rows.filter((r) => r.bidder_id > afterId) as T[] };
          }
          return { results: rows as T[] };
        },
        async first<T>() {
          return {
            n: usesFilteredCompanySource(sql) ? filteredRows.length : unfilteredRows.length,
          } as T;
        },
      };
    },
  } as D1Database;
}

describe('streamCompaniesCsv', () => {
  it('exports the same row set as the list for filtered queries', async () => {
    const params: CompanyListParams = {
      sectors: ['45'],
      years: ['2024'],
      eu: 'eu',
      pageSize: 10,
    };
    const db = fakeDb();

    const list = await listCompanies(db, params);
    const csv = await streamCompaniesCsv(db, params).text();
    const csvEiks = csv
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.split(',')[0]);

    expect(csvEiks).toEqual(list.items.map((item) => item.eik));
    expect(csvEiks).toEqual(['111111113']);
  });

  it('exports fewer rows for a sector filter than for the unfiltered corpus', async () => {
    const db = fakeDb();
    const unfiltered = await streamCompaniesCsv(db, {}).text();
    const filtered = await streamCompaniesCsv(db, { sectors: ['45'] }).text();
    const countRows = (csv: string) => csv.trim().split('\n').slice(1).length;

    expect(countRows(filtered)).toBeLessThan(countRows(unfiltered));
    expect(countRows(filtered)).toBe(1);
  });

  it('excludes the unknown identity bucket from the list and CSV', async () => {
    const db = fakeDb();
    const sql: string[] = [];
    const real = db.prepare.bind(db);
    db.prepare = ((query: string) => {
      sql.push(query);
      return real(query);
    }) as typeof db.prepare;

    await listCompanies(db, {});
    await streamCompaniesCsv(db, {}).text();

    expect(sql.filter((query) => query.includes('company_totals'))).not.toHaveLength(0);
    expect(
      sql.filter((query) => query.includes('company_totals')).every((query) =>
        query.includes("kind <> 'unknown'"),
      ),
    ).toBe(true);
  });
});

describe('prototype-key params (untrusted query values)', () => {
  function spyDb(): { db: D1Database; sql: string[] } {
    const db = fakeDb();
    const sql: string[] = [];
    const real = db.prepare.bind(db);
    db.prepare = ((q: string) => {
      sql.push(q);
      return real(q);
    }) as typeof db.prepare;
    return { db, sql };
  }

  it('falls back to the default sort instead of throwing (sort=toString)', async () => {
    await expect(listCompanies(fakeDb(), { sort: 'toString' as never })).resolves.toBeDefined();
  });

  it('does not inject a reserved count-bucket key into the WHERE (count=__proto__)', async () => {
    // bug: `where.push(COUNT_BUCKETS['__proto__'])` pushes Object.prototype -> '[object Object]' in SQL,
    // which 500s the page and (because the CSV header flushes first) silently returns an empty export.
    const { db, sql } = spyDb();
    await streamCompaniesCsv(db, { countBucket: '__proto__' }).text();
    expect(sql.some((s) => s.includes('[object Object]'))).toBe(false);
  });

  it('still applies a valid count bucket (count=1)', async () => {
    const { db, sql } = spyDb();
    await streamCompaniesCsv(db, { countBucket: '1' }).text();
    expect(sql.some((s) => s.includes('contracts = 1'))).toBe(true);
  });
});
