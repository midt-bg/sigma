// node:test — the decision pass: every candidate link decided against the registry facts of its company,
// read from the registry layer exported into the work DB. No network, and nothing carried over from an
// earlier run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { run, readRegistry, readLinksFile } from './decide.mjs';
import { openCache, readVerdict, readDeed, upsertVerdict } from './cache.mjs';
import { RULES_VERSION } from './evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY_SCHEMA = fs.readFileSync(
  path.join(ROOT, 'packages/db/migrations/0013_registry.sql'),
  'utf8',
);
const hash = (c) => c.repeat(64);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-decide-'));
  const registryDb = path.join(dir, 'work.sqlite');
  const db = new DatabaseSync(registryDb);
  db.exec(REGISTRY_SCHEMA);
  db.exec(
    fs.readFileSync(
      path.join(ROOT, 'packages/db/migrations/0017_registry_identity_observations.sql'),
      'utf8',
    ),
  );
  db.exec(`
    INSERT INTO registry_deeds (eik, name, legal_form, status, seat_settlement, seat_entry_on,
                                owners_entry_on, outcome, fetched_at) VALUES
      ('201122335', 'АЛФА СТРОЙ', 'OOD', 'N', 'гр. Пловдив', '2009-05-02', '2009-05-02', 'ok', '2026-09-10T02:00:00Z'),
      ('201122336', 'БЕТА ИНВЕСТ', 'AD', 'N', 'гр. София', '2010-01-01', NULL, 'ok', '2026-09-09T02:00:00Z'),
      ('000696327', NULL, NULL, NULL, NULL, NULL, NULL, 'absent', '2026-09-08T02:00:00Z');
    INSERT INTO registry_roles (eik, sub_uic, field_ident, role, subject_kind, subject_id, subject_name,
                                share, country, entry_number, added_on, removed_on) VALUES
      ('201122335', '0000', '00190', 'partner', 'person', '${hash('a')}', 'ИВАН ПЕТРОВ ТЕСТОВ', '500 BGN', NULL,
       '20090502101007', '2009-05-02', NULL),
      ('201122335', '0000', '00070', 'manager', 'person', '${hash('b')}', 'ГЕОРГИ ДИМИТРОВ ТЕСТОВ', NULL, NULL,
       '20090502101007', '2009-05-02', '2019-01-01'),
      ('201122335', '0000', '05500', 'beneficial_owner', 'person', '${hash('c')}', 'МАРИЯ ИВАНОВА ПЕТРОВА', '100',
       NULL, '20190101000000', '2019-01-01', NULL);
  `);
  db.close();
  const link = (over) => ({
    declarantName: 'Иван Петров Тестов',
    declaredEik: false,
    firstDeclaredYear: 2021,
    scope: 'self',
    ...over,
  });
  const links = [
    link({ linkKey: 'person:ivan|201122335', eik: '201122335' }),
    link({
      linkKey: 'person:georgi|201122335',
      eik: '201122335',
      declarantName: 'Георги Димитров Тестов',
    }),
    link({
      linkKey: 'person:maria|201122335',
      eik: '201122335',
      declarantName: 'Мария Иванова Петрова',
    }),
    link({ linkKey: 'person:ivan|201122336', eik: '201122336' }),
    link({ linkKey: 'person:ivan|000696327', eik: '000696327' }),
    link({ linkKey: 'person:ivan|201122337', eik: '201122337' }),
  ];
  const linksFile = path.join(dir, 'links.jsonl');
  fs.writeFileSync(linksFile, links.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, registryDb, linksFile, trDb: path.join(dir, 'tr-cache.sqlite') };
}

const decide = (f, logs = []) =>
  run({
    argv: ['node', 'decide.mjs', '--links-file', f.linksFile, '--registry-db', f.registryDb],
    guard: () => {},
    dbFile: f.trDb,
    log: (m) => logs.push(m),
  });

