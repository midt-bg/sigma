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
  seedEntryPasses,
  nextEntryPass,
  recordEntryPage,
  deferDeed,
  deferXml,
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
    subDeeds: [{ subUic: '0014', subUicType: 'MainCircumstances', status: 'A', fields }],
  };
  return { deed: body, deedActualState: body };
};
// The register identifies a person by a 64-character hash.
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
// One entry of the managers field, listing them in full.
const managers = (...people: [indent: string, name: string][]) => ({
  fieldIdent: '00070',
  element: 'Managers',
  operation: 'Add',
  entryNumber: '20200101100000',
  actionDate: '2020-01-01T10:00:00',
  entryDate: '2020-01-01T10:00:00',
  value: {
    Manager: people.map(([indent, name], i) => ({
      RecordID: String(i + 1),
      Person: { Indent: indent, IndentType: 'EGN', Name: name },
    })),
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
  it('keeps the settlement of the seat and the date of the ownership record — never the street', async () => {
    const { db, sqlite } = served();
    const entry = (fieldIdent: string, element: string, on: string, value: unknown) => ({
      fieldIdent,
      element,
      operation: 'Add',
      entryNumber: `${on.replaceAll('-', '')}100000`,
      actionDate: `${on}T10:00:00`,
      entryDate: `${on}T10:00:00`,
      value,
    });
    await storeDeed(
      db,
      '111111111',
      {
        status: 'ok',
        deed: partida('111111111', [
          entry('00050', 'Seat', '2021-02-19', {
            RecordID: '1',
            Address: { Settlement: 'гр. София', Street: 'бул. Цар Освободител', StreetNumber: '6' },
          }),
          entry('00230', 'SoleCapitalOwner', '2015-01-01', {
            RecordID: '2',
            Subject: { Indent: H1, IndentType: 'EGN', Name: 'ИМЕ' },
          }),
        ]),
      },
      '2026-09-10T00:00:00Z',
    );
    expect(
      sqlite
        .prepare('SELECT seat_settlement, seat_entry_on, owners_entry_on FROM registry_deeds')
        .get(),
    ).toEqual({
      seat_settlement: 'гр. София',
      seat_entry_on: '2021-02-19',
      owners_entry_on: '2015-01-01',
    });
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM registry_deeds').all())).not.toContain(
      'Цар',
    );
  });

  it('writes the partida, its roles and the persons they name, and takes it off the queue', async () => {
    const { db, sqlite } = served();
    await queueNewWinners(db, '2026-09-10T00:00:00Z', 10);
    const r = await storeDeed(
      db,
      '111111111',
      {
        status: 'ok',
        deed: partida('111111111', [managers([H1, 'ИМЕ ЕДНО'], [H2, 'ИМЕ ДВЕ'])]),
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
      { subject_id: H1, role: 'manager' },
      { subject_id: H2, role: 'manager' },
    ]);
    expect(await nextQueued(db, 10)).toEqual(['222222222']);
  });

  it('replaces a partida’s facts with what the register says now, and preserves accepted facts on a later 404', async () => {
    const { db, sqlite } = served();
    await storeDeed(
      db,
      '111111111',
      {
        status: 'ok',
        deed: partida('111111111', [managers([H1, 'ИМЕ'], [H2, 'ДРУГ'])]),
      },
      '2026-09-10T00:00:00Z',
    );
    await storeDeed(
      db,
      '111111111',
      { status: 'ok', deed: partida('111111111', [managers([H2, 'ДРУГ'])]) },
      '2026-09-10T01:00:00Z',
    );
    expect(sqlite.prepare('SELECT subject_id FROM registry_roles').all()).toEqual([
      { subject_id: H2 },
    ]);
    await storeDeed(db, '111111111', { status: 'absent' }, '2026-09-10T02:00:00Z');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM registry_roles').get()).toEqual({ n: 1 });
    expect(sqlite.prepare('SELECT outcome FROM registry_deeds').get()).toEqual({
      outcome: 'ok',
    });
  });
});

