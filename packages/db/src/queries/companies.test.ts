import { describe, expect, it } from 'vitest';
import { MASKED_NATURAL_PERSON_LABEL } from '@sigma/shared';
import { listCompanies, streamCompaniesCsv, type CompanyListParams } from './companies';
import type { CompanyTotalsRow } from './rows';

const filteredRows: (CompanyTotalsRow & { sort_value: number })[] = [
  {
    bidder_id: 'eik:111111111',
    name: 'Филтрирана фирма',
    kind: 'company',
    ownership_kind: null,
    eik: '111111111',
    eik_valid: 1,
    settlement: 'София',
    won_eur: 1000,
    contracts: 2,
    authorities: 1,
    primary_sector: '45',
    eu_eur: 1000,
    first_date: '2024-01-01',
    last_date: '2024-01-02',
    legal_form: 'ООД',
    sort_value: 1000,
  },
];

const unfilteredRows: (CompanyTotalsRow & { sort_value: number })[] = [
  ...filteredRows,
  {
    bidder_id: 'eik:999999999',
    name: 'Нефилтрирана фирма',
    kind: 'company',
    ownership_kind: null,
    eik: '999999999',
    eik_valid: 1,
    settlement: 'Пловдив',
    won_eur: 900,
    contracts: 1,
    authorities: 1,
    primary_sector: '72',
    eu_eur: 0,
    first_date: '2023-01-01',
    last_date: '2023-01-02',
    legal_form: 'ЕООД',
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
    expect(csvEiks).toEqual(['111111111']);
  });

  it('exports fewer rows for a sector filter than for the unfiltered corpus', async () => {
    const db = fakeDb();
    const unfiltered = await streamCompaniesCsv(db, {}).text();
    const filtered = await streamCompaniesCsv(db, { sectors: ['45'] }).text();
    const countRows = (csv: string) => csv.trim().split('\n').slice(1).length;

    expect(countRows(filtered)).toBeLessThan(countRows(unfiltered));
    expect(countRows(filtered)).toBe(1);
  });
});

