// The registry layer's D1 side against a real SQLite built from the production migrations: who gets queued,
// in what order, what one partida's facts become, and a lease that one run at a time can hold.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { RegistryDeed } from '@sigma/ingest';
import { d1FromSqlite } from '@sigma/test-support';
import {
  acquireRegistryLease,
  nextQueued,
  queueAllRead,
  queueChanged,
  queueNewWinners,
  registryChangesThrough,
  releaseRegistryLease,
  renewRegistryLease,
  setRegistryChangesThrough,
  storeDeed,
} from './registry';

const migrations = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);

function served() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(migrations).sort())
    if (f.endsWith('.sql')) sqlite.exec(readFileSync(resolve(migrations, f), 'utf8'));
  sqlite.exec(`
    INSERT INTO authorities (id, name) VALUES ('a:1', 'ОБЩИНА ТЕСТ');
    INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES ('t:1', 'u1', 'Т', 'a:1', 'открита процедура');
    INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
      ('eik:111111111', 'ПЕЧЕЛИВШ ЕООД', '111111111', '111111111', 1, 'company'),
      ('eik:222222222', 'ВТОРИ ЕООД', '222222222', '222222222', 1, 'company'),
      ('eik:333333333', 'БЕЗ ДОГОВОР ЕООД', '333333333', '333333333', 1, 'company'),
      ('eik:1111111110001', 'КЛОН', '1111111110001', '1111111110001', 1, 'company'),
      ('eik:444444444', 'НЕВАЛИДЕН', '444444444', '444444444', 0, 'company');
    INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES
      ('c:1', 't:1', 'eik:111111111', 1, 'EUR', '2024-01-01', 'Д1', 1),
      ('c:2', 't:1', 'eik:222222222', 1, 'EUR', '2024-01-01', 'Д2', 1),
      ('c:3', 't:1', 'eik:1111111110001', 1, 'EUR', '2024-01-01', 'Д3', 1),
      ('c:4', 't:1', 'eik:444444444', 1, 'EUR', '2024-01-01', 'Д4', 1);
  `);
  return { sqlite, db: d1FromSqlite(sqlite) };
}

const partida = (
  uic: string,
  fields: RegistryDeed['deed']['subDeeds'][number]['fields'],
): RegistryDeed => {
  const body = {
    uic,
    name: 'ПЕЧЕЛИВШ ЕООД',
    status: 'N',
    guid: 'g',
    legalForm: 'EOOD',
    subDeeds: [{ subUic: '0014', subUicType: 'Main', status: 'A', fields }],
  };
  return { deed: body, deedActualState: body };
};
const manager = (recordId: string, indent: string, name: string) => ({
  fieldIdent: '00070',
  element: 'Managers',
  operation: 'Add',
  entryNumber: '20200101100000',
  actionDate: '2020-01-01T10:00:00',
  entryDate: '2020-01-01T10:00:00',
  value: {
    Manager: [{ RecordID: recordId, Person: { Indent: indent, IndentType: 'EGN', Name: name } }],
  },
});

describe('the registry lease', () => {
  it('lets one run hold it, hands it over once it expires, and releases only its own', async () => {
    const { db } = served();
    const t0 = new Date('2026-09-10T00:00:00Z');
    expect(await acquireRegistryLease(db, 'a', t0)).toBe(true);
    expect(await acquireRegistryLease(db, 'b', t0)).toBe(false);
    expect(await acquireRegistryLease(db, 'a', t0)).toBe(true); // re-acquiring your own is a no-op
    const later = new Date(t0.getTime() + 31 * 60 * 1000);
    expect(await acquireRegistryLease(db, 'b', later)).toBe(true);
    expect(await renewRegistryLease(db, 'a', later)).toBe(false);
    await releaseRegistryLease(db, 'a'); // not a's to release
    expect(await acquireRegistryLease(db, 'a', later)).toBe(false);
    await releaseRegistryLease(db, 'b');
    expect(await acquireRegistryLease(db, 'a', later)).toBe(true);
  });

  it('keeps how far the changes were followed across runs and releases', async () => {
    const { db } = served();
    expect(await registryChangesThrough(db)).toBeNull();
    await setRegistryChangesThrough(db, '2026-09-08');
    await acquireRegistryLease(db, 'a');
    await releaseRegistryLease(db, 'a');
    expect(await registryChangesThrough(db)).toBe('2026-09-08');
  });
});

