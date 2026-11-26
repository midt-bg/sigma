/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getFlows, type FlowsParams } from './queries/flows';
import { authoritySlug, companySlug } from './queries/identity';
import { getDb } from './readonly-d1';

// The filtered flows in a real SQLite built from every migration: the sector and year now reach the
// contracts through their indexes, and the pairs, their sums, counts and order are the ones the substr()
// statement gave.

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

// CPV codes and signing dates on both sides of every range edge, plus the values no range may catch: a
// tender with no code, codes that only look like a division, a contract with no date, a malformed date,
// one with no value. Two pairs tie on their sum.
const FIXTURE = `
INSERT INTO authorities (id, name, bulstat, type_group) VALUES
  ('auth:100000001', 'Община Тест', '100000001', 'община'),
  ('auth:100000002', 'Агенция Тест', '100000002', 'агенция'),
  ('auth:100000003', 'Болница Тест', '100000003', 'болница');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:200000001', 'АЛФА ТЕСТ ЕООД', '200000001', '200000001', 1, 'company'),
  ('eik:200000002', 'БЕТА ТЕСТ ООД', '200000002', '200000002', 1, 'company'),
  ('eik:200000003', 'ВЕГА ТЕСТ АД', '200000003', '200000003', 1, 'consortium'),
  ('eik:200000004', 'ГАМА ТЕСТ ЕООД', '200000004', '200000004', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
  ('t:1', 'UNP-1', 'Поръчка 1', 'auth:100000001', '45000000', 'открита процедура', 'awarded'),
  ('t:2', 'UNP-2', 'Поръчка 2', 'auth:100000002', '45999999', 'открита процедура', 'awarded'),
  ('t:3', 'UNP-3', 'Поръчка 3', 'auth:100000003', '44999999', 'открита процедура', 'awarded'),
  ('t:4', 'UNP-4', 'Поръчка 4', 'auth:100000001', '46000000', 'открита процедура', 'awarded'),
  ('t:5', 'UNP-5', 'Поръчка 5', 'auth:100000002', '4*000000', 'открита процедура', 'awarded'),
  ('t:6', 'UNP-6', 'Поръчка 6', 'auth:100000003', NULL,       'открита процедура', 'awarded'),
  ('t:7', 'UNP-7', 'Поръчка 7', 'auth:100000003', '09310000', 'открита процедура', 'awarded'),
  ('t:8', 'UNP-8', 'Поръчка 8', 'auth:100000002', '0:000000', 'открита процедура', 'awarded'),
  ('t:9', 'UNP-9', 'Поръчка 9', 'auth:100000001', '45',       'открита процедура', 'awarded');
INSERT INTO contracts
  (id, tender_id, bidder_id, amount, currency, signed_at, eu_funded, value_flag, amount_eur)
VALUES
  ('c:01', 't:1', 'eik:200000001', 500, 'EUR', '2024-01-01', 1,    'ok', 500),
  ('c:02', 't:1', 'eik:200000001', 400, 'EUR', '2024-12-31', 0,    'ok', 400),
  ('c:03', 't:1', 'eik:200000002', 300, 'EUR', '2023-12-31', NULL, 'ok', 300),
  ('c:04', 't:2', 'eik:200000002', 200, 'EUR', '2025-01-01', 1,    'ok', 200),
  ('c:05', 't:2', 'eik:200000003', 900, 'EUR', '2024-06-15', 0,    'ok', 900),
  ('c:06', 't:3', 'eik:200000004', 800, 'EUR', '2024-03-01', 1,    'ok', 800),
  ('c:07', 't:4', 'eik:200000004', 700, 'EUR', '2024-03-02', NULL, 'ok', 700),
  ('c:08', 't:5', 'eik:200000001', 650, 'EUR', '2024-03-03', 1,    'ok', 650),
  ('c:09', 't:6', 'eik:200000002', 600, 'EUR', '2024-03-04', 1,    'ok', 600),
  ('c:10', 't:1', 'eik:200000003', 50,  'EUR', NULL,         1,    'ok', 50),
  ('c:11', 't:1', 'eik:200000004', 60,  'EUR', '2024-02-02', 1,    'value_suspect', NULL),
  ('c:12', 't:7', 'eik:200000001', 250, 'EUR', '2024',       0,    'ok', 250),
  ('c:13', 't:7', 'eik:200000002', 250, 'EUR', '2024-05-05', 0,    'ok', 250),
  ('c:14', 't:8', 'eik:200000003', 120, 'EUR', '2024-07-07', 1,    'ok', 120),
  ('c:15', 't:9', 'eik:200000002', 110, 'EUR', '20*4-01-01', 1,    'ok', 110),
  ('c:16', 't:9', 'eik:200000004', 100, 'EUR', '2024-',      0,    'ok', 100);
`;

