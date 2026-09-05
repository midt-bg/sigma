import { describe, expect, it } from 'vitest';
import { MASKED_NATURAL_PERSON_LABEL } from '@sigma/shared';
import { fakeD1, type FakeD1 } from '@sigma/test-support';
import {
  contractsSummary,
  getContractFacets,
  listContracts,
  listSingleOfferContracts,
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
  authority_id: 'auth:123456786',
  authority_name: 'Authority',
  bidder_id: 'eik:111111113',
  bidder_name: 'Bidder',
  bidder_kind: 'company' as const,
  bidder_legal_form: 'ООД',
  procedure_type: 'Открита процедура',
  signed_at: '2024-01-01',
  bids_received: 3,
  amount_eur: 1000,
  sort_value: 1000,
};

/** The list page and the COUNT/SUM aggregate that goes with it, as two separately breakable routes. */
function listDb(
  rows: object[] = [contractRow],
  summary: { total: number; eur: number; suspect: number } | null = {
    total: 1,
    eur: 1000,
    suspect: 0,
  },
): FakeD1 {
  // `1=0` is the guard the list query uses for an input it could not decode — the page it returns
  // must be empty, and the count that goes with it zero. Its routes come first so the guard wins.
  return fakeD1([
    { when: '1=0', all: [] },
    { when: '1=0', first: { total: 0, eur: 0, suspect: 0 } },
    { when: 'COUNT(*) AS total', first: summary },
    { when: 'FROM contracts c', all: rows },
  ]);
}

function fakeDb(): D1Database {
  return listDb().db;
}

// The three facet reads: the precomputed rollup, the CPV-division count, and the signed-year buckets.
const FACET_ROLLUP = 'FROM facet_counts';
const FACET_SECTORS = 'substr(t.cpv_code, 1, 2)';
const FACET_YEARS = 'GROUP BY key';

/** The three facet reads, each answerable — and therefore breakable — on its own. */
function facetDb(parts: { rollup?: unknown[]; sectors?: unknown[]; years?: unknown[] }): FakeD1 {
  return fakeD1([
    { when: FACET_ROLLUP, all: parts.rollup ?? [] },
    { when: FACET_SECTORS, all: parts.sectors ?? [] },
    { when: FACET_YEARS, all: parts.years ?? [] },
  ]);
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

  it('accepts a caller-supplied summary override without a COUNT/SUM scan', async () => {
    // No aggregate route at all: with an override the COUNT/SUM scan must never run, so a double
    // that throws on it asserts the skip more directly than counting first() calls would.
    const fake = fakeD1([{ when: 'FROM contracts c', all: [contractRow] }]);
    const page = await listContracts(
      fake.db,
      { pageSize: 10 },
      { total: 42, valueEur: 999, suspect: 3 },
    );
    expect(page.total).toBe(42);
    expect(page.valueEur).toBe(999);
    expect(page.suspect).toBe(3);
    expect(fake.sql.every((sql) => !sql.includes('COUNT(*) AS total'))).toBe(true);
  });

  it('slices to pageSize and emits a next cursor when the page overflows', async () => {
    const rows = [
      { ...contractRow, id: 'c:1', sort_value: 200 },
      { ...contractRow, id: 'c:2', sort_value: 100 },
    ];
    const db = listDb(rows, { total: 2, eur: 2000, suspect: 0 }).db;
    const page = await listContracts(db, { pageSize: 1 });
    expect(page.items).toHaveLength(1); // overflow row dropped
    expect(page.nextCursor).toBeTruthy();
  });
});

// A SQL-recording double over the standard list rows — for asserting which predicates buildFilters
// emits. `listDb()` already records every statement, so the spy is just its FakeD1 handle.
const spyDb = (): FakeD1 => listDb();

