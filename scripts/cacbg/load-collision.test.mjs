// Regression: the declaration id must be namespaced by FOLDER, not the bare xmlFile. The register splits
// a year across suffixed folders, so two DIFFERENT officials can carry declarations with the same xmlFile
// basename in different folders. Keying the declaration on `decl:${xmlFile}` alone collapses them under
// INSERT OR IGNORE — the second official's interests resolve to the FIRST official's declaration, crediting
// one person with the other's winner (cross-person mis-attribution, the exact libel failure this surface
// exists to prevent). `decl:${folder}:${xmlFile}` is unique by construction. This test fails on the bare key.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/load-collision.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
let dir, DB, STAGING, TR_DB, TR_RAW;

function runLoad() {
  execFileSync(
    'node',
    ['--import', path.join(HERE, 'register-ts.mjs'), path.join(HERE, 'load.mjs')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CACBG_DB: DB,
        CACBG_STAGING: STAGING,
        TR_CACHE_DB: TR_DB,
        TR_RAW_DIR: TR_RAW,
      },
      stdio: 'pipe',
    },
  );
}

/**
 * Minimal Trade Register evidence for this fixture (#279, ADR-0033). Publishing now rests on a registry
 * fact, so a loader test without a cache would only ever exercise the fail-closed path. Each winner's
 * deed names its own declarant as съдружник, which is the „Документ" rung.
 */
