import { describe, expect, it } from 'vitest';
import {
  getAuthorityFacets,
  listAuthorities,
  normalizeAuthoritySort,
  streamAuthoritiesCsv,
} from './authorities';

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

  it('defaults the page size and tolerates a missing total row', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: [authorityRow] as T[] };
          },
          async first<T>() {
            return null as T; // COUNT(*) row absent
          },
        };
      },
    } as unknown as D1Database;
    const page = await listAuthorities(db, {}); // no pageSize → default of 25
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(0); // null total row → 0
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

describe('listAuthorities — base-source and entity-where branches', () => {
  it('adds year, EU, and single-sector predicates to the base aggregation', async () => {
    const { db, sql } = spyDb();
    await listAuthorities(db, { sectors: ['45'], years: ['2024'], eu: 'eu', pageSize: 10 });
    const base = sql.find(usesBaseAggregation)!;
    expect(base).toContain('substr(t.cpv_code, 1, 2) IN');
    expect(base).toContain('substr(c.signed_at, 1, 4) IN');
    expect(base).toContain('c.eu_funded = 1');
    expect(base).toContain('? AS primary_sector'); // single sector → bound value, not NULL
  });

  it('uses NULL primary_sector for a multi-sector filter', async () => {
    const { db, sql } = spyDb();
    await listAuthorities(db, { sectors: ['45', '33'], pageSize: 10 });
    expect(sql.find(usesBaseAggregation)).toContain('NULL AS primary_sector');
  });

  it('uses the national (non-EU) funding predicate', async () => {
    const { db, sql } = spyDb();
    await listAuthorities(db, { eu: 'national', pageSize: 10 });
    expect(sql.find(usesBaseAggregation)).toContain('c.eu_funded IS NULL OR c.eu_funded = 0');
  });

  it('applies a strict-subset type filter and a text query to the entity WHERE', async () => {
    const { db, sql } = spyDb();
    await listAuthorities(db, { types: ['министерство', 'община'], q: 'софия', pageSize: 10 });
    const page = sql.find((s) => s.includes('sort_value'))!;
    expect(page).toContain('type_group IN');
    expect(page).toContain('search_index MATCH');
  });

  it('does not filter by type when all 7 buckets are selected', async () => {
    const { db, sql } = spyDb();
    await listAuthorities(db, { types: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], pageSize: 10 });
    expect(sql.every((s) => !s.includes('type_group IN'))).toBe(true);
  });

  it('slices to pageSize and reports a next cursor when the query overflows the page', async () => {
    // results.length > pageSize is the hasMore signal: the extra row is dropped from `items` but drives
    // pagination. Two rows with a pageSize of one exercises that branch and the forward-cursor assembly.
    const rows = [
      { ...authorityRow, authority_id: 'auth:1', sort_value: 200 },
      { ...authorityRow, authority_id: 'auth:2', sort_value: 100 },
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
            return { n: 5 } as T;
          },
        };
      },
    } as unknown as D1Database;
    const page = await listAuthorities(db, { pageSize: 1 });
    expect(page.items).toHaveLength(1); // the overflow row is not emitted
    expect(page.total).toBe(5);
    expect(page.nextCursor).toBeTruthy(); // hasMore → a forward cursor is produced
  });
});

describe('listAuthorities — backward pagination', () => {
  it('emits a backward page in reversed fetch order (before-cursor → reverse)', async () => {
    // 3 rows, pageSize 2 → a FULL page (pageSize 1 would make slice+reverse a no-op and hide a broken
    // reverse). Walk forward to mint a before-cursor, feed it back: keyset sets reverse=true and the
    // page is emitted in reversed fetch order. Asserting the order flip guards `rows.reverse()` itself.
    const rows = [
      { ...authorityRow, authority_id: 'auth:1', sort_value: 300 },
      { ...authorityRow, authority_id: 'auth:2', sort_value: 200 },
      { ...authorityRow, authority_id: 'auth:3', sort_value: 100 },
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
            return { n: 3 } as T;
          },
        };
      },
    } as unknown as D1Database;
    const fwd = await listAuthorities(db, { pageSize: 2 });
    const mid = await listAuthorities(db, { pageSize: 2, cursor: fwd.nextCursor! });
    expect(mid.prevCursor).toBeTruthy();
    const back = await listAuthorities(db, { pageSize: 2, cursor: mid.prevCursor! });
    expect(back.items.map((i) => i.slug)).toEqual(
      [...fwd.items].reverse().map((i) => i.slug), // reversed vs the forward page
    );
    expect(back.items).toHaveLength(2);
  });
});

