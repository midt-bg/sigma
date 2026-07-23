import { describe, expect, it } from 'vitest';
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

  it('accepts a caller-supplied summary override without a COUNT/SUM scan', async () => {
    let firstCalls = 0;
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: [contractRow] as T[] };
          },
          async first<T>() {
            firstCalls++;
            return { total: 0, eur: 0, suspect: 0 } as T;
          },
        };
      },
    } as unknown as D1Database;
    const page = await listContracts(
      db,
      { pageSize: 10 },
      { total: 42, valueEur: 999, suspect: 3 },
    );
    expect(page.total).toBe(42);
    expect(page.valueEur).toBe(999);
    expect(page.suspect).toBe(3);
    expect(firstCalls).toBe(0); // summary override → the aggregate query is skipped
  });

  it('slices to pageSize and emits a next cursor when the page overflows', async () => {
    const rows = [
      { ...contractRow, id: 'c:1', sort_value: 200 },
      { ...contractRow, id: 'c:2', sort_value: 100 },
    ];
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: rows as T[] };
          },
          async first<T>() {
            return { total: 2, eur: 2000, suspect: 0 } as T;
          },
        };
      },
    } as unknown as D1Database;
    const page = await listContracts(db, { pageSize: 1 });
    expect(page.items).toHaveLength(1); // overflow row dropped
    expect(page.nextCursor).toBeTruthy();
  });
});

// A SQL-capturing spy over the standard fakeDb rows — for asserting which predicates buildFilters emits.
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
          return { results: (q.includes('1=0') ? [] : [contractRow]) as T[] };
        },
        async first<T>() {
          return { total: 1, eur: 1000, suspect: 0 } as T;
        },
      };
    },
  } as D1Database;
  return { db, sql };
}

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
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: [{ ...contractRow, cpv_code: null }] as T[] };
          },
          async first<T>() {
            return { total: 1, eur: 1000, suspect: 0 } as T;
          },
        };
      },
    } as unknown as D1Database;
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
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: rows as T[] };
          },
          async first<T>() {
            return { total: 3, eur: 1000, suspect: 0 } as T;
          },
        };
      },
    } as unknown as D1Database;
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
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first<T>() {
            return null as T; // no aggregate row
          },
        };
      },
    } as unknown as D1Database;
    const summary = await contractsSummary(db, {});
    expect(summary).toEqual({ total: 0, valueEur: 0, suspect: 0 });
  });
});

describe('listSingleOfferContracts', () => {
  it('orders by value in value mode and by date in recent mode', async () => {
    const capture = () => {
      const seen: string[] = [];
      const binds: unknown[][] = [];
      const db = {
        prepare(sql: string) {
          seen.push(sql);
          return {
            bind(...args: unknown[]) {
              binds.push(args);
              return this;
            },
            async all<T>() {
              return { results: [contractRow] as T[] };
            },
          };
        },
      } as D1Database;
      return { db, seen, binds };
    };
    const v = capture();
    const items = await listSingleOfferContracts(v.db, 'value', 5);
    expect(items).toHaveLength(1);
    expect(v.seen[0]).toContain('ORDER BY c.amount_eur DESC');
    expect(v.seen[0]).toContain('LIMIT ?');
    expect(v.binds[0]).toEqual([5]); // the explicit limit reaches the LIMIT placeholder

    const r = capture();
    await listSingleOfferContracts(r.db, 'recent');
    expect(r.seen[0]).toContain('ORDER BY COALESCE(c.signed_at, c.published_at) DESC');
    expect(r.binds[0]).toEqual([10]); // default limit
  });
});