describe('streamCompaniesCsv masking', () => {
  // Two-row fixture: one sole trader (legal_form='ЕТ'), one legal entity ('ООД'). Both branches of
  // source() — the company_totals rollup (default) and the base-aggregation CTE (filtered) — must
  // yield the same masked output for the same row, because the per-row masking branch is keyed on
  // r.legal_form and not on which source() branch the row came from.
  const maskingRows: CompanyTotalsRow[] = [
    {
      bidder_id: 'eik:222222222',
      name: 'ЕТ Пример - Иван Иванов',
      kind: 'company',
      ownership_kind: null,
      eik: '222222222',
      eik_valid: 1,
      settlement: 'Варна',
      won_eur: 500,
      contracts: 1,
      authorities: 1,
      primary_sector: '45',
      eu_eur: 0,
      first_date: '2024-02-01',
      last_date: '2024-02-02',
      legal_form: 'ЕТ',
    },
    {
      bidder_id: 'eik:333333333',
      name: 'Пример ООД',
      kind: 'company',
      ownership_kind: null,
      eik: '333333333',
      eik_valid: 1,
      settlement: 'Бургас',
      won_eur: 700,
      contracts: 1,
      authorities: 1,
      primary_sector: '45',
      eu_eur: 0,
      first_date: '2024-02-01',
      last_date: '2024-02-02',
      legal_form: 'ООД',
    },
  ];

  function maskingDb(): D1Database {
    return {
      prepare(sql: string) {
        let bound: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            bound = args;
            return this;
          },
          async all<T>() {
            if (sql.includes('ORDER BY bidder_id')) {
              const afterId = bound.at(-2) as string;
              return {
                results: maskingRows.filter((r) => r.bidder_id > afterId) as T[],
              };
            }
            return { results: maskingRows as T[] };
          },
          async first<T>() {
            return { n: maskingRows.length } as T;
          },
        };
      },
    } as D1Database;
  }

  function parseLine(line: string | undefined): string[] {
    return (line ?? '').split(',');
  }

  it('writes MASKED_NATURAL_PERSON_LABEL + empty EIK for an ЕТ row in the rollup branch', async () => {
    const csv = await streamCompaniesCsv(maskingDb(), {}).text();
    const header = csv.trim().split('\n')[0];
    expect(header).toBe('eik,name,kind,settlement,won_eur,contracts,authorities,primary_sector');

    const [maskedEik, maskedName] = parseLine(csv.trim().split('\n')[1]);
    expect(maskedEik).toBe('');
    expect(maskedName).toBe(MASKED_NATURAL_PERSON_LABEL);
  });

  it('preserves verbatim name + populated EIK for an ООД row in the rollup branch', async () => {
    const csv = await streamCompaniesCsv(maskingDb(), {}).text();
    const [legalEik, legalName] = parseLine(csv.trim().split('\n')[2]);
    expect(legalEik).toBe('333333333');
    expect(legalName).toBe('Пример ООД');
  });

  it('keeps the other columns unchanged for both masked and legal-entity rows', async () => {
    const csv = await streamCompaniesCsv(maskingDb(), {}).text();
    const [maskedEik, maskedName, maskedKind, maskedSettlement, maskedWon, maskedContracts, maskedAuth, maskedSector] = parseLine(
      csv.trim().split('\n')[1],
    );
    const [legalEik, legalName, legalKind, legalSettlement, legalWon, legalContracts, legalAuth, legalSector] = parseLine(
      csv.trim().split('\n')[2],
    );

    expect(maskedEik).toBe('');
    expect(maskedName).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect([maskedKind, maskedSettlement, maskedWon, maskedContracts, maskedAuth, maskedSector]).toEqual([
      'company',
      'Варна',
      '500',
      '1',
      '1',
      '45',
    ]);
    expect([legalEik, legalName, legalKind, legalSettlement, legalWon, legalContracts, legalAuth, legalSector]).toEqual([
      '333333333',
      'Пример ООД',
      'company',
      'Бургас',
      '700',
      '1',
      '1',
      '45',
    ]);
  });

  it('masks rows whose legal_form is ЕТ regardless of which source() branch they came from (base-aggregation path)', async () => {
    // A sector filter forces the base-aggregation CTE branch; the rollup subquery is bypassed.
    // The ЕТ row must still be masked, because the per-row loop consults isNaturalPersonBidder
    // against r.legal_form (which both source() branches now project).
    const csv = await streamCompaniesCsv(maskingDb(), { sectors: ['45'] }).text();
    const [maskedEik, maskedName] = parseLine(csv.trim().split('\n')[1]);
    expect(maskedEik).toBe('');
    expect(maskedName).toBe(MASKED_NATURAL_PERSON_LABEL);
  });

  it('preserves verbatim name + populated EIK for an ООД row in the base-aggregation path', async () => {
    // Symmetric counterpart of the previous test: the same sector filter still routes through the
    // base-aggregation CTE branch, but the ООД row must pass through unchanged. Masking only fires
    // for rows whose legal_form flags them as a natural person — ООД is not one of those forms.
    // This guards against a regression that breaks the ООД path of the base-aggregation branch
    // (e.g. dropping the `b.legal_form AS legal_form` projection would still mask on name heuristic).
    const csv = await streamCompaniesCsv(maskingDb(), { sectors: ['45'] }).text();
    const [legalEik, legalName] = parseLine(csv.trim().split('\n')[2]);
    expect(legalEik).toBe('333333333');
    expect(legalName).toBe('Пример ООД');
  });

  it('keeps the trailing columns (kind, settlement, won_eur, contracts, authorities, primary_sector) unchanged for the base-aggregation path', async () => {
    // Same sector-filter setup as the previous two tests; we re-assert the full eight-column shape
    // for the ООД row to pin down that the masking branch is the ONLY per-row divergence — every
    // other cell must be the source-of-truth value passed through csvCell unchanged.
    const csv = await streamCompaniesCsv(maskingDb(), { sectors: ['45'] }).text();
    const [, , kind, settlement, wonEur, contracts, authorities, primarySector] = parseLine(
      csv.trim().split('\n')[2],
    );
    expect([kind, settlement, wonEur, contracts, authorities, primarySector]).toEqual([
      'company',
      'Бургас',
      '700',
      '1',
      '1',
      '45',
    ]);
  });

  it('emits the same header row in the base-aggregation path as in the rollup path', async () => {
    // The header is built once at stream start from the fixed `cols` array; it must not differ when
    // source() returns the base-aggregation CTE instead of the company_totals rollup subquery.
    const csv = await streamCompaniesCsv(maskingDb(), { sectors: ['45'] }).text();
    const header = csv.trim().split('\n')[0];
    expect(header).toBe('eik,name,kind,settlement,won_eur,contracts,authorities,primary_sector');
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
