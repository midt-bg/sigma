/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CPV_SECTORS } from '@sigma/config';
import { d1FromSqlite } from '@sigma/test-support';
import { listAuthorities, streamAuthoritiesCsv } from './queries/authorities';
import { listCompanies, streamCompaniesCsv } from './queries/companies';
import { decodeCursor, encodeCursor } from './queries/keyset';
import { prefixIn } from './queries/prefix-in';
import { getDb } from './readonly-d1';

// The sector/year cross-cut of the leaderboards in a real SQLite built from every migration: that the
// index-friendly filter finds exactly the rows the substr() one found, that SQLite does serve it from the
// indexes, and that a page of the scoped aggregation carries the total of the whole of it.

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

// Five companies and three authorities over two sectors and two years. One tender has no CPV code, one
// contract no date and one no value: none of them may reach a filtered list.
const FIXTURE = `
INSERT INTO authorities (id, name, bulstat, type_group) VALUES
  ('auth:100000001', 'Община Тест', '100000001', 'община'),
  ('auth:100000002', 'Агенция Тест', '100000002', 'агенция'),
  ('auth:100000003', 'Болница Тест', '100000003', 'болница');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:200000001', 'АЛФА ТЕСТ ЕООД', '200000001', '200000001', 1, 'company'),
  ('eik:200000002', 'БЕТА ТЕСТ ООД', '200000002', '200000002', 1, 'company'),
  ('eik:200000003', 'ВЕГА ТЕСТ АД', '200000003', '200000003', 1, 'company'),
  ('eik:200000004', 'ГАМА ТЕСТ ЕООД', '200000004', '200000004', 1, 'company'),
  ('eik:200000005', 'ДЕЛТА ТЕСТ ООД', '200000005', '200000005', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
  ('t:1', 'UNP-1', 'Поръчка 1', 'auth:100000001', '45000000', 'открита процедура', 'awarded'),
  ('t:2', 'UNP-2', 'Поръчка 2', 'auth:100000002', '45233120', 'открита процедура', 'awarded'),
  ('t:3', 'UNP-3', 'Поръчка 3', 'auth:100000003', '72000000', 'открита процедура', 'awarded'),
  ('t:4', 'UNP-4', 'Поръчка 4', 'auth:100000001', '46000000', 'открита процедура', 'awarded'),
  ('t:5', 'UNP-5', 'Поръчка 5', 'auth:100000002', '44999999', 'открита процедура', 'awarded'),
  ('t:6', 'UNP-6', 'Поръчка 6', 'auth:100000003', NULL,       'открита процедура', 'awarded');
INSERT INTO contracts
  (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur)
VALUES
  ('c:01', 't:1', 'eik:200000001', 500, 'EUR', '2024-01-01', 1, 'ok', 500),
  ('c:02', 't:1', 'eik:200000002', 400, 'EUR', '2024-12-31', 1, 'ok', 400),
  ('c:03', 't:2', 'eik:200000003', 300, 'EUR', '2023-12-31', 1, 'ok', 300),
  ('c:04', 't:2', 'eik:200000004', 200, 'EUR', '2025-01-01', 1, 'ok', 200),
  ('c:05', 't:2', 'eik:200000001', 100, 'EUR', '2024-06-15', 1, 'ok', 100),
  ('c:06', 't:3', 'eik:200000005', 900, 'EUR', '2024-03-01', 1, 'ok', 900),
  ('c:07', 't:4', 'eik:200000005', 800, 'EUR', '2024-03-02', 1, 'ok', 800),
  ('c:08', 't:5', 'eik:200000005', 700, 'EUR', '2024-03-03', 1, 'ok', 700),
  ('c:09', 't:6', 'eik:200000005', 600, 'EUR', '2024-03-04', 1, 'ok', 600),
  ('c:10', 't:1', 'eik:200000003', 50,  'EUR', NULL,         1, 'ok', 50),
  ('c:11', 't:1', 'eik:200000004', 60,  'EUR', '2024-02-02', 1, 'value_suspect', NULL);
`;

interface BoundQuery {
  sql: string;
  params: SQLInputValue[];
}

let open: DatabaseSync | null = null;

function realDb() {
  const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(resolve(migrations, file), 'utf8'));
  sqlite.exec(FIXTURE);
  open = sqlite;
  const sqliteD1 = d1FromSqlite(sqlite);
  const prepare = sqliteD1.prepare.bind(sqliteD1);
  const queries: BoundQuery[] = [];
  sqliteD1.prepare = (sql) => {
    const stmt = prepare(sql);
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...params: SQLInputValue[]) => {
      if (params.length > 100) throw new Error(`D1 bind limit exceeded: ${params.length}/100`);
      queries.push({ sql, params });
      return bind(...params);
    };
    return stmt;
  };
  return { sqlite, db: getDb({ DB: sqliteD1 }), queries };
}

afterEach(() => {
  open?.close();
  open = null;
});

const eiks = (page: { items: { eik: string | null }[] }) => page.items.map((item) => item.eik);