describe('entry passes and pending signals', () => {
  it('seeds missed calendar days with all five passes and resumes pages', async () => {
    const { db, sqlite } = served();
    await seedEntryPasses(db, '2026-09-13', '2026-09-13T00:00:00Z');
    expect(
      sqlite
        .prepare("SELECT delay FROM registry_entry_passes WHERE day='2026-09-12' ORDER BY delay")
        .all()
        .map((r) => r.delay),
    ).toEqual([1, 3, 7, 14, 33]);
    await seedEntryPasses(db, '2026-09-16', '2026-09-16T00:00:00Z');
    expect(
      sqlite.prepare("SELECT count(*) n FROM registry_entry_passes WHERE day='2026-09-14'").get()
        ?.n,
    ).toBe(5);
    const pass = (await nextEntryPass(db, '2026-09-16', '2026-09-16T00:00:00Z'))!;
    await recordEntryPage(
      db,
      pass,
      {
        items: [{ uic: '111111111', entryDate: pass.day + 'T10:00:00', companyName: 'A' }],
        hasMore: true,
        total: 26,
      },
      '2026-09-16T00:00:00Z',
    );
    expect((await nextEntryPass(db, '2026-09-16', '2026-09-16T00:00:00Z'))?.next_page).toBe(2);
  });
  it('does not clear a pending event on HTTP 200, a later unrelated entry, or D+33; confirms exact history', async () => {
    const { db, sqlite } = served();
    await storeDeed(
      db,
      '111111111',
      { status: 'ok', deed: partida('111111111', [managers([H1, 'A'])]) },
      '2026-09-01T00:00:00Z',
    );
    sqlite.exec(
      "INSERT INTO registry_entry_signals VALUES('111111111','2026-09-02T10:00:00','2026-09-03',NULL); INSERT INTO registry_queue VALUES('111111111','changed','2026-09-03')",
    );
    const later = {
      ...managers([H2, 'B']),
      entryDate: '2026-09-04T10:00:00',
      entryNumber: 'later',
    };
    await storeDeed(
      db,
      '111111111',
      { status: 'ok', deed: partida('111111111', [later]) },
      '2026-11-01T00:00:00Z',
    );
    expect(sqlite.prepare('SELECT subject_id FROM registry_roles').get()?.subject_id).toBe(H1);
    expect(
      sqlite.prepare('SELECT confirmed_at FROM registry_entry_signals').get()?.confirmed_at,
    ).toBeNull();
    expect(await nextQueued(db, 10, '2026-11-01T00:00:00Z')).toEqual([]);
    await storeDeed(
      db,
      '111111111',
      {
        status: 'ok',
        deed: partida('111111111', [{ ...later, entryDate: '2026-09-02T10:00:00' }]),
      },
      '2026-11-02T00:00:00Z',
    );
    expect(
      sqlite.prepare('SELECT confirmed_at FROM registry_entry_signals').get()?.confirmed_at,
    ).toBe('2026-11-02T00:00:00Z');
    expect(sqlite.prepare('SELECT count(*) n FROM registry_queue').get()?.n).toBe(0);
  });
});

it('queued winners do not starve new winners; XML Retry-After pauses all reads', async () => {
  const { db } = served();
  await seedEntryPasses(db, '2026-09-13', '2026-09-13T00:00:00Z');
  expect(await queueNewWinners(db, '2026-09-13T00:00:00Z', 1)).toBe(1);
  expect(await queueNewWinners(db, '2026-09-13T00:00:00Z', 1)).toBe(1);
  await deferXml(db, '2026-09-13T00:10:00Z');
  expect(await nextQueued(db, 10, '2026-09-13T00:09:59Z')).toEqual([]);
  expect(await nextQueued(db, 10, '2026-09-13T00:10:00Z')).toHaveLength(2);
});