describe('buildFilters (via listContracts)', () => {
  it('emits every filter predicate for a fully-specified query', async () => {
    const { db, sql } = spyDb();
    await listContracts(db, {
      years: ['2024', 'unknown'], // real years OR the unknown-date complement
      sectors: ['45'],
      procedureGroups: ['open'],
      valueBucket: '100k-1m', // bounded → two-sided predicate
      eu: 'eu',
      bids: 'one',
      authority: '123456789',
      bidder: '111111111', // a bare ЕИК decodes to eik:…
      q: 'ремонт',
      pageSize: 10,
    });
    const page = sql.find((s) => s.includes('sort_value'))!;
    expect(page).toContain('substr(c.signed_at, 1, 4) IN'); // real year
    expect(page).toContain('c.signed_at IS NULL OR NOT'); // unknown-date complement
    expect(page).toContain('substr(t.cpv_code, 1, 2) IN'); // sector
    expect(page).toContain('t.procedure_type IN'); // procedure group expanded to types
    expect(page).toContain('c.amount_eur >= ? AND c.amount_eur < ?'); // bounded value bucket
    expect(page).toContain('c.eu_funded = 1'); // EU
    expect(page).toContain('c.bids_received = 1'); // single-offer
    expect(page).toContain('t.authority_id = ?'); // authority
    expect(page).toContain('c.bidder_id = ?'); // decoded bidder
    expect(page).toContain('search_index MATCH'); // full-text
  });

  it('emits an open-ended predicate for the top value bucket and the national EU predicate', async () => {
    const { db, sql } = spyDb();
    await listContracts(db, { valueBucket: 'gt100m', eu: 'national', pageSize: 10 });
    const page = sql.find((s) => s.includes('sort_value'))!;
    expect(page).toContain('c.amount_eur >= ?');
    expect(page).not.toContain('c.amount_eur < ?'); // no upper bound
    expect(page).toContain('c.eu_funded IS NULL OR c.eu_funded = 0');
  });

  it('drops a procedure group with no mapped types without emitting an IN ()', async () => {
    const { db, sql } = spyDb();
    await listContracts(db, { procedureGroups: ['not-a-real-group'], pageSize: 10 });
    expect(sql.every((s) => !s.includes('t.procedure_type IN'))).toBe(true);
  });

  it('produces a WHERE-less query when no filters are set', async () => {
    const { db, sql } = spyDb();
    await listContracts(db, { pageSize: 10 });
    // The page query still has a keyset ORDER BY, but no filter WHERE fragment.
    const page = sql.find((s) => s.includes('sort_value'))!;
    expect(page).not.toContain('substr(t.cpv_code');
  });

  it('filters to the unknown-date bucket alone (no real-year clause)', async () => {
    const { db, sql } = spyDb();
    await listContracts(db, { years: ['unknown'], pageSize: 10 });
    const page = sql.find((s) => s.includes('sort_value'))!;
    expect(page).toContain('c.signed_at IS NULL OR NOT');
    expect(page).not.toContain('substr(c.signed_at, 1, 4) IN'); // realYears empty → no IN clause
  });

  it('maps a CPV-less row to a null sector and defaults the page size', async () => {
    const db = listDb([{ ...contractRow, cpv_code: null }]).db;
    const page = await listContracts(db, {}); // no pageSize → default of 15
    expect(page.items[0]!.sectorCode).toBeNull(); // r.cpv_code ? … : null
  });

  it('emits a backward page in reversed fetch order (before-cursor → reverse)', async () => {
    // 3 rows, pageSize 2 → a full page so the reverse is observable (pageSize 1 would hide it).
    const rows = [
      { ...contractRow, id: 'c:1', sort_value: 300 },
      { ...contractRow, id: 'c:2', sort_value: 200 },
      { ...contractRow, id: 'c:3', sort_value: 100 },
    ];
    const db = listDb(rows, { total: 3, eur: 1000, suspect: 0 }).db;
    const fwd = await listContracts(db, { pageSize: 2 });
    const mid = await listContracts(db, { pageSize: 2, cursor: fwd.nextCursor! });
    expect(mid.prevCursor).toBeTruthy();
    const back = await listContracts(db, { pageSize: 2, cursor: mid.prevCursor! });
    expect(back.items.map((i) => i.id)).toEqual([...fwd.items].reverse().map((i) => i.id));
    expect(back.items).toHaveLength(2);
  });
});

