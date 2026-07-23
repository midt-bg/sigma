// Integration test for the Phase-1 loader/resolver — the publish-decision (libel) surface.
// Builds a fixture winner set + staging, runs load.mjs as a subprocess, asserts what gets published,
// held, quarantined, and suppressed. Run: node --test scripts/cacbg/load.test.mjs
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-load-'));
  DB = path.join(dir, 'fixture.sqlite');
  STAGING = path.join(dir, 'staging');
  fs.mkdirSync(STAGING, { recursive: true });

  // minimal slice of the winner schema that load.mjs joins
  const db = new DatabaseSync(DB);
  db.exec(`
    CREATE TABLE bidders(id TEXT PRIMARY KEY, name TEXT, eik_normalized TEXT, eik_valid INT, settlement TEXT);
    CREATE TABLE authorities(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE tenders(id TEXT PRIMARY KEY, authority_id TEXT);
    CREATE TABLE contracts(id TEXT PRIMARY KEY, tender_id TEXT, bidder_id TEXT, signed_at TEXT, amount_eur REAL);
    -- auth:3 is a ';'-joined framework blob whose component matches Иван's institution → tests the split
    INSERT INTO authorities VALUES ('auth:1','ТЕСТ ВЕДОМСТВО'),('auth:2','ДРУГО ВЕДОМСТВО'),('auth:3','ОБЩИНА А; ТЕСТ ВЕДОМСТВО; ОБЩИНА Б');
    INSERT INTO tenders VALUES ('t1','auth:1'),('t2','auth:2'),('t3','auth:3');
    -- distinctive winner (number token) → tier B
    INSERT INTO bidders VALUES ('eik:111111119','ДИСТИНКТ ТЕХ 7 ЕООД','111111119',1,'София');
    -- generic name shared by TWO ЕИК → collision, must be quarantined
    INSERT INTO bidders VALUES ('eik:222222229','ГЕНЕРИК ООД','222222229',1,'Пловдив');
    INSERT INTO bidders VALUES ('eik:333333338','Генерик ООД','333333338',1,'Варна');
    -- generic single-ЕИК winner with a seat → tier A when declared seat matches, tier C when not
    INSERT INTO bidders VALUES ('eik:444444447','СИЙ ЕООД','444444447',1,'Бургас');
    INSERT INTO contracts VALUES ('c1','t1','eik:111111119','2023-05-01',100000); -- ДИСТИНКТ ← ТЕСТ ВЕДОМСТВО
    INSERT INTO contracts VALUES ('c3','t3','eik:111111119','2024-06-01',25000);  -- ДИСТИНКТ ← blob (own via split)
    INSERT INTO contracts VALUES ('c2','t2','eik:444444447','2022-03-01',50000);
    -- both colliding ГЕНЕРИК ЕИК are real winners → declared_eik can resolve a certain ЕИК behind an ambiguous name
    INSERT INTO contracts VALUES ('c4','t2','eik:222222229','2023-07-01',70000);
    INSERT INTO contracts VALUES ('c5','t2','eik:333333338','2023-08-01',80000);
    -- distinctive winner MANAGED by two different officials → ex-officio public board (ADR-0019)
    INSERT INTO bidders VALUES ('eik:555555556','ХОЛДИНГ 9 ЕАД','555555556',1,'София');
    INSERT INTO contracts VALUES ('c6','t1','eik:555555556','2023-09-01',500000);
    -- two distinctive winners for the divestment (E11) case: Николай owns ДИВЕСТ 1 in 2019, then ДИВЕСТ 2
    -- in 2022 — his later ownership filing omits ДИВЕСТ 1, so that stake is withdrawn (divested), ДИВЕСТ 2 stays.
    INSERT INTO bidders VALUES ('eik:666666665','ДИВЕСТ 1 ЕООД','666666665',1,'София');
    INSERT INTO bidders VALUES ('eik:777777773','ДИВЕСТ 2 ЕООД','777777773',1,'София');
    INSERT INTO contracts VALUES ('c7','t1','eik:666666665','2019-04-01',300000);
    INSERT INTO contracts VALUES ('c8','t1','eik:777777773','2022-04-01',400000);
    -- FAMILY case: a close relative of Кмет owns ЕВРОСТРОЙ 21 ЕООД, which won from Кмет's OWN institution (ОБЩИНА ТЕСТ)
    INSERT INTO authorities VALUES ('auth:4','ОБЩИНА ТЕСТ');
    INSERT INTO tenders VALUES ('t4','auth:4');
    INSERT INTO bidders VALUES ('eik:888888884','ЕВРОСТРОЙ 21 ЕООД','888888884',1,'София');
    INSERT INTO contracts VALUES ('c9','t4','eik:888888884','2023-06-01',250000);
    -- SECURITIES case: a self holding of LISTED joint-stock shares — must NOT become an ownership link
    INSERT INTO bidders VALUES ('eik:999999998','ЛИСТЕД ТЕСТ АД','999999998',1,'София');
    INSERT INTO contracts VALUES ('c10','t1','eik:999999998','2023-06-01',60000);
  `);
  db.close();

  const holdings = [
    // Иван manages the distinctive winner, from his OWN institution, in a contract year → published/B/manages/exact/contemporaneous
    {
      folder: '2024',
      xmlFile: 'A.xml',
      year: '2023',
      template: 'interests',
      category: '',
      institution: 'ТЕСТ ВЕДОМСТВО',
      person: 'Иван Петров Тестов',
      position: 'директор',
      entity: 'ДИСТИНКТ ТЕХ 7 ЕООД',
      kind: 'management',
      detail: 'управител',
      timing: 'current',
      seat: '',
      controlHash: 'H1',
    },
    // Мария declares the collision name → 2 ЕИК → quarantined, NO link
    {
      folder: '2024',
      xmlFile: 'B.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'X',
      person: 'Мария Иванова',
      position: '',
      entity: '"ГЕНЕРИК" ООД',
      kind: 'shares',
      detail: '50%',
      timing: 'annual',
      seat: 'Пловдив',
      controlHash: 'H2',
    },
    // Петър owns the generic winner AND declares matching seat Бургас → tier A (seat-confirmed) published
    {
      folder: '2024',
      xmlFile: 'C.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'Y',
      person: 'Петър Николов',
      position: '',
      entity: 'СИЙ ЕООД',
      kind: 'shares',
      detail: '10%',
      timing: 'annual',
      seat: 'Бургас',
      controlHash: 'H3',
    },
    // Георги owns the same generic winner but NO seat → tier C held
    {
      folder: '2024',
      xmlFile: 'D.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'Z',
      person: 'Георги Стоянов',
      position: '',
      entity: 'СИЙ ЕООД',
      kind: 'shares',
      detail: '5%',
      timing: 'annual',
      seat: '',
      controlHash: 'H4',
    },
    // Стефан writes a CERTAIN ЕИК (222222229) behind a COLLIDING name, no seat → declared_eik resolves the
    // right company; the declarant-provided ЕИК is the national unique identifier, so identity is
    // deterministic and the link publishes on its own basis (A_eik), even though the name maps to 2 ЕИК
    {
      folder: '2024',
      xmlFile: 'E.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'W',
      person: 'Стефан Колев',
      position: '',
      entity: '"ГЕНЕРИК" ООД, ЕИК 222222229',
      kind: 'shares',
      detail: '20%',
      timing: 'annual',
      seat: '',
      controlHash: 'H5',
    },
    // Радка writes the other certain ЕИК (333333338) AND its town Варна → declared_eik resolves the collision → A_eik
    {
      folder: '2024',
      xmlFile: 'F.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'V',
      person: 'Радка Илиева',
      position: '',
      entity: '"ГЕНЕРИК" ООД, ЕИК 333333338',
      kind: 'shares',
      detail: '30%',
      timing: 'annual',
      seat: 'Варна',
      controlHash: 'H6',
    },
    // Борис and Виктор BOTH manage ХОЛДИНГ 9 (no ownership) → two declarants of one company = ex_officio_board
    {
      folder: '2024',
      xmlFile: 'G.xml',
      year: '2023',
      template: 'interests',
      category: '',
      institution: 'U',
      person: 'Борис Манолов',
      position: 'член на съвет',
      entity: 'ХОЛДИНГ 9 ЕАД',
      kind: 'management',
      detail: 'член на надзорен съвет',
      timing: 'current',
      seat: '',
      controlHash: 'H7',
    },
    {
      folder: '2024',
      xmlFile: 'H.xml',
      year: '2023',
      template: 'interests',
      category: '',
      institution: 'U',
      person: 'Виктор Асенов',
      position: 'член на съвет',
      entity: 'ХОЛДИНГ 9 ЕАД',
      kind: 'management',
      detail: 'член на надзорен съвет',
      timing: 'current',
      seat: '',
      controlHash: 'H8',
    },
    // Николай owns ДИВЕСТ 1 in 2019, then files an ownership declaration in 2022 listing only ДИВЕСТ 2 →
    // ДИВЕСТ 1 divested (withdrawn/E11); ДИВЕСТ 2 still current (published).
    {
      folder: '2020',
      xmlFile: 'I.xml',
      year: '2019',
      template: 'assets',
      category: '',
      institution: 'T',
      person: 'Николай Дивестов',
      position: '',
      entity: 'ДИВЕСТ 1 ЕООД',
      kind: 'shares',
      detail: '40%',
      timing: 'annual',
      seat: '',
      controlHash: 'H9',
    },
    {
      folder: '2023',
      xmlFile: 'J.xml',
      year: '2022',
      template: 'assets',
      category: '',
      institution: 'T',
      person: 'Николай Дивестов',
      position: '',
      entity: 'ДИВЕСТ 2 ЕООД',
      kind: 'shares',
      detail: '60%',
      timing: 'annual',
      seat: '',
      controlHash: 'H10',
    },
    // FAMILY: Кмет declares a CLOSE RELATIVE's stake (holderRelation:'related') in ЕВРОСТРОЙ 21 ЕООД, a winner that
    // sold to Кмет's OWN institution → family_ownership, own_institution exact. Relative's name never in staging.
    {
      folder: '2024',
      xmlFile: 'K.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'ОБЩИНА ТЕСТ',
      person: 'Кмет Тестов',
      position: 'кмет',
      entity: 'ЕВРОСТРОЙ 21 ЕООД',
      kind: 'shares',
      detail: '100%',
      timing: 'annual',
      seat: '',
      holderRelation: 'related',
      controlHash: 'H11',
    },
    // SECURITIES: Акционер holds LISTED joint-stock shares (kind securities) → excluded, no ownership link.
    {
      folder: '2024',
      xmlFile: 'L.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'S',
      person: 'Акционер Тестов',
      position: '',
      entity: 'ЛИСТЕД ТЕСТ АД',
      kind: 'securities',
      detail: '25',
      timing: 'annual',
      seat: '',
      holderRelation: 'self',
      controlHash: 'H12',
    },
  ];
  fs.writeFileSync(
    path.join(STAGING, 'holdings.jsonl'),
    holdings.map((h) => JSON.stringify(h)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(STAGING, 'related.jsonl'), '');
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('resolves publish/held/quarantine tiers deterministically', () => {
  runLoad();
  const db = open();
  const link = (eik, person) =>
    db
      .prepare(
        'SELECT il.* FROM interest_links il JOIN persons p ON p.id=il.person_id WHERE il.eik=? AND p.name=?',
      )
      .get(eik, person);

  const ivan = link('111111119', 'Иван Петров Тестов');
  // management_role never surfaces → status 'internal', NOT 'published' (a direct D1 reader must not see a
  // non-surfaced official+company row labelled published; the served query also filters by interest_class).
  assert.equal(ivan.status, 'internal');
  assert.equal(ivan.publish_tier, 'B_distinctive');
  assert.equal(ivan.relation, 'manages');
  assert.equal(ivan.interest_class, 'management_role'); // manages, sole declarant → ambiguous, not headline
  assert.equal(ivan.own_institution, 'exact');
  assert.equal(ivan.contemporaneous, 1);
  // contract facts: both of ДИСТИНКТ's contracts summed deterministically
  assert.equal(ivan.contract_count, 2);
  assert.equal(ivan.contract_value_eur, 125000);
  assert.equal(ivan.first_contract_year, '2023');
  // semicolon-blob authority matched by component split → own='exact', with its value
  const blob = db
    .prepare("SELECT * FROM interest_link_authorities WHERE link_key=? AND authority_id='auth:3'")
    .get(ivan.link_key);
  assert.equal(blob.own, 'exact');
  assert.equal(blob.value_eur, 25000);

  // bare collision name (no ЕИК in text) → quarantined, Мария gets no link
  assert.equal(link('222222229', 'Мария Иванова'), undefined);
  assert.equal(link('333333338', 'Мария Иванова'), undefined);
  // the only links onto the colliding ЕИК come from declared_eik (Стефан/Радка), never exact_name_key
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM interest_links WHERE eik IN (?,?) AND match_method='exact_name_key'",
      )
      .get('222222229', '333333338').n,
    0,
  );

  const petar = link('444444447', 'Петър Николов');
  assert.equal(petar.publish_tier, 'A_seat'); // generic name rescued by seat match
  assert.equal(petar.status, 'published');
  assert.equal(petar.interest_class, 'private_ownership'); // declared a share → the headline conflict signal

  // two officials manage the SAME company → deterministically classed ex-officio (public board), not private
  const boris = link('555555556', 'Борис Манолов');
  const viktor = link('555555556', 'Виктор Асенов');
  assert.equal(boris.interest_class, 'ex_officio_board');
  assert.equal(viktor.interest_class, 'ex_officio_board');
  assert.equal(boris.relation, 'manages');
  // ex_officio_board never surfaces → stored 'internal', not 'published' (self-describing D1; fails safe)
  assert.equal(boris.status, 'internal');
  assert.equal(viktor.status, 'internal');

  const georgi = link('444444447', 'Георги Стоянов');
  assert.equal(georgi.publish_tier, 'C_hold'); // generic, no seat → held
  assert.equal(georgi.status, 'held');

  // E11 divestment: Николай's 2019 stake in ДИВЕСТ 1 is superseded by a 2022 filing that omits it → withdrawn;
  // his current ДИВЕСТ 2 stake stays published. A later ownership filing that drops a company ends that link.
  const gone = link('666666665', 'Николай Дивестов');
  const kept = link('777777773', 'Николай Дивестов');
  assert.equal(gone.status, 'withdrawn'); // divested — excluded from the published surface
  assert.equal(gone.interest_class, 'private_ownership');
  assert.equal(gone.last_declared_year, '2019'); // dated to its last declaration, never asserted "current"
  assert.equal(kept.status, 'published');
  assert.equal(kept.last_declared_year, '2022');

  // certain ЕИК (declared_eik) behind a colliding name, no seat → the declarant-provided ЕИК is the
  // national unique identifier, so identity is deterministic → publishes as A_eik, NOT held for
  // name-genericness (ADR-0016; the ЕИК is at least as certain as the seat that rescues Радка below).
  const stefan = link('222222229', 'Стефан Колев');
  assert.equal(stefan.match_method, 'declared_eik'); // ЕИК resolution IS certain
  assert.equal(stefan.publish_tier, 'A_eik'); // ЕИК = unique identifier → deterministic, not name-gated
  assert.equal(stefan.status, 'published'); // private_ownership (20% ООД share) → surfaces
  // same colliding name, resolved by her declared ЕИК (with seat as extra corroboration) → the ЕИК is the
  // identity, so A_eik (not A_seat); publishable. A_seat's own path stays covered by Петър above.
  const radka = link('333333338', 'Радка Илиева');
  assert.equal(radka.match_method, 'declared_eik');
  assert.equal(radka.publish_tier, 'A_eik');
  assert.equal(radka.status, 'published');

  // FAMILY: a close relative's declared stake in a winner that sold to the official's OWN institution.
  // This is the strongest anonymized signal — relation 'related', class family_ownership, own_institution exact.
  const family = link('888888884', 'Кмет Тестов');
  assert.equal(family.relation, 'related');
  assert.equal(family.interest_class, 'family_ownership');
  assert.equal(family.status, 'published');
  assert.equal(family.own_institution, 'exact'); // relative's company sold to the official's own institution
  assert.equal(family.contemporaneous, 1);
  assert.equal(family.contract_value_eur, 250000);
  assert.equal(family.link_key, family.person_id + '|888888884|family'); // distinct from any self link
  // PII rail: the relative's identity is never stored — no family holder name reaches the DB.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM related_persons_internal').get().n, 0);

  // SECURITIES/materiality: a self holding of LISTED joint-stock shares forms NO ownership link.
  assert.equal(link('999999998', 'Акционер Тестов'), undefined);
  // but it is still recorded as a declared interest (census), tagged kind securities
  assert.equal(
    db.prepare("SELECT kind FROM declared_interests WHERE entity_raw='ЛИСТЕД ТЕСТ АД'").get().kind,
    'securities',
  );
  db.close();
});