const leaderboards = [
  {
    route: 'companies',
    list: listCompanies,
    exportCsv: streamCompaniesCsv,
    filters: { kinds: ['company' as const], countBucket: '2-5' },
    expectedNames: ['БЕТА ТЕСТ ООД', 'АЛФА ТЕСТ ЕООД'],
    expectedCsv: [
      'eik,name,kind,settlement,won_eur,contracts,authorities,primary_sector',
      '200000001,АЛФА ТЕСТ ЕООД,company,,600,2,2,',
      '200000002,БЕТА ТЕСТ ООД,company,,601,2,2,',
    ],
  },
  {
    route: 'authorities',
    list: listAuthorities,
    exportCsv: streamAuthoritiesCsv,
    filters: {
      types: ['община', 'агенция', 'министерство', 'образование', 'държавна компания', 'друго'],
    },
    expectedNames: ['Агенция Тест', 'Община Тест'],
    expectedCsv: [
      'eik,name,type_group,settlement,region,spent_eur,contracts,suppliers,avg_eur',
      '100000001,Община Тест,община,,,1100,2,2,550',
      '100000002,Агенция Тест,агенция,,,1101,4,4,275',
    ],
  },
];

const yearSelections = [
  { name: 'numeric', lastYear: '2012' },
  { name: 'mixed', lastYear: 'unknown' },
];

function wideFilters(sqlite: DatabaseSync, lastYear: string) {
  sqlite.exec(`
    UPDATE bidders SET kind = 'consortium' WHERE id = 'eik:200000003';
    UPDATE contracts SET eu_funded = 1 WHERE id <> 'c:04';
    UPDATE contracts SET amount_eur = 600 WHERE id = 'c:02';
    INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, eu_funded, amount_eur)
      VALUES ('c:12', 't:2', 'eik:200000002', 1, 'EUR', '2024-01-01', 1, 1);
    INSERT INTO search_index (kind, ref, title) SELECT 'company', id, 'lookup' FROM bidders
      WHERE id <> 'eik:200000005';
    INSERT INTO search_index (kind, ref, title) SELECT 'authority', id, 'lookup' FROM authorities;
  `);
  return {
    sectors: CPV_SECTORS.map(({ code }) => code),
    years: [
      '2023',
      '2024',
      '2025',
      ...Array.from({ length: 12 }, (_, i) => String(2000 + i)),
      lastYear,
    ],
    eu: 'eu' as const,
    q: 'lookup',
  };
}

describe.each(leaderboards)(
  'wide $route filters',
  ({ route, list, exportCsv, filters, expectedNames, expectedCsv }) => {
    it.each(yearSelections)(
      'lists and counts cursor pages with all sectors and 16 $name years',
      async ({ lastYear }) => {
        const { sqlite, db, queries } = realDb();
        const params = { ...wideFilters(sqlite, lastYear), ...filters, pageSize: 1 };
        const first = await list(db, params);
        const second = await list(db, { ...params, cursor: first.nextCursor });
        expect(first.items.map(({ name }) => name)).toEqual(expectedNames.slice(0, 1));
        expect(second.items.map(({ name }) => name)).toEqual(expectedNames.slice(1));
        expect([first.total, second.total]).toEqual([2, 2]);
        expect(second.nextCursor).toBeNull();

        const sortToken = decodeCursor(first.nextCursor)!.sortToken;
        const cursor = encodeCursor('after', 0, '', sortToken);
        await expect(list(db, { ...params, cursor })).resolves.toEqual({
          items: [],
          total: 2,
          nextCursor: null,
          prevCursor: null,
        });
        expect(queries).toHaveLength(4); // first, next, empty and its scoped count
      },
    );

    it.each(yearSelections)(
      'streams the CSV body with all sectors and 16 $name years',
      async ({ lastYear }) => {
        const { sqlite, db } = realDb();
        const response = exportCsv(db, { ...wideFilters(sqlite, lastYear), ...filters });
        expect(response.headers.get('Content-Disposition')).toBe(
          `attachment; filename="sigma-${route}.csv"`,
        );
        expect(await response.text()).toBe(`${expectedCsv.join('\n')}\n`);
      },
    );
  },
);