describe('contractsSummary', () => {
  it('returns zeroed totals when the aggregate row is missing', async () => {
    const db = fakeD1([{ when: 'COUNT(*) AS total', first: null }]).db; // no aggregate row
    const summary = await contractsSummary(db, {});
    expect(summary).toEqual({ total: 0, valueEur: 0, suspect: 0 });
  });
});

describe('listSingleOfferContracts', () => {
  it('orders by value in value mode and by date in recent mode', async () => {
    const capture = (): FakeD1 => fakeD1([{ when: 'FROM contracts c', all: [contractRow] }]);
    const v = capture();
    const items = await listSingleOfferContracts(v.db, 'value', 5);
    expect(items).toHaveLength(1);
    expect(v.sql[0]).toContain('ORDER BY c.amount_eur DESC');
    expect(v.sql[0]).toContain('LIMIT ?');
    expect(v.calls[0]!.binds).toEqual([5]); // the explicit limit reaches the LIMIT placeholder

    const r = capture();
    await listSingleOfferContracts(r.db, 'recent');
    expect(r.sql[0]).toContain('ORDER BY COALESCE(c.signed_at, c.published_at) DESC');
    expect(r.calls[0]!.binds).toEqual([10]); // default limit
  });
});

describe('getContractFacets — procedure folding and EU counts', () => {
  it('folds procedure facet rows into config groups, sorts sectors, and splits EU counts', async () => {
    const db = facetDb({
      rollup: [
        { facet: 'procedure', key: 'Открита процедура', contracts: 5 }, // → 'open'
        { facet: 'eu', key: '1', contracts: 8 },
        { facet: 'eu', key: '0', contracts: 2 },
      ],
      sectors: [
        { division: '45', contracts: 3 }, // out of order → must be resorted below
        { division: '72', contracts: 9 },
      ],
    }).db;
    const facets = await getContractFacets(db);
    expect(facets.procedures.find((p) => p.value === 'open')?.count).toBe(5);
    expect(facets.sectors.map((s) => s.value)).toEqual(['72', '45']); // 9 before 3
    expect(facets.eu).toEqual({ all: 10, eu: 8, national: 2 });
  });

  it('sorts real years newest-first and sinks the unknown bucket to the end', async () => {
    const db = facetDb({
      years: [
        { key: '2022', contracts: 1 },
        { key: '2024', contracts: 2 },
        { key: 'unknown', contracts: 3 },
      ],
    }).db;
    const facets = await getContractFacets(db);
    // localeCompare orders the real years descending; both `a === unknown` and `b === unknown`
    // comparator arms fire to push the unknown bucket last.
    expect(facets.years.map((y) => y.value)).toEqual(['2024', '2022', 'unknown']);
  });
});