test('re-run is idempotent and honors link_suppressions (contested link stays removed)', () => {
  // grab a published link_key, suppress it, re-load
  let db = new DatabaseSync(DB);
  const key = db
    .prepare("SELECT link_key FROM interest_links WHERE eik='111111119'")
    .get().link_key;
  db.prepare('INSERT INTO link_suppressions(link_key,reason,suppressed_by) VALUES(?,?,?)').run(
    key,
    'contested',
    'test',
  );
  db.close();

  runLoad(); // rebuild

  db = open();
  assert.equal(
    db.prepare('SELECT status FROM interest_links WHERE link_key=?').get(key).status,
    'suppressed',
  );
  // idempotent: still exactly the same number of links + persons after a clean rebuild.
  // 10 links: 9 self (incl. withdrawn/held) + 1 family; Мария (quarantined) & Акционер (securities) form none.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM interest_links').get().n, 10);
  // 11 persons: everyone who declared a holding, incl. no-link Мария & Акционер.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM persons').get().n, 11);
  db.close();
});

test('a FAMILY-scope suppression (…|family key) survives re-import — the takedown keys on the exact link_key', () => {
  // The self key is `pid|eik`; a family link's key carries the `|family` suffix (load.mjs). A takedown filed on
  // the family key MUST keep matching after a rebuild — else a family (defamation-sensitive) сваляне silently
  // no-ops. Assert the key form, suppress by it, rebuild, confirm it stays removed.
  let db = new DatabaseSync(DB);
  const key = db
    .prepare("SELECT link_key FROM interest_links WHERE interest_class='family_ownership'")
    .get().link_key;
  assert.match(
    key,
    /\|family$/,
    'a family link_key must carry the |family suffix (asymmetric key)',
  );
  db.prepare(
    'INSERT OR IGNORE INTO link_suppressions(link_key,reason,suppressed_by) VALUES(?,?,?)',
  ).run(key, 'family takedown', 'test');
  db.close();

  runLoad(); // rebuild — human-curated suppressions are preserved and re-applied

  db = open();
  assert.equal(
    db.prepare('SELECT status FROM interest_links WHERE link_key=?').get(key).status,
    'suppressed',
    'a family link keyed pid|eik|family must be suppressed after re-import',
  );
  db.close();
});
