import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { PUBLIC_OWNERSHIP_SQL } from '../../../apps/etl/src/public-ownership';
import { getPublicStakes, publicStakeEiks } from './queries/public-stakes';

// The ownership tables are filled by the ETL but read by the explorer (a person page, a company's owners).
// They used to exist only once an import had created them, so a database built from the migrations alone —
// a fresh local one — failed the person page with „no such table: public_owned_eik“.

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
const migrated = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(resolve(migrationsDir, file), 'utf8'));
  }
  return db;
};
const ownershipTables = (db: DatabaseSync) =>
  Object.fromEntries(
    (
      db
        .prepare(
          `SELECT name, sql FROM sqlite_master WHERE name IN ('state_owned_eik', 'public_owned_eik')`,
        )
        .all() as { name: string; sql: string }[]
    ).map((r) => [r.name, r.sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')')]),
  );

it('reads public stakes on a database no import has touched, as nobody holding any', async () => {
  const db = migrated();
  try {
    const d1 = d1FromSqlite(db);
    expect(await getPublicStakes(d1, ['201122335'])).toEqual({});
    expect(await publicStakeEiks(d1, ['201122335'])).toEqual(new Set());
  } finally {
    db.close();
  }
});

it('defines the tables as the ETL does, so the ETL and a migrated database agree', () => {
  const fromMigrations = migrated();
  const fromEtl = new DatabaseSync(':memory:');
  try {
    for (const statement of PUBLIC_OWNERSHIP_SQL.filter((s) => s.startsWith('CREATE TABLE'))) {
      fromEtl.exec(statement);
    }
    expect(ownershipTables(fromMigrations)).toEqual(ownershipTables(fromEtl));
    // …and the ETL's own CREATE TABLE IF NOT EXISTS is a no-op on top of the migrated tables.
    for (const statement of PUBLIC_OWNERSHIP_SQL.filter((s) => s.startsWith('CREATE TABLE'))) {
      fromMigrations.exec(statement);
    }
  } finally {
    fromMigrations.close();
    fromEtl.close();
  }
});
