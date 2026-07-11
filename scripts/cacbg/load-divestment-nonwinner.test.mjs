// Regression: the E11 divestment horizon must advance on EVERY material ownership filing, not only the ones
// that resolve to a contract winner. Most declared holdings are ordinary (non-winner) companies; if the
// horizon only advanced on winner-resolved holdings, an official who divested a winner-stake and then kept
// filing — listing only non-winner companies — would never advance the horizon, so the stale winner link
// would keep asserting a CURRENT stake (a false, libel-adjacent present-tense claim). load.test.mjs already
// covers the winner→winner case (Николай ДИВЕСТ 1→2, both winners); this covers the winner→NON-winner gap.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/load-divestment-nonwinner.test.mjs
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
let dir, DB, STAGING;

function runLoad() {
  execFileSync(
    'node',
    ['--import', path.join(HERE, 'register-ts.mjs'), path.join(HERE, 'load.mjs')],
    {
      cwd: ROOT,
      env: { ...process.env, CACBG_DB: DB, CACBG_STAGING: STAGING },
      stdio: 'pipe',
    },
  );
}
const open = () => new DatabaseSync(DB, { readOnly: true });

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-divest-'));
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
      person: 'Диан Дивестов',
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
      person: 'Диан Дивестов',
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
      person: 'Верен Държателев',
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

  const dian = link('100000001', 'Диан Дивестов');
  const veren = link('200000002', 'Верен Държателев');

  // The divested winner stake is dated to its last declaration and excluded from the public surface.
  assert.equal(dian.status, 'withdrawn');
  assert.equal(dian.last_declared_year, '2019');
  // The control stake — no later filing to contradict it — remains current. (Guards against over-withdrawal.)
  assert.equal(veren.status, 'published');
});