describe('streamContractsCsv', () => {
  /** The keyset walk pulls a chunk at a time; each call serves the next page, then nothing. */
  function csvDb(pages: Record<string, unknown>[][]): FakeD1 {
    let call = 0;
    return fakeD1([{ when: 'FROM contracts c', all: () => pages[call++] ?? [] }]);
  }

  const csvRow = {
    ...contractRow,
    rowid: 1,
    authority_eik: '123456789',
    contractor_eik: '111111111',
  };

  it('streams a BOM header then one CSV row per contract with the raw (unescaped) id', async () => {
    const bytes = new Uint8Array(
      await streamContractsCsv(csvDb([[csvRow], []]).db, {}).arrayBuffer(),
    );
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const csv = new TextDecoder().decode(bytes);
    expect(csv.split('\n')[0]).toBe(
      'id,unp,subject,authority,authority_eik,contractor,contractor_eik,kind,sector_code,procedure,signed_at,value_eur,eu_funded,bids_received',
    );
    expect(csv).toContain('UNP-1');
    expect(csv).toContain('123456789'); // authority_eik column
  });

  it('emits only the header when the filtered set is empty', async () => {
    const csv = await streamContractsCsv(csvDb([[]]).db, { authority: '999999999' }).text();
    expect(csv.split('\n').filter(Boolean)).toHaveLength(1); // header row only
  });

  it('renders a blank sector cell and eu flag „1" for a CPV-less EU-funded row', async () => {
    const row = { ...csvRow, cpv_code: null, eu_funded: 1, amount_eur: 1000, bids_received: 3 };
    const csv = await streamContractsCsv(csvDb([[row], []]).db, {}).text();
    // trailing columns: …,value_eur,eu_funded,bids_received → 1000,1,3 (eu_funded === 1 → '1')
    expect(csv).toContain(',1000,1,3');
  });

  it('folds the filter WHERE into the keyset walk and continues past a full chunk', async () => {
    const CHUNK = 1000;
    const first = Array.from({ length: CHUNK }, (_, i) => ({
      ...csvRow,
      id: `c:${i}`,
      rowid: i + 1,
    }));
    const fake = csvDb([first, []]);
    const csv = await streamContractsCsv(fake.db, { eu: 'eu' }).text();
    expect(csv.match(/\n/g)!).toHaveLength(CHUNK + 1); // header + CHUNK rows
    expect(fake.sql.some((s) => s.includes('c.eu_funded = 1 AND c.rowid > ?'))).toBe(true);
    expect(fake.sql).toHaveLength(2); // === CHUNK page did not close; a second pull ran
  });
});