describe('getContractFacets — procedure folding and EU counts', () => {
  it('folds procedure facet rows into config groups, sorts sectors, and splits EU counts', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            if (sql.includes('facet_counts'))
              return {
                results: [
                  { facet: 'procedure', key: 'Открита процедура', contracts: 5 }, // → 'open'
                  { facet: 'eu', key: '1', contracts: 8 },
                  { facet: 'eu', key: '0', contracts: 2 },
                ] as T[],
              };
            if (sql.includes('substr(t.cpv_code, 1, 2)'))
              return {
                results: [
                  { division: '45', contracts: 3 }, // out of order → must be resorted below
                  { division: '72', contracts: 9 },
                ] as T[],
              };
            return { results: [] as T[] }; // year rows
          },
        };
      },
    } as D1Database;
    const facets = await getContractFacets(db);
    expect(facets.procedures.find((p) => p.value === 'open')?.count).toBe(5);
    expect(facets.sectors.map((s) => s.value)).toEqual(['72', '45']); // 9 before 3
    expect(facets.eu).toEqual({ all: 10, eu: 8, national: 2 });
  });

  it('sorts real years newest-first and sinks the unknown bucket to the end', async () => {
    const db = {
      prepare(sql: string) {
        return {
          async all<T>() {
            if (sql.includes('facet_counts')) return { results: [] as T[] };
            if (sql.includes('substr(t.cpv_code, 1, 2)')) return { results: [] as T[] };
            return {
              results: [
                { key: '2022', contracts: 1 },
                { key: '2024', contracts: 2 },
                { key: 'unknown', contracts: 3 },
              ] as T[],
            };
          },
        };
      },
    } as D1Database;
    const facets = await getContractFacets(db);
    // localeCompare orders the real years descending; both `a === unknown` and `b === unknown`
    // comparator arms fire to push the unknown bucket last.
    expect(facets.years.map((y) => y.value)).toEqual(['2024', '2022', 'unknown']);
  });
});

describe('streamContractsCsv', () => {
  function csvDb(pages: Record<string, unknown>[][], seen?: string[]): D1Database {
    let call = 0;
    return {
      prepare(sql: string) {
        seen?.push(sql);
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: (pages[call++] ?? []) as T[] };
          },
        };
      },
    } as unknown as D1Database;
  }

  const csvRow = {
    ...contractRow,
    rowid: 1,
    authority_eik: '123456789',
    contractor_eik: '111111111',
  };

  it('streams a BOM header then one CSV row per contract with the raw (unescaped) id', async () => {
    const bytes = new Uint8Array(await streamContractsCsv(csvDb([[csvRow], []]), {}).arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const csv = new TextDecoder().decode(bytes);
    expect(csv.split('\n')[0]).toBe(
      'id,unp,subject,authority,authority_eik,contractor,contractor_eik,kind,sector_code,procedure,signed_at,value_eur,eu_funded,bids_received',
    );
    expect(csv).toContain('UNP-1');
    expect(csv).toContain('123456789'); // authority_eik column
  });

  it('emits only the header when the filtered set is empty', async () => {
    const csv = await streamContractsCsv(csvDb([[]]), { authority: '999999999' }).text();
    expect(csv.split('\n').filter(Boolean)).toHaveLength(1); // header row only
  });

  it('renders a blank sector cell and eu flag „1" for a CPV-less EU-funded row', async () => {
    const row = { ...csvRow, cpv_code: null, eu_funded: 1, amount_eur: 1000, bids_received: 3 };
    const csv = await streamContractsCsv(csvDb([[row], []]), {}).text();
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
    const seen: string[] = [];
    const csv = await streamContractsCsv(csvDb([first, []], seen), { eu: 'eu' }).text();
    expect(csv.match(/\n/g)!).toHaveLength(CHUNK + 1); // header + CHUNK rows
    expect(seen.some((s) => s.includes('c.eu_funded = 1 AND c.rowid > ?'))).toBe(true);
    expect(seen).toHaveLength(2); // === CHUNK page did not close; a second pull ran
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

  it('always sinks the „Неизвестна" bucket below real years, whatever the row order', async () => {
    // Multiple buckets with „unknown" NOT last force the comparator to evaluate `a.key === YEAR_UNKNOWN`
    // (its first arm) as well as the `b` arm — real years descend, unknown always sorts to the bottom.
    const db = {
      prepare(sql: string) {
        return {
          async all<T>() {
            if (sql.includes('facet_counts')) return { results: [] as T[] };
            if (sql.includes('substr(t.cpv_code, 1, 2)')) return { results: [] as T[] };
            return {
              results: [
                { key: '2020', contracts: 1 },
                { key: 'unknown', contracts: 2 },
                { key: '2024', contracts: 3 },
                { key: '2022', contracts: 4 },
              ] as T[],
            };
          },
        };
      },
    } as D1Database;

    const facets = await getContractFacets(db);
    const values = facets.years.map((y) => y.value);
    expect(values[values.length - 1]).toBe('unknown'); // unknown always last
    expect(values.slice(0, -1)).toEqual(['2024', '2022', '2020']); // real years descend
  });
});
