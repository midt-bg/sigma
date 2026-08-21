// Regression: the person grain must NOT be a bare normalized name. Two DISTINCT officials who share a name
// („Георги Иванов") at DIFFERENT institutions are two different people; keying persons on the bare name key
// merges them into ONE `/conflicts/official/:slug` page that shows BOTH their companies — false attribution
// (one official credited with the other's conflict), a libel vector (spec §4: „homonym merge is the failure
// to avoid"). The id is anchored on (name, institution) so cross-institution namesakes stay distinct. The
// control proves the opposite failure is not introduced: the SAME official filing the SAME winner across two
// years stays ONE person (institution+name is stable across years — required for the E11 divestment horizon,
// which keys on person_id and must span a person's filings).
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/load-homonym.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { seedVerdicts, readFixtureDeed } from './tr-fixture.mjs';

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
 * deed names its own declarant as съдружник — the „Документ" rung.
 */
function buildTrCache(owners) {
  fs.mkdirSync(TR_RAW, { recursive: true });
  const cache = new DatabaseSync(TR_DB);
  cache.exec(`CREATE TABLE IF NOT EXISTS deeds (
    eik TEXT PRIMARY KEY, status TEXT NOT NULL, http_status INTEGER, fetched_at TEXT NOT NULL,
    raw_path TEXT, body_sha256 TEXT, legal_form_code INTEGER, legal_form_verdict TEXT,
    seat_normalized TEXT, seat_entry_date TEXT, latest_own_entry_date TEXT,
    attempts INTEGER NOT NULL DEFAULT 1, outside_reason TEXT)`);
  for (const [eik, names] of Object.entries(owners)) {
    const html = []
      .concat(names)
      .map((n) => `<div class='record-container'><p class='field-text'>${n}</p></div>`)
      .join(`<hr class='hr--report' />`);
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
                      htmlData: html,
                      fieldEntryNumber: '20110502101007',
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

  // The deeds alone decide nothing since ADR-0037: the verdict is reached by the crawler and the
  // loader only reads it. Run the REAL decision over these fixture deeds so this test keeps
  // exercising the evidence ladder rather than a hand-written verdict row.
  seedVerdicts({
    workDb: DB,
    staging: STAGING,
    trDb: TR_DB,
    deedFor: (eik) => readFixtureDeed(TR_RAW, eik),
  });
}

const open = () => new DatabaseSync(DB, { readOnly: true });

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-homonym-'));
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
    -- Two distinct single-ЕИК winners, both seat-confirmed → published (A_seat), no ambiguity.
    INSERT INTO bidders VALUES ('eik:100000001','ВИН ЕДНО 5 ЕООД','100000001',1,'София');
    INSERT INTO bidders VALUES ('eik:200000002','ВИН ДВЕ 6 ЕООД','200000002',1,'Пловдив');
    INSERT INTO contracts VALUES ('c1','t1','eik:100000001','2021-05-01',50000);
    INSERT INTO contracts VALUES ('c2','t2','eik:200000002','2021-06-01',60000);
  `);

  const holdings = [
    // Namesake A: „Георги Иванов" at ОБЩИНА СОФИЯ owns winner ВИН ЕДНО 5 (seat София → published).
    {
      folder: '2022',
      xmlFile: 'GI_A.xml',
      year: '2021',
      template: 'assets',
      category: '',
      institution: 'ОБЩИНА СОФИЯ',
      person: 'Георги Иванов Петров',
      position: 'Кмет',
      entity: 'ВИН ЕДНО 5 ЕООД',
      kind: 'shares',
      detail: '40%',
      timing: 'annual',
      seat: 'София',
      controlHash: 'A1',
    },
    // Namesake B: a DIFFERENT „Георги Иванов" at МИНИСТЕРСТВО НА ТЕСТА owns winner ВИН ДВЕ 6 (seat Пловдив).
    // Bare-name keying would merge A and B into one person carrying BOTH winners → misattribution.
    {
      folder: '2022',
      xmlFile: 'GI_B.xml',
      year: '2021',
      template: 'assets',
      category: '',
      institution: 'МИНИСТЕРСТВО НА ТЕСТА',
      person: 'Георги Иванов Петров',
      position: 'Директор',
      entity: 'ВИН ДВЕ 6 ЕООД',
      kind: 'shares',
      detail: '30%',
      timing: 'annual',
      seat: 'Пловдив',
      controlHash: 'B1',
    },
    // Control: namesake A files AGAIN in a later year, same institution, same winner. Must stay the SAME
    // person as the 2021 A row (one page, one link spanning 2021–2023), not split by year.
    {
      folder: '2024',
      xmlFile: 'GI_A2.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'ОБЩИНА СОФИЯ',
      person: 'Георги Иванов Петров',
      position: 'Кмет',
      entity: 'ВИН ЕДНО 5 ЕООД',
      kind: 'shares',
      detail: '40%',
      timing: 'annual',
      seat: 'София',
      controlHash: 'A2',
    },
  ];
  fs.writeFileSync(
    path.join(STAGING, 'holdings.jsonl'),
    holdings.map((h) => JSON.stringify(h)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(STAGING, 'related.jsonl'), '');

  buildTrCache({
    100000001: 'ГЕОРГИ ИВАНОВ ПЕТРОВ',
    200000002: 'ГЕОРГИ ИВАНОВ ПЕТРОВ',
  });
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('same-named officials at different institutions do NOT merge into one person (homonym libel guard)', () => {
  runLoad();
  const db = open();

  // Two DISTINCT persons named „Георги Иванов" — one per institution — never one merged identity.
  const persons = db
    .prepare("SELECT id, name FROM persons WHERE name = 'Георги Иванов Петров' ORDER BY id")
    .all();
  assert.equal(persons.length, 2, 'two distinct namesake officials, not one merged person');
  assert.notEqual(persons[0].id, persons[1].id);
  // Person id is NOT the bare name key (that would be a single shared id).
  assert.notEqual(persons[0].id, 'person:георгииванов');

  // Each person carries exactly their OWN winner — no cross-attribution.
  const linkFor = (eik) =>
    db.prepare('SELECT person_id, status FROM interest_links WHERE eik = ?').get(eik);
  const a = linkFor('100000001');
  const b = linkFor('200000002');
  assert.equal(a.status, 'published');
  assert.equal(b.status, 'published');
  assert.notEqual(a.person_id, b.person_id, 'the two winners belong to different people');

  // Control: namesake A's two-year filings (2021 + 2023) are ONE person and ONE link spanning the window —
  // institution+name is stable across years, so identity is not fragmented (and the divestment horizon,
  // which keys on person_id, still sees both filings).
  const aLink = db
    .prepare('SELECT first_declared_year, last_declared_year FROM interest_links WHERE eik = ?')
    .get('100000001');
  assert.equal(aLink.first_declared_year, '2021');
  assert.equal(aLink.last_declared_year, '2023');
});