describe('the queue', () => {
  it('queues the winners never read — a partida ЕИК, valid, with a contract — once each, up to the limit', async () => {
    const { db } = served();
    expect(await queueNewWinners(db, '2026-09-10T00:00:00Z', 1)).toBe(1);
    expect(await queueNewWinners(db, '2026-09-10T00:00:01Z', 10)).toBe(1);
    expect(await queueNewWinners(db, '2026-09-10T00:00:02Z', 10)).toBe(0);
    expect((await nextQueued(db, 10)).sort()).toEqual(['111111111', '222222222']);
  });

  it('queues a change only for a partida already read, and reads the changed ones first', async () => {
    const { db } = served();
    await queueNewWinners(db, '2026-09-10T00:00:00Z', 10);
    await storeDeed(db, '222222222', { status: 'absent' }, '2026-09-10T00:00:00Z');
    expect(await queueChanged(db, ['222222222', '999999999'], '2026-09-10T01:00:00Z')).toBe(1);
    expect(await queueChanged(db, [], '2026-09-10T01:00:00Z')).toBe(0);
    expect(await nextQueued(db, 10)).toEqual(['222222222', '111111111']);
  });

  it('queues every read partida again when the feed was left too far behind', async () => {
    const { db } = served();
    await storeDeed(db, '111111111', { status: 'absent' }, '2026-09-10T00:00:00Z');
    await storeDeed(db, '222222222', { status: 'absent' }, '2026-09-10T00:00:00Z');
    expect(await queueAllRead(db, '2026-09-11T00:00:00Z')).toBe(2);
  });
});

describe('storeDeed', () => {
  it('writes the partida, its roles and the persons they name, and takes it off the queue', async () => {
    const { db, sqlite } = served();
    await queueNewWinners(db, '2026-09-10T00:00:00Z', 10);
    const r = await storeDeed(
      db,
      '111111111',
      {
        status: 'ok',
        deed: partida('111111111', [manager('1', 'h1', 'ИМЕ ЕДНО'), manager('2', 'h2', 'ИМЕ ДВЕ')]),
      },
      '2026-09-10T02:00:00Z',
    );
    expect(r).toEqual({ roles: 2, persons: 2 });
    expect(sqlite.prepare('SELECT outcome, name FROM registry_deeds').all()).toEqual([
      { outcome: 'ok', name: 'ПЕЧЕЛИВШ ЕООД' },
    ]);
    expect(
      sqlite.prepare('SELECT subject_id, role FROM registry_roles ORDER BY subject_id').all(),
    ).toEqual([
      { subject_id: 'h1', role: 'manager' },
      { subject_id: 'h2', role: 'manager' },
    ]);
    expect(await nextQueued(db, 10)).toEqual(['222222222']);
  });

  it('replaces a partida’s facts with what the register says now, and keeps nothing for an absent one', async () => {
    const { db, sqlite } = served();
    await storeDeed(
      db,
      '111111111',
      {
        status: 'ok',
        deed: partida('111111111', [manager('1', 'h1', 'ИМЕ'), manager('2', 'h2', 'ДРУГ')]),
      },
      't1',
    );
    await storeDeed(
      db,
      '111111111',
      { status: 'ok', deed: partida('111111111', [manager('2', 'h2', 'ДРУГ')]) },
      't2',
    );
    expect(sqlite.prepare('SELECT subject_id FROM registry_roles').all()).toEqual([
      { subject_id: 'h2' },
    ]);
    await storeDeed(db, '111111111', { status: 'absent' }, 't3');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM registry_roles').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT outcome FROM registry_deeds').get()).toEqual({
      outcome: 'absent',
    });
  });
});
