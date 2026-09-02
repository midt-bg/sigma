import { describe, expect, it } from 'vitest';
import { fakeD1, type FakeD1, type FakeD1Call } from '@sigma/test-support';
import {
  getCompanyFacets,
  listCompanies,
  normalizeCompanySort,
  streamCompaniesCsv,
  type CompanyListParams,
} from './companies';
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

// The scoped base-aggregation CTE a sector/year/EU cross-cut switches the FROM source to, as opposed
// to the plain company_totals rollup.
const FILTERED_SOURCE = ['FROM (', 'substr(t.cpv_code, 1, 2)'];

/** Keyset page: everything after the `bidder_id` the query bound as its cursor. */
const after = (rows: (CompanyTotalsRow & { sort_value: number })[]) => (call: FakeD1Call) =>
  rows.filter((r) => r.bidder_id > String(call.binds.at(-2)));

function fakeDb(): D1Database {
  return fakeD1([
    // The CSV stream pages by bidder_id; the list query carries a sort_value column instead. Keeping
    // the two apart by their own marker means breaking either one throws rather than falling through
    // to the other and quietly returning an unpaginated page.
    { when: [...FILTERED_SOURCE, 'ORDER BY bidder_id'], all: after(filteredRows) },
    { when: [...FILTERED_SOURCE, 'AS sort_value'], all: filteredRows },
    { when: FILTERED_SOURCE, first: { n: filteredRows.length } },
    { when: ['FROM company_totals', 'ORDER BY bidder_id'], all: after(unfilteredRows) },
    { when: ['FROM company_totals', 'AS sort_value'], all: unfilteredRows },
    { when: 'FROM company_totals', first: { n: unfilteredRows.length } },
  ]).db;
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
      sql
        .filter((query) => query.includes('company_totals'))
        .every((query) => query.includes("kind <> 'unknown'")),
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

// A SQL-recording fake that answers either source with one company row — for asserting *which*
// predicates the source/entity-where builders emit, independent of the row-filtering fakeDb above.
function capDb(): FakeD1 {
  return fakeD1([
    { when: 'FROM (', all: [filteredRows[0]!] },
    { when: 'FROM company_totals', all: [filteredRows[0]!] },
    { when: 'COUNT(*)', first: { n: 1 } },
  ]);
}

describe('listCompanies — backward pagination', () => {
  it('emits a backward page in reversed fetch order (before-cursor → reverse)', async () => {
    // 3 rows, pageSize 2 → a full page so the reverse is observable (pageSize 1 would hide it).
    const rows = [
      { ...filteredRows[0]!, bidder_id: 'eik:1', sort_value: 300 },
      { ...filteredRows[0]!, bidder_id: 'eik:2', sort_value: 200 },
      { ...filteredRows[0]!, bidder_id: 'eik:3', sort_value: 100 },
    ];
    const db = fakeD1([
      { when: 'FROM (', all: rows },
      { when: 'FROM company_totals', all: rows },
      { when: 'COUNT(*)', first: { n: 3 } },
    ]).db;
    const fwd = await listCompanies(db, { pageSize: 2 });
    const mid = await listCompanies(db, { pageSize: 2, cursor: fwd.nextCursor! });
    expect(mid.prevCursor).toBeTruthy();
    const back = await listCompanies(db, { pageSize: 2, cursor: mid.prevCursor! });
    expect(back.items.map((i) => i.slug)).toEqual([...fwd.items].reverse().map((i) => i.slug));
    expect(back.items).toHaveLength(2);
  });
});

describe('normalizeCompanySort', () => {
  it('passes through known keys and collapses everything else to „won"', () => {
    expect(normalizeCompanySort('count')).toBe('count');
    expect(normalizeCompanySort('authorities')).toBe('authorities');
    expect(normalizeCompanySort('name')).toBe('name');
    expect(normalizeCompanySort('won')).toBe('won');
    expect(normalizeCompanySort('bogus')).toBe('won'); // unknown → default
    expect(normalizeCompanySort(null)).toBe('won');
    expect(normalizeCompanySort(undefined)).toBe('won');
    expect(normalizeCompanySort('toString')).toBe('won'); // prototype key is not a sort
  });
});

describe('listCompanies — source and entity-where branches', () => {
  it('adds year, EU, and single-sector predicates to the base aggregation', async () => {
    const { db, sql } = capDb();
    await listCompanies(db, { sectors: ['45'], years: ['2024'], eu: 'eu', pageSize: 10 });
    const base = sql.find((s) => s.includes('FROM (') && s.includes('substr(t.cpv_code, 1, 2)'))!;
    expect(base).toContain('substr(c.signed_at, 1, 4) IN');
    expect(base).toContain('c.eu_funded = 1');
    expect(base).toContain('? AS primary_sector'); // single sector → bound value
  });

  it('builds the base aggregation from a non-sector filter, omitting the CPV predicate', async () => {
    // needsBase is triggered by the year filter alone; with no sectors the `if (p.sectors?.length)`
    // else-branch runs → no CPV predicate is emitted, but the year predicate still is.
    const { db, sql } = capDb();
    await listCompanies(db, { years: ['2024'], pageSize: 10 });
    const base = sql.find((s) => s.includes('FROM ('))!;
    expect(base).toContain('substr(c.signed_at, 1, 4) IN');
    expect(base).not.toContain('substr(t.cpv_code, 1, 2) IN');
  });

  it('uses NULL primary_sector for a multi-sector filter and the national funding predicate', async () => {
    const { db, sql } = capDb();
    await listCompanies(db, { sectors: ['45', '72'], eu: 'national', pageSize: 10 });
    const base = sql.find((s) => s.includes('FROM ('))!;
    expect(base).toContain('NULL AS primary_sector');
    expect(base).toContain('c.eu_funded IS NULL OR c.eu_funded = 0');
  });

  it('applies a single-kind filter and a text query, but not a kind filter for both kinds', async () => {
    const one = capDb();
    await listCompanies(one.db, { kinds: ['company'], q: 'софия', pageSize: 10 });
    const page = one.sql.find((s) => s.includes('sort_value'))!;
    expect(page).toContain('kind = ?');
    expect(page).toContain('search_index MATCH');

    const both = capDb();
    await listCompanies(both.db, { kinds: ['company', 'consortium'], pageSize: 10 });
    expect(both.sql.every((s) => !s.includes('kind = ?'))).toBe(true);
  });

  it('defaults the page size and tolerates a missing total row', async () => {
    const db = fakeD1([
      { when: 'FROM (', all: [filteredRows[0]!] },
      { when: 'FROM company_totals', all: [filteredRows[0]!] },
      { when: 'COUNT(*)', first: null }, // COUNT(*) row absent
    ]).db;
    const page = await listCompanies(db, {}); // no pageSize → default of 25
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(0);
  });

  it('slices to pageSize and reports a next cursor when the query overflows the page', async () => {
    const rows = [
      { ...filteredRows[0]!, bidder_id: 'eik:1', sort_value: 200 },
      { ...filteredRows[0]!, bidder_id: 'eik:2', sort_value: 100 },
    ];
    const db = fakeD1([
      { when: 'FROM (', all: rows },
      { when: 'FROM company_totals', all: rows },
      { when: 'COUNT(*)', first: { n: 9 } },
    ]).db;
    const page = await listCompanies(db, { pageSize: 1 });
    expect(page.items).toHaveLength(1); // overflow row dropped
    expect(page.total).toBe(9);
    expect(page.nextCursor).toBeTruthy();
  });
});

describe('getCompanyFacets', () => {
  it('maps the two entity kinds (missing kind → 0) and sorts sectors by descending value', async () => {
    const db = fakeD1([
      { when: 'GROUP BY kind', all: [{ kind: 'company', n: 7 }] }, // consortium absent → 0
      {
        when: 'sector_totals',
        all: [
          { division: '45', value_eur: 100 }, // out of order → must be reordered below
          { division: '72', value_eur: 900 },
        ],
      },
    ]).db;
    const facets = await getCompanyFacets(db);
    const company = facets.kinds.find((k) => k.value === 'company')!;
    const consortium = facets.kinds.find((k) => k.value === 'consortium')!;
    expect(company.count).toBe(7);
    expect(consortium.count).toBe(0); // byKind.get(k) ?? 0 fallback
    expect(facets.sectors.map((s) => s.value)).toEqual(['72', '45']); // 900 before 100
  });

  it('drops zero-value sectors from the facet', async () => {
    const db = fakeD1([
      { when: 'GROUP BY kind', all: [] },
      { when: 'sector_totals', all: [] }, // no rows → every count 0 → filtered out
    ]).db;
    const facets = await getCompanyFacets(db);
    expect(facets.sectors).toEqual([]);
  });
});

describe('streamCompaniesCsv — body edges', () => {
  it('emits header only when there are no rows', async () => {
    const db = fakeD1([
      { when: 'FROM (', all: [] },
      { when: 'FROM company_totals', all: [] },
    ]).db;
    const bytes = new Uint8Array(await streamCompaniesCsv(db, {}).arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    expect(new TextDecoder().decode(bytes)).toBe(
      'eik,name,kind,settlement,won_eur,contracts,authorities,primary_sector\n',
    );
  });

  it('continues past a full first chunk instead of closing at the CHUNK boundary', async () => {
    const CHUNK = 2000;
    const first = Array.from({ length: CHUNK }, (_, i) => ({
      ...filteredRows[0]!,
      bidder_id: `eik:${String(i).padStart(9, '0')}`,
      eik: String(i).padStart(9, '0'),
    }));
    let calls = 0;
    const page = () => (calls++ === 0 ? first : []);
    const db = fakeD1([
      { when: 'FROM (', all: page },
      { when: 'FROM company_totals', all: page },
    ]).db;
    const csv = await streamCompaniesCsv(db, {}).text();
    expect(csv.match(/\n/g)!).toHaveLength(CHUNK + 1); // header + CHUNK rows
    expect(calls).toBe(2); // === CHUNK page did not close; a second pull ran
  });
});