it('queues declared companies without contracts and stores per-entry identity evidence atomically', async () => {
  const { db, sqlite } = served();
  sqlite.exec(
    "INSERT INTO registry_requested_companies VALUES('555555555','doc','ДЕКЛАРИРАНО ООД')",
  );
  await queueNewWinners(db, '2026-09-01', 10);
  expect(sqlite.prepare("SELECT eik FROM registry_queue WHERE eik='555555555'").get()).toBeTruthy();
  const old = managers([H1, 'ИВАНА ПЕТРОВА ПЪРВА']);
  const next = {
    ...managers([H1, 'ИВАНА ПЕТРОВА ВТОРА']),
    entryNumber: '20210101100000',
    entryDate: '2021-01-01T10:00:00',
  };
  await storeDeed(
    db,
    '555555555',
    { status: 'ok', deed: partida('555555555', [old, next]) },
    '2026-09-01',
  );
  expect(
    sqlite.prepare('SELECT name FROM registry_identity_observations ORDER BY entry_on').all(),
  ).toEqual([{ name: 'ИВАНА ПЕТРОВА ПЪРВА' }, { name: 'ИВАНА ПЕТРОВА ВТОРА' }]);
  expect(sqlite.prepare('SELECT COUNT(*) n FROM registry_roles').get()).toEqual({ n: 1 });
  await storeDeed(
    db,
    '555555555',
    { status: 'ok', deed: partida('555555555', [next]) },
    '2026-09-02',
  );
  expect(sqlite.prepare('SELECT COUNT(*) n FROM registry_identity_observations').get()).toEqual({
    n: 1,
  });
});

it('backfills and replaces company name history in the same transaction as registry facts', async () => {
  const { db, sqlite } = served();
  const eik = '111111111',
    at = '2026-09-14T00:00:00Z';
  await storeDeed(db, eik, { status: 'ok', deed: partida(eik, []) }, at);
  expect(
    sqlite.prepare('SELECT names_json FROM registry_company_history WHERE eik=?').get(eik)
      ?.names_json,
  ).toBe('[]');
  expect(await queueNewWinners(db, at, 10)).toBe(1);
  sqlite.prepare('DELETE FROM registry_company_history WHERE eik=?').run(eik);
  expect(await queueNewWinners(db, at, 10)).toBe(1);
  expect(sqlite.prepare('SELECT eik FROM registry_queue WHERE eik=?').get(eik)).toBeTruthy();
  const fields = [
    { ...managers(), fieldIdent: '00020', element: 'Company', value: { $text: 'ИСТОРИЧЕСКО ИМЕ' } },
    {
      ...managers(),
      fieldIdent: '00030',
      element: 'LegalForm',
      value: { Text: 'Дружество с ограничена отговорност' },
    },
  ];
  await storeDeed(db, eik, { status: 'ok', deed: partida(eik, fields) }, at);
  const h = sqlite.prepare('SELECT * FROM registry_company_history WHERE eik=?').get(eik)!;
  expect(JSON.parse(h.names_json as string)[0]).toMatchObject({
    name: 'ИСТОРИЧЕСКО ИМЕ',
    legalForm: 'ООД',
    nameEntry: '20200101100000',
  });
  expect(h.source_hash).toBe(
    sqlite.prepare('SELECT source_hash FROM registry_identity_snapshots WHERE eik=?').get(eik)
      ?.source_hash,
  );
  expect(sqlite.prepare('SELECT eik FROM registry_queue WHERE eik=?').get(eik)).toBeUndefined();
  sqlite.prepare('UPDATE registry_company_history SET source_hash=? WHERE eik=?').run('old', eik);
  expect(await queueNewWinners(db, at, 10)).toBe(1);
  expect(sqlite.prepare('SELECT eik FROM registry_queue WHERE eik=?').get(eik)).toBeTruthy();
  await storeDeed(db, eik, { status: 'ok', deed: partida(eik, []) }, at);
  expect(
    sqlite.prepare('SELECT names_json FROM registry_company_history WHERE eik=?').get(eik)
      ?.names_json,
  ).toBe('[]');
  sqlite.close();
});
