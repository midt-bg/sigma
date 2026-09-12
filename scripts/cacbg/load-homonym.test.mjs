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
import { seedVerdicts, fixtureRegistry } from './tr-fixture.mjs';
import { canonicalInstitution, identityInstitution } from './institutions.mjs';

const { companyNameKey } = await import('../../packages/shared/src/company-name-key.ts');

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
 * Minimal Trade Register evidence for this fixture (#279, ADR-0033). Publishing rests on a registry fact,
 * so a loader test without verdicts would only ever exercise the fail-closed path. Each winner's registry
 * facts name its own declarant as съдружник — the „Документ" rung.
 */
function buildTrCache(owners) {
  seedVerdicts({
    workDb: DB,
    staging: STAGING,
    trDb: TR_DB,
    registryFor: (eik) =>
      eik in owners
        ? {
            registry: fixtureRegistry(eik, {
              owners: [].concat(owners[eik]),
              form: 4,
              suffix: 'ЕООД',
            }),
          }
        : null,
  });
}

const open = () => new DatabaseSync(DB, { readOnly: true });

// The official's id under the grain before ADR-0040 (listing institution, abbreviations only) and now.
const LEGACY_PID = `person:${companyNameKey('Мария Петрова Иванова')}|${companyNameKey(canonicalInstitution('Встъпителни и финални декларации'))}`;
const CURRENT_PID = `person:${companyNameKey('Мария Петрова Иванова')}|${companyNameKey(identityInstitution('Община Ямбол'))}`;

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
    INSERT INTO tenders VALUES ('t3','auth:1');
    INSERT INTO bidders VALUES ('eik:300000003','ВИН ТРИ 7 ЕООД','300000003',1,'Ямбол');
    INSERT INTO contracts VALUES ('c3','t3','eik:300000003','2023-06-01',70000);
  `);
  // ADR-0040: a claim published last run under the id the OLD grain gave the official — the listing's
  // declaration-type node. The loader must carry it to her current id, not report it as gone.
  db.exec(
    fs.readFileSync(
      path.join(ROOT, 'packages/db/migrations/0003_related_persons_foundation.sql'),
      'utf8',
    ),
  );
  db.exec(
    fs.readFileSync(
      path.join(ROOT, 'packages/db/migrations/0009_interest_link_evidence.sql'),
      'utf8',
    ),
  );
  db.prepare('INSERT INTO persons (id, name) VALUES (?, ?)').run(
    LEGACY_PID,
    'Мария Петрова Иванова',
  );
  db.prepare(
    `INSERT INTO interest_links (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version,
       publish_tier, relation, interest_class, contemporaneous, own_institution, evidence_count,
       first_declared_year, last_declared_year, contract_count, contract_value_eur, status)
     VALUES ('il:prior', ?, ?, 'eik:300000003', '300000003', 'ВИН ТРИ 7 ЕООД', 'exact_name_key', 'v1',
       'A_seat', 'owns', 'private_ownership', 1, 'none', 1, '2023', '2023', 1, 70000, 'published')`,
  ).run(`${LEGACY_PID}|300000003`, LEGACY_PID);
  db.prepare(
    `INSERT INTO interest_link_evidence (link_key, evidence_kind, registry_role, matched_fact, lookup_date,
       rules_version, live_status) VALUES (?, 'document', 'owner', 'role:owner:CR_F_19_L', '2026-08-05', 'tr-rules-2', 'live')`,
  ).run(`${LEGACY_PID}|300000003`);

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
    // ADR-0040: the same official filed in a declaration-TYPE folder (the listing node is the type; her
    // institution is only in the declaration's own „Месторабота") and in her municipality's own folder
    // under another spelling. One person, one link.
    {
      folder: '2023f1',
      xmlFile: 'MP_IN.xml',
      year: '2023',
      template: 'assets',
      category: 'Встъпителни и финални декларации',
      institution: 'Встъпителни и финални декларации',
      work: 'Община Ямбол',
      person: 'Мария Петрова Иванова',
      position: 'Общински съветник',
      entity: 'ВИН ТРИ 7 ЕООД',
      kind: 'shares',
      detail: '50%',
      timing: 'annual',
      seat: 'Ямбол',
      controlHash: 'M1',
    },
    {
      folder: '2024',
      xmlFile: 'MP_AN.xml',
      year: '2024',
      template: 'assets',
      category: 'Кметове и общински съветници',
      institution: 'Ямбол',
      work: 'ОбС Ямбол',
      person: 'Мария Петрова Иванова',
      position: 'Общински съветник',
      entity: 'ВИН ТРИ 7 ЕООД',
      kind: 'shares',
      detail: '50%',
      timing: 'annual',
      seat: 'Ямбол',
      controlHash: 'M2',
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
    300000003: 'МАРИЯ ПЕТРОВА ИВАНОВА',
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

test('the own institution keys the official and the audit claim carries without URL redirects', () => {
  const db = open();
  const ids = db
    .prepare('SELECT id FROM persons WHERE name = ?')
    .all('Мария Петрова Иванова')
    .map((p) => p.id);
  assert.deepEqual(
    ids,
    [CURRENT_PID],
    'one official, keyed on her municipality — not on the declaration type',
  );
  assert.equal(
    db.prepare("SELECT institution FROM declarations WHERE xml_file = 'MP_IN.xml'").get()
      .institution,
    'Община Ямбол',
    'the stored (and shown) institution is the declaration’s own',
  );
  const links = db.prepare("SELECT status FROM interest_links WHERE eik = '300000003'").all();
  assert.deepEqual(
    links.map((l) => l.status),
    ['published'],
  );

  const redirects = db.prepare('SELECT old_id, new_id FROM person_redirects').all();
  assert.deepEqual(redirects, [], 'this unreleased installation needs no legacy URL aliases');

  const snap = JSON.parse(fs.readFileSync(path.join(STAGING, 'published-snapshot.json'), 'utf8'));
  const keys = snap.map((p) => p.link_key);
  assert.ok(
    keys.includes(`${CURRENT_PID}|300000003`),
    'the prior claim is carried to the current id',
  );
  assert.ok(!keys.some((k) => k.startsWith(`${LEGACY_PID}|`)), 'nothing is left under the old id');
});
