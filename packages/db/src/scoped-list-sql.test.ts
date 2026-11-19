/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { listAuthorities } from './queries/authorities';
import { listCompanies } from './queries/companies';
import { prefixIn } from './queries/prefix-in';

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

let open: DatabaseSync | null = null;

function realDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(resolve(migrations, file), 'utf8'));
  sqlite.exec(FIXTURE);
  open = sqlite;
  return { sqlite, db: d1FromSqlite(sqlite) };
}

afterEach(() => {
  open?.close();
  open = null;
});

const eiks = (page: { items: { eik: string | null }[] }) => page.items.map((item) => item.eik);

describe('a sector or year cross-cut of the leaderboards', () => {
  it('finds exactly the contracts the substr() filter found', () => {
    const { sqlite } = realDb();
    const ids = (where: string, params: string[]) =>
      (
        sqlite
          .prepare(
            `SELECT c.id FROM contracts c JOIN tenders t ON t.id = c.tender_id WHERE ${where} ORDER BY c.id`,
          )
          .all(...params) as { id: string }[]
      ).map((row) => row.id);

    for (const sectors of [['45'], ['72'], ['45', '72'], ['44'], ['99'], ['4'], ['450'], ['ab']]) {
      const ranged = prefixIn('t.cpv_code', 2, sectors);
      const reference = `substr(t.cpv_code, 1, 2) IN (${sectors.map(() => '?').join(', ')})`;
      expect(ids(ranged.sql, ranged.params), sectors.join()).toEqual(ids(reference, sectors));
    }
    for (const years of [['2024'], ['2023', '2025'], ['2022'], ['24']]) {
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

  it('is read from the sector and date indexes, not from every contract', () => {
    const { sqlite } = realDb();
    const plan = (where: { sql: string; params: string[] }) =>
      (
        sqlite
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT b.id, SUM(c.amount_eur)
             FROM contracts c JOIN bidders b ON b.id = c.bidder_id JOIN tenders t ON t.id = c.tender_id
             WHERE c.amount_eur IS NOT NULL AND ${where.sql} GROUP BY b.id`,
          )
          .all(...where.params) as { detail: string }[]
      )
        .map((row) => row.detail)
        .join('\n');

    const sector = plan(prefixIn('t.cpv_code', 2, ['45']));
    expect(sector).toMatch(/SEARCH t USING .*\(cpv_code>\? AND cpv_code<\?\)/);
    expect(sector).toMatch(/SEARCH c USING .*\(tender_id=\?\)/);
    expect(sector).not.toMatch(/SCAN c\b/);

    const year = plan(prefixIn('c.signed_at', 4, ['2024']));
    expect(year).toMatch(/SEARCH c USING .*\(signed_at>\? AND signed_at<\?\)/);
    expect(year).not.toMatch(/SCAN c\b/);
  });
});
