// Regression: the E11 divestment horizon must advance on EVERY later declaration OF THE SAME TYPE, not only
// the ones that resolve to a contract winner. Most declared holdings are ordinary (non-winner) companies; a
// later declaration listing only non-winner companies still writes a filing record (extract.mjs emits one per
// declaration), so the per-(person,type) filing horizon advances and the stale winner link is withdrawn — it
// must not keep asserting a CURRENT stake (a false, libel-adjacent present-tense claim). The horizon is
// per-declaration-type (#226): a later same-type filing counts; a different-type one does not. load.test.mjs
// covers winner→winner (Николай) and the cross-type keep (Интер); this covers the winner→NON-winner gap.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/load-divestment-nonwinner.test.mjs
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-divest-'));
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
    -- Two distinctive single-ЕИК winners (number token + matching seat → published, no ambiguity).
    INSERT INTO bidders VALUES ('eik:100000001','ДИВ ТЕХ 5 ЕООД','100000001',1,'София');
    INSERT INTO bidders VALUES ('eik:200000002','ДРУГ ВИН 6 ЕООД','200000002',1,'София');
    INSERT INTO contracts VALUES ('c1','t1','eik:100000001','2019-05-01',50000);
    INSERT INTO contracts VALUES ('c2','t2','eik:200000002','2019-06-01',60000);
  `);

  const holdings = [
    // Диан owns winner ДИВ ТЕХ 5 in 2019, then files a 2022 ownership declaration listing ONLY a NON-winner
    // (НЕПОБЕДИМ, not in bidders → does not resolve). The winner-stake was divested; without the fix the
    // 2022 filing never advances his horizon, so ДИВ ТЕХ 5 wrongly stays 'published'.
    {
      folder: '2020',
      xmlFile: 'DIAN19.xml',
      year: '2019',
      template: 'assets',
      category: '',
      institution: 'T',
      person: 'Диан Иванов Дивестов',
      position: '',
      entity: 'ДИВ ТЕХ 5 ЕООД',
      kind: 'shares',
      detail: '40%',
      timing: 'annual',
      seat: 'София',
      controlHash: 'D1',
    },
    {
      folder: '2023',
      xmlFile: 'DIAN22.xml',
      year: '2022',
      template: 'assets',
      category: '',
      institution: 'T',
      person: 'Диан Иванов Дивестов',
      position: '',
      entity: 'НЕПОБЕДИМ КОМПАНИ ООД',
      kind: 'shares',
      detail: '30%',
      timing: 'annual',
      seat: '',
      controlHash: 'D2',
    },
    // Control: Верен owns winner ДРУГ ВИН 6 in 2019 and NEVER files again → still current → must stay
    // 'published'. Proves the broadened horizon withdraws the divested stake WITHOUT over-withdrawing a
    // stake that simply has no later filing.
    {
      folder: '2020',
      xmlFile: 'VEREN19.xml',
      year: '2019',
      template: 'assets',
      category: '',
      institution: 'T',
      person: 'Верен Иванов Държателев',
      position: '',
      entity: 'ДРУГ ВИН 6 ЕООД',
      kind: 'shares',
      detail: '25%',
      timing: 'annual',
      seat: 'София',
      controlHash: 'V1',
    },
  ];
  fs.writeFileSync(
    path.join(STAGING, 'holdings.jsonl'),
    holdings.map((h) => JSON.stringify(h)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(STAGING, 'related.jsonl'), '');

  buildTrCache({
    // Диан DIVESTED, so the live deed must name somebody else — otherwise §7's reconciliation
    // correctly overturns his declared termination and the case stops testing what it is for.
    100000001: 'НОВ ИВАНОВ СОБСТВЕНИК',
    200000002: 'ВЕРЕН ИВАНОВ ДЪРЖАТЕЛЕВ',
  });
  // filings.jsonl — one record per declaration (as extract.mjs emits it), carrying the declaration type. The
  // divest horizon is built from this: Диан's 2022 assets declaration (listing only the non-winner) advances
  // his assets horizon to 2022 → the 2019 ДИВ ТЕХ 5 winner stake is withdrawn. Верен has only a 2019 filing.
  const filings = holdings.map((h) => ({
    folder: h.folder,
    xmlFile: h.xmlFile,
    year: h.year,
    template: h.template,
    person: h.person,
    institution: h.institution,
  }));
  fs.writeFileSync(
    path.join(STAGING, 'filings.jsonl'),
    filings.map((f) => JSON.stringify(f)).join('\n') + '\n',
  );
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a later NON-winner ownership filing still withdraws a divested winner stake (E11 horizon)', () => {
  runLoad();
  const db = open();
  const link = (eik, person) =>
    db
      .prepare(
        'SELECT il.* FROM interest_links il JOIN persons p ON p.id=il.person_id WHERE il.eik=? AND p.name=?',
      )
      .get(eik, person);

  const dian = link('100000001', 'Диан Иванов Дивестов');
  const veren = link('200000002', 'Верен Иванов Държателев');

  // The divested winner stake is dated to its last declaration and excluded from the public surface.
  assert.equal(dian.status, 'withdrawn');
  assert.equal(dian.last_declared_year, '2019');
  // The control stake — no later filing to contradict it — remains current. (Guards against over-withdrawal.)
  assert.equal(veren.status, 'published');
});