function buildTrCache(owners) {
  fs.mkdirSync(TR_RAW, { recursive: true });
  const cache = new DatabaseSync(TR_DB);
  cache.exec(`CREATE TABLE IF NOT EXISTS deeds (
    eik TEXT PRIMARY KEY, status TEXT NOT NULL, http_status INTEGER, fetched_at TEXT NOT NULL,
    raw_path TEXT, body_sha256 TEXT, legal_form_code INTEGER, legal_form_verdict TEXT,
    seat_normalized TEXT, seat_entry_date TEXT, latest_own_entry_date TEXT,
    attempts INTEGER NOT NULL DEFAULT 1, outside_reason TEXT)`);
  for (const [eik, spec] of Object.entries(owners)) {
    const { name, seat } = spec;
    const deed = {
      uic: eik,
      fullName: '"ФИКС" ЕООД',
      legalForm: 4,
      sections: [
        {
          subDeeds: [
            {
              groups: [
                {
                  fields: [
                    {
                      nameCode: 'CR_F_19_L',
                      htmlData: `<div class='record-container'><p class='field-text'>${name}</p></div>`,
                      fieldEntryNumber: '20110502101007',
                      fieldEntryDate: '2011-05-02T00:00:00',
                    },
                    // The REGISTERED seat, matching what this official declared. Both фирми here are
                    // generic („КОМПАНИЯ ЕДНО/ДВЕ" — two content words), so under ADR-0035 a name match
                    // alone cannot establish which company was declared; the agreeing seat is what does.
                    // Without it this fixture would exercise the withholding path instead of the
                    // cross-folder attribution it exists to test.
                    {
                      nameCode: 'CR_F_5_L',
                      htmlData: `<div class='record-container'><p class='field-text'>Държава: БЪЛГАРИЯ<br/>Населено място: гр. ${seat}</p></div>`,
                      fieldEntryNumber: '20110502101008',
                      fieldEntryDate: '2011-05-02T00:00:00',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(TR_RAW, `${eik}.json`), JSON.stringify(deed));
    cache
      .prepare(
        'INSERT OR REPLACE INTO deeds(eik,status,http_status,fetched_at,raw_path,legal_form_code,legal_form_verdict,latest_own_entry_date) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        eik,
        'fetched',
        200,
        '2026-08-05T00:00:00Z',
        `${eik}.json`,
        4,
        'closely_held',
        '2011-05-02',
      );
  }
  cache.close();
}
const open = () => new DatabaseSync(DB, { readOnly: true });

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-collision-'));
  TR_DB = path.join(dir, 'tr-cache.sqlite');
  TR_RAW = path.join(dir, 'tr-deeds');
  DB = path.join(dir, 'fixture.sqlite');
  STAGING = path.join(dir, 'staging');
  fs.mkdirSync(STAGING, { recursive: true });

  const db = new DatabaseSync(DB);
  db.exec(`
    CREATE TABLE bidders(id TEXT PRIMARY KEY, name TEXT, eik_normalized TEXT, eik_valid INT, settlement TEXT);
    CREATE TABLE authorities(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE tenders(id TEXT PRIMARY KEY, authority_id TEXT);
    CREATE TABLE contracts(id TEXT PRIMARY KEY, tender_id TEXT, bidder_id TEXT, signed_at TEXT, amount_eur REAL);
    INSERT INTO authorities VALUES ('auth:1','ВЕДОМСТВО ТЕСТ');
    INSERT INTO tenders VALUES ('t1','auth:1'),('t2','auth:1');
    -- Two distinct single-ЕИК winners, each named in its own deed AND seat-corroborated → both publish.
    INSERT INTO bidders VALUES ('eik:100000001','КОМПАНИЯ ЕДНО ЕООД','100000001',1,'София');
    INSERT INTO bidders VALUES ('eik:200000002','КОМПАНИЯ ДВЕ ЕООД','200000002',1,'Пловдив');
    INSERT INTO contracts VALUES ('c1','t1','eik:100000001','2021-05-01',50000);
    INSERT INTO contracts VALUES ('c2','t2','eik:200000002','2022-06-01',60000);
  `);

  const SAME = 'DECL.xml'; // identical basename, DIFFERENT folders — the collision trigger
  const holdings = [
    {
      folder: '2021',
      xmlFile: SAME,
      year: '2021',
      template: 'assets',
      category: '',
      institution: 'ОБЩИНА ЕДНА',
      person: 'Иван Първи Тестов',
      position: 'Кмет',
      entity: 'КОМПАНИЯ ЕДНО ЕООД',
      kind: 'shares',
      detail: '40%',
      timing: 'annual',
      seat: 'София',
      controlHash: 'H1',
    },
    {
      folder: '2022',
      xmlFile: SAME,
      year: '2022',
      template: 'assets',
      category: '',
      institution: 'МИНИСТЕРСТВО ДВЕ',
      person: 'Петър Втори Пробен',
      position: 'Директор',
      entity: 'КОМПАНИЯ ДВЕ ЕООД',
      kind: 'shares',
      detail: '30%',
      timing: 'annual',
      seat: 'Пловдив',
      controlHash: 'H2',
    },
  ];
  fs.writeFileSync(
    path.join(STAGING, 'holdings.jsonl'),
    holdings.map((h) => JSON.stringify(h)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(STAGING, 'related.jsonl'), '');

  buildTrCache({
    100000001: { name: 'ИВАН ПЪРВИ ТЕСТОВ', seat: 'София' },
    200000002: { name: 'ПЕТЪР ВТОРИ ПРОБЕН', seat: 'Пловдив' },
  });
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('same xmlFile in different folders → two declarations, each winner to its OWN official (no collision)', () => {
  runLoad();
  const db = open();

  // Both declarations survive — the bare-key collapse would drop the second under INSERT OR IGNORE.
  const decls = db.prepare('SELECT COUNT(*) AS n FROM declarations').get();
  assert.equal(decls.n, 2, 'both folder-distinct declarations persisted');

  // Each winner is attributed to the correct, distinct official — never both to the first one.
  const linkFor = (eik) =>
    db.prepare('SELECT person_id, status FROM interest_links WHERE eik = ?').get(eik);
  const one = linkFor('100000001');
  const two = linkFor('200000002');
  assert.ok(one, 'winner ЕДНО has a link');
  assert.ok(two, 'winner ДВЕ has a link');
  assert.equal(one.status, 'published');
  assert.equal(two.status, 'published');
  assert.notEqual(
    one.person_id,
    two.person_id,
    'the two winners belong to two different officials — no cross-folder mis-attribution',
  );

  // And each person_id resolves to the right name via their own declaration.
  const nameOf = (pid) => db.prepare('SELECT name FROM persons WHERE id = ?').get(pid).name;
  assert.equal(nameOf(one.person_id), 'Иван Първи Тестов');
  assert.equal(nameOf(two.person_id), 'Петър Втори Пробен');
});