describe('normalizeAuthoritySort', () => {
  it('passes through a known sort key and collapses everything else to „spent"', () => {
    expect(normalizeAuthoritySort('count')).toBe('count');
    expect(normalizeAuthoritySort('avg')).toBe('avg');
    expect(normalizeAuthoritySort('name')).toBe('name');
    expect(normalizeAuthoritySort('spent')).toBe('spent');
    expect(normalizeAuthoritySort('bogus')).toBe('spent'); // unknown → default
    expect(normalizeAuthoritySort(null)).toBe('spent'); // null → default
    expect(normalizeAuthoritySort(undefined)).toBe('spent'); // undefined → default
    // A prototype key must not slip through the `in` check as a real sort.
    expect(normalizeAuthoritySort('toString')).toBe('spent');
  });
});

describe('getAuthorityFacets — sector sort', () => {
  it('orders the sector facets by descending value', async () => {
    // Two non-zero sectors returned out of value-order forces the `.sort((a,b) => b.count - a.count)`
    // comparator to actually reorder (a single row would never invoke it).
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            if (sql.includes('GROUP BY')) return { results: [] as T[] };
            if (sql.includes('sector_totals'))
              return {
                results: [
                  { division: '45', value_eur: 100 }, // smaller first → must be reordered below
                  { division: '33', value_eur: 900 },
                ] as T[],
              };
            return { results: [] as T[] };
          },
        };
      },
    } as D1Database;
    const facets = await getAuthorityFacets(db);
    expect(facets.sectors.map((s) => s.value)).toEqual(['33', '45']); // 900 before 100
  });
});

describe('getAuthorityFacets — unmapped type label', () => {
  it('labels an unrecognised type_group as „друго"', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            // A NULL that leaks past the SQL COALESCE(type_group,'друго') → typeLabel(null) is null →
            // the `?? 'друго'` fallback owns the label. (Defensive; the real query can't emit NULL here.)
            if (sql.includes('type_group') && sql.includes('GROUP BY'))
              return { results: [{ type_group: null, n: 4 }] as T[] };
            return { results: [] as T[] };
          },
        };
      },
    } as D1Database;
    const facets = await getAuthorityFacets(db);
    expect(facets.types[0]).toMatchObject({ value: null, label: 'друго', count: 4 });
    expect(facets.sectors).toEqual([]); // no sector_totals rows
  });
});

describe('streamAuthoritiesCsv — streamed body', () => {
  it('streams a BOM header + one row per authority (auth: stripped, avg rounded) and closes', async () => {
    const rows = [
      {
        authority_id: 'auth:000695089',
        name: 'Министерство',
        type_group: 'министерство',
        settlement: 'София',
        region: 'Столична',
        spent_eur: 1000000,
        contracts: 100,
        suppliers: 30,
        avg_eur: 10000.7,
      },
    ];
    let served = false;
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            if (served) return { results: [] as T[] };
            served = true;
            return { results: rows as T[] };
          },
        };
      },
    } as unknown as D1Database;
    // The BOM lives in the bytes for Excel; Response.text()'s UTF-8 decode strips a leading BOM, so
    // assert it at the byte layer and read the content from the (BOM-stripped) decoded text.
    const bytes = new Uint8Array(await streamAuthoritiesCsv(db, {}).arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const csv = new TextDecoder().decode(bytes);
    expect(csv.startsWith('eik,name,type_group')).toBe(true);
    expect(csv).toContain('000695089'); // auth: prefix stripped
    expect(csv).toContain('10001'); // avg_eur rounded
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('closes immediately when there are no rows', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
        };
      },
    } as unknown as D1Database;
    const bytes = new Uint8Array(await streamAuthoritiesCsv(db, {}).arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]); // BOM still emitted
    expect(new TextDecoder().decode(bytes)).toBe(
      'eik,name,type_group,settlement,region,spent_eur,contracts,suppliers,avg_eur\n',
    );
  });

  it('paginates across the CHUNK boundary and folds a type filter into the WHERE', async () => {
    // A full first chunk (results.length === CHUNK) must NOT terminate the stream — the pull loop has to
    // fetch again. The type filter proves ew.sql is joined into the keyset conditions for the CSV source.
    const CHUNK = 2000;
    const first = Array.from({ length: CHUNK }, (_, i) => ({
      authority_id: `auth:${String(i).padStart(6, '0')}`,
      name: 'Ведомство',
      type_group: 'министерство',
      settlement: 'София',
      region: 'Столична',
      spent_eur: 1,
      contracts: 1,
      suppliers: 1,
      avg_eur: 1,
    }));
    let calls = 0;
    const sqls: string[] = [];
    const db = {
      prepare(sql: string) {
        sqls.push(sql);
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: (calls++ === 0 ? first : []) as T[] };
          },
        };
      },
    } as unknown as D1Database;
    const csv = await streamAuthoritiesCsv(db, { types: ['министерство'] }).text();
    expect(csv.match(/\n/g)!).toHaveLength(CHUNK + 1); // header + CHUNK rows
    expect(calls).toBe(2); // the === CHUNK page did not close; a second pull ran
    expect(sqls.some((s) => s.includes('type_group IN'))).toBe(true); // ew.sql folded into conds
  });
});