// The statement before the sector and year became ranges, verbatim: the reference every filter is held to.
function reference(sqlite: DatabaseSync, p: FlowsParams, top: number) {
  const where = ['c.amount_eur IS NOT NULL'];
  const params: SQLInputValue[] = [];
  if (p.sector) {
    where.push('substr(t.cpv_code, 1, 2) = ?');
    params.push(p.sector);
  }
  if (p.year) {
    where.push('substr(c.signed_at, 1, 4) = ?');
    params.push(p.year);
  }
  if (p.funding === 'eu') where.push('c.eu_funded = 1');
  else if (p.funding === 'national') where.push('(c.eu_funded IS NULL OR c.eu_funded = 0)');
  const rows = sqlite
    .prepare(
      `SELECT t.authority_id, c.bidder_id, a.name AS authority_name, b.name AS bidder_name,
              b.kind AS bidder_kind, SUM(c.amount_eur) AS won_eur, COUNT(*) AS contracts
       FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
       JOIN bidders b ON b.id = c.bidder_id
       WHERE ${where.join(' AND ')}
       GROUP BY t.authority_id, c.bidder_id ORDER BY won_eur DESC LIMIT ?`,
    )
    .all(...params, top) as {
    authority_id: string;
    bidder_id: string;
    won_eur: number;
    contracts: number;
  }[];
  return rows.map((r) => [
    authoritySlug(r.authority_id),
    companySlug(r.bidder_id),
    r.won_eur,
    r.contracts,
  ]);
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
  const queries: { sql: string; params: SQLInputValue[] }[] = [];
  sqliteD1.prepare = (sql) => {
    const stmt = prepare(sql);
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...params: SQLInputValue[]) => {
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

const pairQuery = (queries: { sql: string; params: SQLInputValue[] }[]) =>
  queries.find(({ sql }) => sql.includes('FROM contracts c'))!;

const plan = (sqlite: DatabaseSync, { sql, params }: { sql: string; params: SQLInputValue[] }) =>
  (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
    .map(({ detail }) => detail)
    .join('\n');

describe('filtered flows', () => {
  const sectors = [null, '45', '44', '46', '09', '0:', '4*', '99'];
  const years = [null, '2024', '2023', '2025', '2019', '20*4'];
  const fundings = ['all', 'eu', 'national'] as const;
  const combos = sectors.flatMap((sector) =>
    years.flatMap((year) => fundings.map((funding) => ({ sector, year, funding }))),
  );

  it.each([20, 1])(
    'give the pairs, sums, counts and order the substr() statement gave (top %i)',
    async (top) => {
      const { sqlite, db } = realDb();
      for (const p of combos.filter((c) => c.sector || c.year || c.funding !== 'all')) {
        const data = await getFlows(db, { ...p, top });
        expect(
          data.pairs.map((pair) => [
            pair.authoritySlug,
            pair.bidderSlug,
            pair.wonEur,
            pair.contracts,
          ]),
          JSON.stringify(p),
        ).toEqual(reference(sqlite, p, top));
      }
    },
  );

  it('keep the tie between two equal sums in the order it had', async () => {
    const { db } = realDb();
    const data = await getFlows(db, { sector: '09', year: '2024' });
    expect(data.pairs.map((pair) => [pair.bidderSlug, pair.wonEur])).toEqual([
      ['200000001', 250],
      ['200000002', 250],
    ]);
  });

  it.each([
    { name: 'a sector', p: { sector: '45' } },
    { name: 'a year', p: { year: '2024' } },
    { name: 'a sector and a year', p: { sector: '45', year: '2024' } },
    {
      name: 'a sector, a year and EU funding',
      p: { sector: '45', year: '2024', funding: 'eu' as const },
    },
  ])('read the contracts of $name through an index, not the whole table', async ({ p }) => {
    const { sqlite, db, queries } = realDb();
    await getFlows(db, p);
    const details = plan(sqlite, pairQuery(queries));
    expect(details).toMatch(/\((?:cpv_code|signed_at)>\? AND (?:cpv_code|signed_at)<\?\)/);
    expect(details).not.toMatch(/SCAN c\b/);
    expect(details).not.toMatch(/SCAN t\b/);
  });

  it('bind the sector and the year once each', async () => {
    const { db, queries } = realDb();
    await getFlows(db, { sector: '45', year: '2024', top: 50 });
    expect(pairQuery(queries).params).toEqual(['45', '2024', 50]);
  });
});