describe('a sector or year cross-cut of the leaderboards', () => {
  it('finds exactly the contracts the substr() filter found', () => {
    const { sqlite } = realDb();
    sqlite.exec(`
      UPDATE tenders SET cpv_code = '09999999' WHERE id = 't:3';
      UPDATE tenders SET cpv_code = '0:000000' WHERE id = 't:4';
      UPDATE tenders SET cpv_code = '4*000000' WHERE id = 't:5';
      UPDATE contracts SET signed_at = '20*4-01-01' WHERE id = 'c:03';
    `);
    const ids = (where: string, params: string[]) =>
      (
        sqlite
          .prepare(
            `SELECT c.id FROM contracts c JOIN tenders t ON t.id = c.tender_id WHERE ${where} ORDER BY c.id`,
          )
          .all(...params) as { id: string }[]
      ).map((row) => row.id);

    for (const sectors of [['45'], ['09'], ['45', '09', '4*'], ['0:'], ['99'], ['4'], ['450']]) {
      const ranged = prefixIn('t.cpv_code', 2, sectors);
      const reference = `substr(t.cpv_code, 1, 2) IN (${sectors.map(() => '?').join(', ')})`;
      expect(ids(ranged.sql, ranged.params), sectors.join()).toEqual(ids(reference, sectors));
    }
    for (const years of [
      ['2024'],
      ['2023', '2025'],
      ['2024', '20*4', 'unknown'],
      ['2022'],
      ['24'],
    ]) {
      const ranged = prefixIn('c.signed_at', 4, years);
      const reference = `substr(c.signed_at, 1, 4) IN (${years.map(() => '?').join(', ')})`;
      expect(ids(ranged.sql, ranged.params), years.join()).toEqual(ids(reference, years));
    }
  });

  it('lists the companies of a sector and a year, largest first', async () => {
    const { db } = realDb();
    const sector = await listCompanies(db, { sectors: ['45'], pageSize: 10 });
    expect(eiks(sector)).toEqual(['200000001', '200000002', '200000003', '200000004']);
    expect(sector.items.map((item) => item.wonEur)).toEqual([600, 400, 350, 200]);
    expect(sector.total).toBe(4);

    const both = await listCompanies(db, { sectors: ['45'], years: ['2024'], pageSize: 10 });
    expect(eiks(both)).toEqual(['200000001', '200000002']);
    expect(both.total).toBe(2);
  });

  it('carries the total of the whole cross-cut on every page of it', async () => {
    const { db } = realDb();
    const first = await listCompanies(db, { sectors: ['45'], pageSize: 3 });
    const second = await listCompanies(db, {
      sectors: ['45'],
      pageSize: 3,
      cursor: first.nextCursor,
    });
    expect(eiks(first)).toEqual(['200000001', '200000002', '200000003']);
    expect(eiks(second)).toEqual(['200000004']);
    expect([first.total, second.total]).toEqual([4, 4]);

    const back = await listCompanies(db, {
      sectors: ['45'],
      pageSize: 3,
      cursor: second.prevCursor,
    });
    expect(eiks(back)).toEqual(eiks(first));
    expect(back.total).toBe(4);
  });

  it('counts an empty cross-cut as none', async () => {
    const { db } = realDb();
    await expect(listCompanies(db, { sectors: ['99'] })).resolves.toMatchObject({
      items: [],
      total: 0,
    });
    await expect(listAuthorities(db, { years: ['2019'] })).resolves.toMatchObject({
      items: [],
      total: 0,
    });
  });

  it('sorts the cross-cut by name and filters it by kind of authority', async () => {
    const { db } = realDb();
    const byName = await listCompanies(db, { sectors: ['45'], sort: 'name', pageSize: 2 });
    expect(byName.items.map((item) => item.name)).toEqual(['АЛФА ТЕСТ ЕООД', 'БЕТА ТЕСТ ООД']);
    expect(byName.total).toBe(4);

    const authorities = await listAuthorities(db, { years: ['2024'], pageSize: 10 });
    expect(authorities.items.map((item) => item.name)).toEqual([
      'Община Тест',
      'Болница Тест',
      'Агенция Тест',
    ]);
    expect(authorities.total).toBe(3);
    const municipal = await listAuthorities(db, { years: ['2024'], types: ['община'] });
    expect(municipal.items.map((item) => item.name)).toEqual(['Община Тест']);
    expect(municipal.total).toBe(1);
  });
});

describe.each(leaderboards)('$route query plans', ({ list, exportCsv }) => {
  it.each([
    { name: 'one sector', filters: { sectors: ['45'] }, range: 'cpv_code', count: 1 },
    { name: 'two sectors', filters: { sectors: ['45', '72'] }, range: 'cpv_code', count: 2 },
    { name: 'one year', filters: { years: ['2024'] }, range: 'signed_at', count: 1 },
    { name: 'two years', filters: { years: ['2024', '2025'] }, range: 'signed_at', count: 2 },
    {
      name: 'one sector and mixed years',
      filters: { sectors: ['45'], years: ['2024', 'unknown'] },
      range: 'cpv_code',
      count: 1,
    },
  ])('use indexed ranges with $name', async ({ filters, range, count }) => {
    const { sqlite, db, queries } = realDb();
    await list(db, filters);
    await exportCsv(db, filters).text();
    expect(queries).toHaveLength(2);
    for (const { sql, params } of queries) {
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
        detail: string;
      }[];
      const details = plan.map(({ detail }) => detail).join('\n');
      expect(details.match(new RegExp(`\\(${range}>\\? AND ${range}<\\?\\)`, 'g'))).toHaveLength(
        count,
      );
      expect(details).not.toMatch(/SCAN c\b/);
    }
  });
});