test('decides each link against the registry as it stands, dated by the day the partida was read', () => {
  const f = fixture();
  assert.equal(decide(f), 0);
  const cache = openCache(f.trDb);
  try {
    const ivan = readVerdict(cache, 'person:ivan|201122335');
    assert.equal(ivan.kind, 'document');
    assert.equal(ivan.publishable, true);
    assert.equal(ivan.registryRole, 'owner');
    assert.equal(ivan.matchedFact, 'role:owner:00190');
    assert.equal(ivan.entryNumber, '20090502101007');
    assert.equal(ivan.entryDate, '2009-05-02');
    assert.equal(ivan.rulesVersion, RULES_VERSION);
    assert.equal(ivan.decidedAt, '2026-09-10T02:00:00.000Z');
    assert.equal(ivan.reconTerminated, false);
    // A manager whose role ended still shows the company is his; an actual owner is no role the ladder reads.
    const georgi = readVerdict(cache, 'person:georgi|201122335');
    assert.equal(georgi.kind, 'document');
    assert.equal(georgi.registryRole, 'manager');
    assert.equal(georgi.roleEndedOn, '2019-01-01');
    assert.notEqual(readVerdict(cache, 'person:maria|201122335').kind, 'document');
    assert.equal(readVerdict(cache, 'person:ivan|201122336').kind, 'bar_joint_stock');
    assert.equal(readDeed(cache, '201122335').legalFormVerdict, 'closely_held');
    assert.equal(readDeed(cache, '201122335').seatNormalized, 'ПЛОВДИВ');
  } finally {
    cache.close();
  }
});

test('an ЕИК the register has no partida for is outside it; one the layer has not read gets no verdict', () => {
  const f = fixture();
  const logs = [];
  decide(f, logs);
  const cache = openCache(f.trDb);
  try {
    assert.equal(readVerdict(cache, 'person:ivan|000696327').kind, 'outside_tr');
    assert.equal(readDeed(cache, '000696327').status, 'outside_tr');
    // Not a false „unknown": an absent verdict is what the loader's floor counts.
    assert.equal(readVerdict(cache, 'person:ivan|201122337'), null);
    assert.equal(readDeed(cache, '201122337'), null);
  } finally {
    cache.close();
  }
  assert.ok(logs.some((l) => l.includes('not yet read: 201122337')));
  assert.ok(
    logs.every((l) => !l.includes('person:')),
    'a link key embeds an official’s name and never reaches the log',
  );
});

test('nothing decided against an earlier registry survives into a new run', () => {
  const f = fixture();
  const stale = openCache(f.trDb);
  upsertVerdict(stale, {
    linkKey: 'person:ivan|201122337',
    eik: '201122337',
    rulesVersion: RULES_VERSION,
    inputsHash: 'x',
    kind: 'document',
    publishable: true,
    registryRole: 'owner',
    matchedFact: 'role:owner:00190',
    entryNumber: null,
    entryDate: null,
    shortName: false,
    latinInName: false,
    decidedAt: '2026-01-01T00:00:00Z',
  });
  stale.close();
  decide(f);
  const cache = openCache(f.trDb);
  try {
    assert.equal(readVerdict(cache, 'person:ivan|201122337'), null);
  } finally {
    cache.close();
  }
});

test('readRegistry gives the standing natural persons of the roles the ladder reads', () => {
  const f = fixture();
  const src = new DatabaseSync(f.registryDb, { readOnly: true });
  try {
    const { registry, fetchedAt } = readRegistry(src, '201122335');
    assert.equal(fetchedAt, '2026-09-10T02:00:00Z');
    assert.deepEqual(
      registry.holders.map((h) => h.name),
      ['ИВАН ПЕТРОВ ТЕСТОВ'],
    );
    assert.deepEqual(readRegistry(src, '000696327'), {
      outsideTr: true,
      fetchedAt: '2026-09-08T02:00:00Z',
    });
    assert.equal(readRegistry(src, '201122337'), null);
  } finally {
    src.close();
  }
});

test('the link set is read through the loader’s own split, and a malformed line stops the run', () => {
  const f = fixture();
  const links = readLinksFile(f.linksFile);
  assert.equal(links.length, 6);
  assert.ok(links.every((l) => l.inputsHash && l.input.declarantName));
  const bad = path.join(f.dir, 'bad.jsonl');
  fs.writeFileSync(bad, '{"linkKey":"x"}\n');
  assert.throws(() => readLinksFile(bad), /linkKey and eik/);
  assert.throws(
    () => run({ argv: ['node', 'decide.mjs'], guard: () => {}, dbFile: f.trDb, log: () => {} }),
    /--links-file and --registry-db/,
  );
});
