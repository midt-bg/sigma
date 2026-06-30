import { describe, expect, it } from 'vitest';
import { MASKED_NATURAL_PERSON_LABEL } from '@sigma/shared';
import {
  getContractFacets,
  listContracts,
  normalizeContractSort,
  streamContractsCsv,
} from './contracts';

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

/**
 * Privacy-masking surface for the CSV export — see ADR-0002 in `docs/architecture.md`.
 * Each row of the export carries the bidder's `legal_form` so the streamer can decide whether
 * to mask `contractor` and `contractor_eik`. The shared `isNaturalPersonBidder` predicate is the
 * single source of truth; these tests pin the CSV-side behaviour.
 */
describe('streamContractsCsv masking', () => {
  function makeCsvRow(overrides: Record<string, unknown>) {
    return {
      id: 'c:1',
      rowid: 1,
      subject: 'Subject',
      unp: 'UNP-1',
      cpv_code: '45000000',
      eu_funded: 0,
      authority_id: 'auth:123456789',
      authority_name: 'Authority',
      authority_eik: '123456789',
      bidder_id: 'eik:111111111',
      bidder_name: 'Bidder',
      bidder_kind: 'company' as const,
      contractor_eik: '111111111',
      bidder_legal_form: 'ООД',
      procedure_type: 'Открита процедура',
      signed_at: '2024-01-01',
      bids_received: 3,
      amount_eur: 1000,
      ...overrides,
    };
  }

  function csvDb(rows: Record<string, unknown>[]): D1Database {
    return {
      prepare() {
        let calls = 0;
        return {
          bind() {
            return this;
          },
          async all<T>() {
            // First chunk returns the seeded rows (≤ CHUNK so the streamer closes after it).
            // Any subsequent pull is answered with an empty array so the stream ends cleanly.
            calls += 1;
            return { results: (calls === 1 ? rows : []) as T[] };
          },
          async first<T>() {
            return { total: rows.length, eur: 0, suspect: 0 } as T;
          },
        };
      },
    } as unknown as D1Database;
  }

  function parseCsv(text: string): string[][] {
    return text
      .replace(/^﻿/, '')
      .trim()
      .split('\n')
      .map((line) => line.split(','));
  }

  it('masks the contractor and clears contractor_eik when legal_form is a sole-trader form (ЕТ)', async () => {
    const db = csvDb([
      makeCsvRow({
        id: 'c:natural',
        rowid: 1,
        bidder_name: 'ЕТ НИКОЛАЙ КИРОВ',
        bidder_kind: 'company',
        bidder_legal_form: 'ЕТ',
        contractor_eik: '176011111',
      }),
      makeCsvRow({
        id: 'c:legal',
        rowid: 2,
        bidder_name: 'СОФАРМА ТРЕЙДИНГ',
        bidder_kind: 'company',
        bidder_legal_form: 'ООД',
        contractor_eik: '121817309',
      }),
    ]);

    const rows = parseCsv(await streamContractsCsv(db, {}).text());

    // The header carries the documented column order — kept as the contract the CSV consumer sees.
    expect(rows[0]).toEqual([
      'id',
      'unp',
      'subject',
      'authority',
      'authority_eik',
      'contractor',
      'contractor_eik',
      'kind',
      'sector_code',
      'procedure',
      'signed_at',
      'value_eur',
      'eu_funded',
      'bids_received',
    ]);

    const naturalRow = rows[1]!;
    expect(naturalRow[0]).toBe('natural'); // contractSlug strips the leading "c:"
    expect(naturalRow[5]).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(naturalRow[6]).toBe('');

    const legalRow = rows[2]!;
    expect(legalRow[0]).toBe('legal');
    expect(legalRow[5]).toBe('СОФАРМА ТРЕЙДИНГ');
    expect(legalRow[6]).toBe('121817309');
  });

  it('keeps every other column verbatim for both masked and unmasked rows', async () => {
    const db = csvDb([
      makeCsvRow({
        id: 'c:natural',
        rowid: 1,
        bidder_name: 'ЕТ НИКОЛАЙ КИРОВ',
        bidder_kind: 'company',
        bidder_legal_form: 'ЕТ',
        contractor_eik: '176011111',
        unp: 'UNP-NAT',
        subject: 'Natural subject',
      }),
      makeCsvRow({
        id: 'c:legal',
        rowid: 2,
        bidder_name: 'СОФАРМА ТРЕЙДИНГ',
        bidder_kind: 'company',
        bidder_legal_form: 'ООД',
        contractor_eik: '121817309',
        unp: 'UNP-LEG',
        subject: 'Legal subject',
      }),
    ]);

    const rows = parseCsv(await streamContractsCsv(db, {}).text());

    // Skip the masked columns (5 = contractor, 6 = contractor_eik). Every other column must be the
    // raw seeded value for both rows.
    const header = rows[0]!;
    const otherColumns = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13];
    for (const row of rows.slice(1)) {
      for (const col of otherColumns) {
        expect(row[col]!, `row "${row[0]}" column "${header[col]!}" must be defined`).toBeDefined();
      }
    }

    const naturalRow = rows.find((r) => r[0] === 'natural')!;
    expect(naturalRow[1]).toBe('UNP-NAT');
    expect(naturalRow[2]).toBe('Natural subject');
    expect(naturalRow[7]).toBe('company');

    const legalRow = rows.find((r) => r[0] === 'legal')!;
    expect(legalRow[1]).toBe('UNP-LEG');
    expect(legalRow[2]).toBe('Legal subject');
    expect(legalRow[7]).toBe('company');
  });

  it('masks via the leading-ЕТ name heuristic when legal_form is null', async () => {
    const db = csvDb([
      makeCsvRow({
        id: 'c:heuristic',
        rowid: 1,
        bidder_name: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
        bidder_kind: 'company',
        bidder_legal_form: null,
        contractor_eik: '176011111',
      }),
    ]);

    const rows = parseCsv(await streamContractsCsv(db, {}).text());

    expect(rows[1]![5]).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(rows[1]![6]).toBe('');
  });

  it('preserves the kind column so downstream consumers can still distinguish companies from consortia', async () => {
    const db = csvDb([
      makeCsvRow({
        id: 'c:consortium',
        rowid: 1,
        bidder_name: 'A ООД; B ЕООД',
        bidder_kind: 'consortium',
        bidder_legal_form: 'ДЗЗД',
        contractor_eik: '999999999',
      }),
    ]);

    const rows = parseCsv(await streamContractsCsv(db, {}).text());

    // ДЗЗД + consortium: predicate returns false; `kind` still flags the consortium shape.
    expect(rows[1]![5]).toBe('A ООД и др.');
    expect(rows[1]![6]).toBe('999999999');
    expect(rows[1]![7]).toBe('consortium');
  });
});