describe('getContractFacets — sector, year and authority facets', () => {
  it('counts sectors from the same CPV division expression used by list filters', async () => {
    const fake = facetDb({ sectors: [{ division: '45', contracts: 7 }] });
    const db = fake.db;
    const facets = await getContractFacets(db);

    expect(fake.sql.some((sql) => sql.includes('JOIN tenders t ON t.id = c.tender_id'))).toBe(true);
    expect(facets.sectors.find((sector) => sector.value === '45')?.count).toBe(7);
  });

  it('folds future signed-year buckets into unknown without hiding the rows', async () => {
    const currentYear = new Date().getUTCFullYear();
    const futureYear = String(currentYear + 3);
    const db = facetDb({
      years: [
        { key: String(currentYear), contracts: 4 },
        { key: futureYear, contracts: 1 },
        { key: 'unknown', contracts: 2 },
      ],
    }).db;
    const facets = await getContractFacets(db);

    expect(facets.years.find((year) => year.value === String(currentYear))?.count).toBe(4);
    expect(facets.years.find((year) => year.value === futureYear)).toBeUndefined();
    expect(facets.years.find((year) => year.value === 'unknown')).toMatchObject({
      label: 'Неизвестна',
      count: 3,
    });
  });

  it('always sinks the „Неизвестна" bucket below real years, whatever the row order', async () => {
    // Multiple buckets with „unknown" NOT last force the comparator to evaluate `a.key === YEAR_UNKNOWN`
    // (its first arm) as well as the `b` arm — real years descend, unknown always sorts to the bottom.
    const db = facetDb({
      years: [
        { key: '2020', contracts: 1 },
        { key: 'unknown', contracts: 2 },
        { key: '2024', contracts: 3 },
        { key: '2022', contracts: 4 },
      ],
    }).db;
    const facets = await getContractFacets(db);
    const values = facets.years.map((y) => y.value);
    expect(values[values.length - 1]).toBe('unknown'); // unknown always last
    expect(values.slice(0, -1)).toEqual(['2024', '2022', '2020']); // real years descend
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

  // Regression for PR #183 review T-006: `isNaturalPersonBidder`'s docstring delegates consortium
  // filtering to the caller, but `streamContractsCsv` invoked it WITHOUT a `bidder_kind ===
  // 'consortium'` guard. A consortium whose `bidder_name` starts with „ЕТ " (a lead member that is a
  // sole trader, e.g. „ЕТ Иван Петров; Строй ООД") or whose `legal_form` collides with a sole-trader
  // form was masked as a natural person — privacy-safe (over-masking) but a behavioral change that
  // drops the lead member's name + ЕИК and contradicts the predicate's contract. Consortium rows now
  // bypass the natural-person mask and keep the „… и др." shape from `entityName`.
  it('does not mask a consortium row whose lead member looks like a sole trader (ЕТ name / sole-trader legal_form)', async () => {
    const db = csvDb([
      makeCsvRow({
        id: 'c:et-led-consortium',
        rowid: 1,
        bidder_name: 'ЕТ Иван Петров; Строй ООД',
        bidder_kind: 'consortium',
        bidder_legal_form: 'ЕТ',
        contractor_eik: '201345678',
      }),
    ]);

    const rows = parseCsv(await streamContractsCsv(db, {}).text());

    expect(rows[1]![5]).toBe('ЕТ Иван Петров и др.');
    expect(rows[1]![6]).toBe('201345678');
    expect(rows[1]![7]).toBe('consortium');
  });

  it('does not mask a consortium row matched only by the leading-ЕТ name heuristic (legal_form null)', async () => {
    const db = csvDb([
      makeCsvRow({
        id: 'c:et-named-consortium',
        rowid: 1,
        bidder_name: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ; Логистика АД',
        bidder_kind: 'consortium',
        bidder_legal_form: null,
        contractor_eik: '201345678',
      }),
    ]);

    const rows = parseCsv(await streamContractsCsv(db, {}).text());

    expect(rows[1]![5]).toBe('ЕТ ДРИФТ - НИКОЛАЙ КИРОВ и др.');
    expect(rows[1]![6]).toBe('201345678');
    expect(rows[1]![7]).toBe('consortium');
  });
});

describe('listContracts — privacy masking on the leaderboard list (PR #183 review #1)', () => {
  // Sole traders must read "Частно лице" on /contracts + /contracts.data (RRv7 single-fetch twin)
  // and on the home single-offer tables. The CSV streamer masks the same row upstream of bytes
  // hitting R2; maskContractForPrivacy covers /contracts/:id.json. The list path is the third
  // surface.
  const soleTraderRow = {
    id: 'c:et-1',
    subject: 'S',
    unp: 'UNP-et',
    cpv_code: '45000000',
    eu_funded: 0,
    authority_id: 'auth:1',
    authority_name: 'Authority',
    bidder_id: 'eik:121817309',
    bidder_name: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
    bidder_kind: 'company' as const,
    bidder_legal_form: 'ЕТ',
    procedure_type: 'Открита процедура',
    signed_at: '2024-01-01',
    bids_received: 3,
    amount_eur: 1000,
    sort_value: 1000,
  };
  const legalEntityRow = { ...contractRow };
  const consortiumRow = {
    ...contractRow,
    bidder_name: 'ЕТ Иван Петров; Строй ООД',
    bidder_kind: 'consortium' as const,
    bidder_legal_form: null,
  };

  function dbFor(row: object | object[]): D1Database {
    const rows = Array.isArray(row) ? row : [row];
    return {
      prepare(_sql: string) {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: rows as T[] };
          },
          async first<T>() {
            return { total: rows.length, eur: rows.length ? 1000 : 0, suspect: 0 } as T;
          },
        };
      },
    } as D1Database;
  }

  it('masks bidderName + bidderDisplayName for a sole trader (ЕТ, legal_form=ЕТ)', async () => {
    const page = await listContracts(dbFor(soleTraderRow), { pageSize: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.bidderName).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(page.items[0]!.bidderDisplayName).toBe(MASKED_NATURAL_PERSON_LABEL);
  });

  it('preserves the legal-entity name verbatim', async () => {
    const page = await listContracts(dbFor(legalEntityRow), { pageSize: 10 });
    expect(page.items[0]!.bidderName).toBe('Bidder');
    expect(page.items[0]!.bidderDisplayName).toBe('Bidder');
  });

  it('does NOT mask a consortium whose first member is a sole trader (MAJOR-class guard)', async () => {
    const page = await listContracts(dbFor(consortiumRow), { pageSize: 10 });
    expect(page.items[0]!.bidderName).toBe('ЕТ Иван Петров; Строй ООД');
    expect(page.items[0]!.bidderKind).toBe('consortium');
    expect(page.items[0]!.isConsortium).toBe(true);
  });

  it('replaces bidderSlug with the opaque `m<base64(bidder_id)>` token for a sole trader (lyubomir-bozhinov review 2026-09-02, thread on rows.ts:86)', async () => {
    // The `bidderSlug` is the second half of the masking: `companySlug('eik:<digits>')` returns the
    // ЕИК digits verbatim, so a masked eik-keyed row's slug would still carry the natural-person's
    // ЕИК into the `/contracts.data` machine-readable twin (RRv7 single-fetch turbo-stream) and the
    // HTML hydration payload of the public home single-offer tables — defeating the label mask.
    // `maskedCompanySlug(bidder_id)` is a one-way token: opaque, non-round-trippable via
    // `bidderIdFromSlug`, and stable across rebuilds (depends only on the bidder id). The mapper
    // wires it in here so /contracts.data + the home single-offer tables share the same invariant as
    // the leaderboard (`rows.ts:86`) and the home top-10 (`9308672`).
    const { bidderIdFromSlug } = await import('./identity');
    const page = await listContracts(dbFor(soleTraderRow), { pageSize: 10 });
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    // Masked flag surfaces the privacy signal for downstream consumers (home.tsx, contracts.tsx
    // branches on `c.masked` to choose <span> vs <Link>). The flag is the single source-of-truth —
    // not a string compare on MASKED_NATURAL_PERSON_LABEL.
    expect(item.masked).toBe(true);
    // Slug is opaque: not round-trippable, no bare ЕИК.
    expect(item.bidderSlug.startsWith('m')).toBe(true);
    expect(bidderIdFromSlug(item.bidderSlug)).toBeNull();
    expect(item.bidderSlug).not.toContain('121817309');
    expect(item.bidderSlug).not.toMatch(/^\d{9}(\d{4})?$/);
  });

  it('keeps bidderSlug as the bare ЕИК for a legal entity (round-trippable, by design)', async () => {
    // The legal-entity branch is untouched: it returns `companySlug(r.bidder_id)` and the slug
    // is the bare ЕИК so `bidderIdFromSlug(slug)` round-trips. Consumers rely on this for
    // navigation — masked rows are the only ones that get the opaque form.
    const { bidderIdFromSlug } = await import('./identity');
    const page = await listContracts(dbFor(legalEntityRow), { pageSize: 10 });
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.masked).toBe(false);
    expect(item.bidderSlug).toBe('111111113');
    expect(bidderIdFromSlug(item.bidderSlug)).toBe('eik:111111113');
  });

  it('keeps bidderSlug as the bare ЕИК for a consortium (round-trippable, by design)', async () => {
    // The consortium branch is also untouched — masking it would lose the „… и др." shape and the
    // consortium ЕИК. The guard `bidder_kind !== 'consortium'` in `toItem` keeps this branch
    // verbatim, even when the consortium lead member's name looks like a sole trader.
    const { bidderIdFromSlug } = await import('./identity');
    const page = await listContracts(dbFor(consortiumRow), { pageSize: 10 });
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.masked).toBe(false);
    expect(item.bidderSlug).toBe('111111113');
    expect(bidderIdFromSlug(item.bidderSlug)).toBe('eik:111111113');
  });
});
