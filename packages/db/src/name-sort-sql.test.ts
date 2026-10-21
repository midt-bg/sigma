/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanName } from '@sigma/shared';
import { d1FromSqlite } from '@sigma/test-support';
import { listAuthorities } from './queries/authorities';
import { listCompanies } from './queries/companies';
import { NAME_KEY, withNameKey } from './queries/name-sort';

// The „име" sort key (queries/name-sort.ts) in a real SQLite built from every migration: the point is
// SQLite's own upper()/ltrim()/LIKE behaviour and its parser, which a deeper nesting would overflow.

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

function servedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  for (const f of readdirSync(migrations)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(resolve(migrations, f), 'utf8'));
  return db;
}

const COMPANIES = [
  '"ЯВОР ТЕСТ" ООД',
  'Бета Тест ЕООД',
  'ЕТ „ВЕГА – Тестов"',
  '„Алфа" АД',
  'ДЗЗД ГАМА ТЕСТ',
  'БЕТА ТЕСТОВА АД',
  '- Делта ООД',
];
const IN_ORDER = [
  '„Алфа" АД',
  'Бета Тест ЕООД',
  'БЕТА ТЕСТОВА АД',
  'ЕТ „ВЕГА – Тестов"',
  'ДЗЗД ГАМА ТЕСТ',
  '- Делта ООД',
  '"ЯВОР ТЕСТ" ООД',
];

function seedCompanies(db: DatabaseSync, names: string[]): void {
  const ins = db.prepare(
    `INSERT INTO company_totals (bidder_id, name, kind, eik_valid, won_eur, contracts, authorities)
     VALUES (?, ?, 'company', 1, 1, 1, 1)`,
  );
  names.forEach((n, i) => ins.run(`eik:${100000000 + i}`, n));
}

describe('name sort key', () => {
  it('orders companies А→Я regardless of case, quotes, punctuation and a leading ЕТ/ДЗЗД', async () => {
    const db = servedDb();
    seedCompanies(db, COMPANIES);
    const page = await listCompanies(d1FromSqlite(db), { sort: 'name', pageSize: 50 });
    expect(page.items.map((c) => c.name)).toEqual(IN_ORDER.map(cleanName));
  });

  it('pages through the name order with the keyset cursor', async () => {
    const db = servedDb();
    seedCompanies(db, COMPANIES);
    const first = await listCompanies(d1FromSqlite(db), { sort: 'name', pageSize: 4 });
    const second = await listCompanies(d1FromSqlite(db), {
      sort: 'name',
      pageSize: 4,
      cursor: first.nextCursor,
    });
    expect([...first.items, ...second.items].map((c) => c.name)).toEqual(IN_ORDER.map(cleanName));
  });

  it('ignores the dash in „ОБЩИНА - …" for authorities', async () => {
    const db = servedDb();
    const ins = db.prepare(
      `INSERT INTO authority_totals (authority_id, name, spent_eur, contracts, suppliers, avg_eur)
       VALUES (?, ?, 1, 1, 1, 1)`,
    );
    ['ОБЩИНА - БЕЛА', 'Община Вега', 'ОБЩИНА АЛФА'].forEach((n, i) => ins.run(`auth:${i}`, n));
    const page = await listAuthorities(d1FromSqlite(db), { sort: 'name' });
    expect(page.items.map((a) => a.name)).toEqual(['ОБЩИНА АЛФА', 'ОБЩИНА - БЕЛА', 'Община Вега']);
  });

  it('runs on the scoped aggregate of a sector filter too', async () => {
    const db = servedDb();
    await expect(
      listCompanies(d1FromSqlite(db), { sort: 'name', sectors: ['45'] }),
    ).resolves.toMatchObject({
      items: [],
    });
    await expect(
      listAuthorities(d1FromSqlite(db), { sort: 'name', sectors: ['45'] }),
    ).resolves.toMatchObject({ items: [] });
  });

  it('caps the key so a cursor built on it stays short', () => {
    const db = servedDb();
    seedCompanies(db, ['Я'.repeat(300)]);
    const row = db
      .prepare(`SELECT length(${NAME_KEY}) AS n FROM ${withNameKey('company_totals')}`)
      .get() as {
      n: number;
    };
    expect(row.n).toBe(64);
  });
});
