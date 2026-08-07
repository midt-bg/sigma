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
import { fingerprint } from './suppressions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SUPP_SALT = 'test-salt-9f3a'; // stand-in for the CI secret SUPPRESSION_SALT
let dir, DB, STAGING;

function runLoad(extraEnv = {}) {
  execFileSync(
    'node',
    ['--import', path.join(HERE, 'register-ts.mjs'), path.join(HERE, 'load.mjs')],
    {
      cwd: ROOT,
      env: { ...process.env, CACBG_DB: DB, CACBG_STAGING: STAGING, ...extraEnv },
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
    -- ZERO-CONTRACT case (I5): a distinctive winner name with NO contract rows → a name match that carries
    -- no procurement conflict. Collected, but must NEVER publish („0 договори · 0 €").
    INSERT INTO bidders VALUES ('eik:121212129','НУЛА ТЕХ 3 ЕООД','121212129',1,'София');
    -- B1 divest-to-ZERO: Пълен owns ДИВЕСТ ЗЕРО (2019), then files an EMPTY declaration (2023) listing NO
    -- stake at all. The empty filing advances his horizon past 2019 → the 2019 stake is withdrawn.
    INSERT INTO bidders VALUES ('eik:101010104','ДИВЕСТ ЗЕРО 4 ЕООД','101010104',1,'София');
    INSERT INTO contracts VALUES ('c11','t1','eik:101010104','2019-05-01',150000);
    -- N10 canonicalization: Канонов owns КАНОН ТЕХ 5, filing „МВР" one year and the full ministry name the
    -- next → ONE identity, ONE link (not a split). Distinctive name (number) → tier B publishable.
    INSERT INTO bidders VALUES ('eik:131313136','КАНОН ТЕХ 5 ЕООД','131313136',1,'София');
    INSERT INTO contracts VALUES ('c12','t1','eik:131313136','2022-05-01',90000);
    -- N10 empty-institution: Безинст owns a distinctive winner but declares NO institution → cannot be
    -- attributed without risking a homonym merge → forms NO link.
    INSERT INTO bidders VALUES ('eik:141414141','БЕЗИНСТ ТЕХ 6 ЕООД','141414141',1,'София');
    INSERT INTO contracts VALUES ('c13','t1','eik:141414141','2023-05-01',80000);
    -- #226 cross-type divest: Интер owns ИНТЕР ТЕХ 8 (distinctive → tier B) declared ONLY in an INTERESTS
    -- declaration (2020). His later 2023 ASSET declaration lists no company → must NOT withdraw this stake.
    INSERT INTO bidders VALUES ('eik:161616163','ИНТЕР ТЕХ 8 ЕООД','161616163',1,'София');
    INSERT INTO contracts VALUES ('c14','t1','eik:161616163','2020-05-01',120000);
    -- #226 headline dedup: TWO different officials each own a stake in the SAME winner (ПАРТНЬОРИ 5, €600k).
    -- Both publish (distinctive name → B_distinctive), so the build summary must count that winner's € ONCE,
    -- not twice — the load-side sibling of the UI conflictHeadline per-ЕИК money dedup.
    INSERT INTO bidders VALUES ('eik:181818187','ПАРТНЬОРИ 5 ЕООД','181818187',1,'София');
    INSERT INTO contracts VALUES ('c15','t1','eik:181818187','2022-06-01',600000);
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
    // ZERO-CONTRACT (I5): Нула owns a distinctive winner that has NO contracts → tier B by name, but gated to
    // 'internal' because there is no won public money to show on the surface.
    {
      folder: '2024',
      xmlFile: 'M.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'N2',
      person: 'Нула Тестов',
      position: '',
      entity: 'НУЛА ТЕХ 3 ЕООД',
      kind: 'shares',
      detail: '100%',
      timing: 'annual',
      seat: '',
      holderRelation: 'self',
      controlHash: 'H13',
    },
    // B1 divest-to-ZERO: Пълен owns ДИВЕСТ ЗЕРО in 2019. His later EMPTY filing (below, in filings.jsonl,
    // NO holdings row) advances his horizon to 2023 → this 2019 stake is withdrawn even though no later
    // filing lists ANY stake. Without the filing horizon this would wrongly stay 'published'.
    {
      folder: '2020',
      xmlFile: 'ZE0.xml',
      year: '2019',
      template: 'assets',
      category: '',
      institution: 'T2',
      person: 'Пълен Дивестов',
      position: '',
      entity: 'ДИВЕСТ ЗЕРО 4 ЕООД',
      kind: 'shares',
      detail: '100%',
      timing: 'annual',
      seat: '',
      holderRelation: 'self',
      controlHash: 'H14',
    },
    // B4 UNKNOWN holder: the holder cell is neither confidently the declarant's own name nor a relative's
    // (an ambiguous 1-token-different cell). classifyHolder → 'unknown' → this forms NO link (counted
    // nowhere), so a phantom relative never enters a published family figure.
    {
      folder: '2024',
      xmlFile: 'UNK.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'N3',
      person: 'Двусмислен Тестов',
      position: '',
      entity: 'ДИСТИНКТ ТЕХ 7 ЕООД',
      kind: 'shares',
      detail: '10%',
      timing: 'annual',
      seat: '',
      holderRelation: 'unknown',
      controlHash: 'H15',
    },
    // N10 canonicalization: Канонов declares „МВР" (2022) and „Министерство на вътрешните работи" (2023) for
    // the SAME winner. Both institution strings fold to one canonical identity → ONE person, ONE link.
    {
      folder: '2023',
      xmlFile: 'CN1.xml',
      year: '2022',
      template: 'assets',
      category: '',
      institution: 'МВР',
      person: 'Канонов Тестов',
      position: '',
      entity: 'КАНОН ТЕХ 5 ЕООД',
      kind: 'shares',
      detail: '50%',
      timing: 'annual',
      seat: '',
      holderRelation: 'self',
      controlHash: 'H16',
    },
    {
      folder: '2024',
      xmlFile: 'CN2.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'Министерство на вътрешните работи',
      person: 'Канонов Тестов',
      position: '',
      entity: 'КАНОН ТЕХ 5 ЕООД',
      kind: 'shares',
      detail: '50%',
      timing: 'annual',
      seat: '',
      holderRelation: 'self',
      controlHash: 'H17',
    },
    // N10 empty-institution: Безинст owns a winner but declares NO institution → forms NO link (homonym guard).
    {
      folder: '2024',
      xmlFile: 'BI.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: '',
      person: 'Безинст Тестов',
      position: '',
      entity: 'БЕЗИНСТ ТЕХ 6 ЕООД',
      kind: 'shares',
      detail: '100%',
      timing: 'annual',
      seat: '',
      holderRelation: 'self',
      controlHash: 'H18',
    },
    // #226 cross-type divest: Интер's ONLY declaration of ИНТЕР ТЕХ 8 is this INTERESTS filing (2020). A later
    // ASSET filing (pushed into filings.jsonl below, no holdings row) must NOT withdraw it — no later INTERESTS
    // filing omits the company. Under a per-person horizon this wrongly reads as divested; per-type keeps it.
    {
      folder: '2021',
      xmlFile: 'INT.xml',
      year: '2020',
      template: 'interests',
      category: '',
      institution: 'INT',
      person: 'Интер Тестов',
      position: '',
      entity: 'ИНТЕР ТЕХ 8 ЕООД',
      kind: 'shares',
      detail: '100%',
      timing: 'annual',
      seat: '',
      holderRelation: 'self',
      controlHash: 'H19',
    },
    // #226 headline dedup: Алфа AND Бета each own a stake in the SAME winner (ПАРТНЬОРИ 5). Distinctive name
    // → both publish → two published private_ownership links on ЕИК 181818187, so the build summary's € totals
    // must count that winner's €600k once, not twice.
    {
      folder: '2024',
      xmlFile: 'PA.xml',
      year: '2022',
      template: 'assets',
      category: '',
      institution: 'ТЕСТ ВЕДОМСТВО',
      person: 'Алфа Партньоров',
      position: '',
      entity: 'ПАРТНЬОРИ 5 ЕООД',
      kind: 'shares',
      detail: '50%',
      timing: 'annual',
      seat: '',
      holderRelation: 'self',
      controlHash: 'H20',
    },
    {
      folder: '2024',
      xmlFile: 'PB.xml',
      year: '2022',
      template: 'assets',
      category: '',
      institution: 'ДРУГО ВЕДОМСТВО',
      person: 'Бета Партньоров',
      position: '',
      entity: 'ПАРТНЬОРИ 5 ЕООД',
      kind: 'shares',
      detail: '30%',
      timing: 'annual',
      seat: '',
      holderRelation: 'self',
      controlHash: 'H21',
    },
  ];
  fs.writeFileSync(
    path.join(STAGING, 'holdings.jsonl'),
    holdings.map((h) => JSON.stringify(h)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(STAGING, 'related.jsonl'), '');
  // filings.jsonl (B1): one record per DECLARATION — every holding's filing PLUS empty/no-material filings.
  // Derive a filing from each holding, then add Пълен's later EMPTY 2023 filing (no holdings row) so his
  // 2019 stake is caught as divest-to-zero.
  const filings = holdings.map((h) => ({
    folder: h.folder,
    xmlFile: h.xmlFile,
    year: h.year,
    template: h.template, // divest horizon is per declaration type (#226)
    person: h.person,
    institution: h.institution,
  }));
  filings.push({
    folder: '2023',
    xmlFile: 'ZE1.xml',
    year: '2023',
    template: 'assets', // Пълен's later EMPTY ASSET filing — same type as his 2019 asset stake ⇒ divests it
    person: 'Пълен Дивестов',
    institution: 'T2',
  });
  // #226 (Todor B1) cross-type: Интер declares his stake ONLY in an INTERESTS declaration (2020); his later
  // 2023 filing is an ASSET declaration that (for him) lists no company at all. A per-person horizon would
  // read that asset-declaration silence as a sale and WITHDRAW a true stake. A per-TYPE horizon must not: no
  // later INTERESTS filing omits the company, so the link stays published.
  filings.push({
    folder: '2024',
    xmlFile: 'INTA.xml',
    year: '2023',
    template: 'assets',
    person: 'Интер Тестов',
    institution: 'INT',
  });
  fs.writeFileSync(
    path.join(STAGING, 'filings.jsonl'),
    filings.map((f) => JSON.stringify(f)).join('\n') + '\n',
  );
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
  // Now PUBLISHED on the named surface identically to a self stake (ADR-0032, superseding ADR-0030): a
  // relative's declared stake in a procurement winner is the same public-interest signal. class
  // family_ownership, relation 'related', own_institution exact. It has real contract money (€250k, cCount>0)
  // so the zero-contract gate keeps it.
  const family = link('888888884', 'Кмет Тестов');
  assert.equal(family.relation, 'related');
  assert.equal(family.interest_class, 'family_ownership');
  assert.equal(family.status, 'published'); // ADR-0032: family surfaces like self
  assert.equal(family.own_institution, 'exact'); // relative's company sold to the official's own institution
  assert.equal(family.contemporaneous, 1);
  assert.equal(family.contract_value_eur, 250000);
  assert.equal(family.link_key, family.person_id + '|888888884|family'); // distinct from any self link
  // NON-NEGOTIABLE (ADR-0032 #1): the relative's identity is NEVER stored — no family holder name reaches the
  // DB, not even now that the link is public. Only holderRelation flows through; the name never leaves parse.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM related_persons_internal').get().n, 0);
  // §2 ал.3 ПЗР canary (rail #3): the build report buckets material family holdings by source template — every
  // family holding in this corpus is declared in an ASSET declaration, so the only bucket is 'assets'. A
  // non-'assets' bucket would mean a relative's stake leaked from a non-public source (consent/libel breach).
  const report = JSON.parse(
    fs
      .readFileSync(path.join(STAGING, 'findings.md'), 'utf8')
      .split('```json')[1]
      .split('```')[0]
      .trim(),
  );
  assert.deepEqual(Object.keys(report.family_material_by_source_template), ['assets']);

  // #226 headline dedup: the build summary's € totals are a per-ЕИК quantity, not a per-link sum. Алфа AND
  // Бета both publish an own stake in the SAME winner (ПАРТНЬОРИ 5, ЕИК 181818187, €600k), so a plain
  // SUM(contract_value_eur) over published links double-counts that winner — the load-side twin of the UI
  // conflictHeadline bug. Prove the fixture actually exercises the collision (naive per-link sum strictly
  // exceeds the per-ЕИК-deduped sum), then assert the reported totals equal the deduped figure.
  const alfa = link('181818187', 'Алфа Партньоров');
  const beta = link('181818187', 'Бета Партньоров');
  assert.equal(alfa.status, 'published');
  assert.equal(beta.status, 'published');
  assert.equal(alfa.interest_class, 'private_ownership');
  assert.equal(beta.interest_class, 'private_ownership');
  assert.equal(alfa.contract_value_eur, 600000); // winner's total, identical on both links
  assert.equal(beta.contract_value_eur, 600000);
  const naive = db
    .prepare(
      "SELECT COALESCE(SUM(contract_value_eur),0) v FROM interest_links WHERE status='published'",
    )
    .get().v;
  const dedup = db
    .prepare(
      "SELECT COALESCE(SUM(v),0) v FROM (SELECT MAX(contract_value_eur) v FROM interest_links WHERE status='published' GROUP BY eik)",
    )
    .get().v;
  assert.ok(
    naive > dedup,
    'fixture must exercise a shared-ЕИК double-count, else the test has no teeth',
  );
  assert.equal(naive - dedup, 600000); // exactly ПАРТНЬОРИ 5's €600k, counted twice by the naive sum
  // The reported totals must be the DEDUPED figure, never the inflated per-link sum.
  assert.equal(report.published_contract_value_eur, Math.round(dedup));
  const privDedup = db
    .prepare(
      "SELECT COALESCE(SUM(v),0) v FROM (SELECT MAX(contract_value_eur) v FROM interest_links WHERE status='published' AND interest_class='private_ownership' GROUP BY eik)",
    )
    .get().v;
  assert.equal(report.published_private_ownership_value_eur, Math.round(privDedup)); // the "headline conflict number"
  assert.equal(
    report.published_by_interest_class.private_ownership.value_eur,
    Math.round(privDedup),
  );

  // ZERO-CONTRACT gate (I5): a distinctive winner with NO contracts is collected but never published — the
  // card would read „0 договори · 0 €", which is no procurement conflict. status 'internal', not 'published'.
  const zero = link('121212129', 'Нула Тестов');
  assert.equal(zero.contract_count, 0);
  assert.equal(zero.interest_class, 'private_ownership'); // it IS own material ownership …
  assert.equal(zero.publish_tier, 'B_distinctive'); // … and tier-B by name …
  assert.equal(zero.status, 'internal'); // … but the zero-contract gate withholds it from the surface

  // SECURITIES/materiality: a self holding of LISTED joint-stock shares forms NO ownership link.
  assert.equal(link('999999998', 'Акционер Тестов'), undefined);
  // but it is still recorded as a declared interest (census), tagged kind securities
  assert.equal(
    db.prepare("SELECT kind FROM declared_interests WHERE entity_raw='ЛИСТЕД ТЕСТ АД'").get().kind,
    'securities',
  );

  // B1 divest-to-ZERO: Пълен owned ДИВЕСТ ЗЕРО in 2019, then filed an EMPTY declaration in 2023 (no holdings
  // row — only a filings.jsonl entry). The empty filing advances his horizon to 2023, so the 2019 stake is
  // WITHDRAWN. Without the filing horizon (pre-B1) his scope-max would be 2019 and this would stay published.
  const divZero = link('101010104', 'Пълен Дивестов');
  assert.equal(divZero.interest_class, 'private_ownership');
  assert.equal(divZero.last_declared_year, '2019'); // dated to its last declaration, never asserted current
  assert.equal(divZero.status, 'withdrawn'); // caught by the empty later filing (B1)

  // #226 (Todor B1) PER-TYPE horizon: Интер declared ИНТЕР ТЕХ 8 only in an INTERESTS declaration (2020) and
  // later filed only an ASSET declaration (2023) that, for him, lists no company. A per-person horizon reads
  // that asset-declaration silence as a sale and WITHDRAWS the stake; the per-type horizon must not — no later
  // INTERESTS filing omits the company. This link must stay PUBLISHED. (Guards against dropping a true link:
  // 13% of holders declare a stake only in the interests declaration.)
  const crossType = link('161616163', 'Интер Тестов');
  assert.equal(crossType.interest_class, 'private_ownership');
  assert.equal(crossType.status, 'published'); // NOT withdrawn — the later asset filing is a different type

  // B4 UNKNOWN holder: an ambiguous holder cell forms NO link at all (counted nowhere) — it must never
  // reach the leaderboard, self or family (ADR-0032). Двусмислен gets no interest_link.
  assert.equal(link('111111119', 'Двусмислен Тестов'), undefined);
  // but the person + declared_interest are still recorded (census), and it is neither self nor family.
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM interest_links il JOIN persons p ON p.id=il.person_id WHERE p.name='Двусмислен Тестов'",
      )
      .get().n,
    0,
  );

  // N10 canonicalization: Канонов's „МВР" and „Министерство на вътрешните работи" filings fold to ONE
  // identity → exactly ONE link and ONE person_id for КАНОН ТЕХ 5 (not a split into two person-pages).
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM interest_links WHERE eik='131313136'").get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(DISTINCT person_id) n FROM interest_links WHERE eik='131313136'").get()
      .n,
    1,
  );
  const kanon = link('131313136', 'Канонов Тестов');
  assert.equal(kanon.status, 'published'); // distinctive, private ownership, has a contract
  // N10 empty-institution: an empty institution cannot distinguish homonyms → Безинст forms NO link.
  assert.equal(link('141414141', 'Безинст Тестов'), undefined);
  db.close();
});

test('re-run is idempotent and honors the suppression list (contested link stays removed)', () => {
  // grab a published link_key and suppress it via the version-controlled list (HMAC fingerprint + salt,
  // ADR-0031), then re-load — the takedown must survive a full rebuild.
  let db = new DatabaseSync(DB);
  const key = db
    .prepare("SELECT link_key FROM interest_links WHERE eik='111111119'")
    .get().link_key;
  db.close();

  const suppFile = path.join(dir, 'supp.jsonl');
  fs.writeFileSync(
    suppFile,
    JSON.stringify({
      fp: fingerprint(key, SUPP_SALT),
      key_version: '1',
      reason: 'contested',
      suppressed_at: '2026-07-29',
    }) + '\n',
  );
  runLoad({ CACBG_SUPP_LIST: suppFile, SUPPRESSION_SALT: SUPP_SALT }); // rebuild with the list applied

  db = open();
  assert.equal(
    db.prepare('SELECT status FROM interest_links WHERE link_key=?').get(key).status,
    'suppressed',
  );
  // idempotent: still exactly the same number of links + persons after a clean rebuild.
  // 16 links: 12 self (incl. withdrawn/held + the zero-contract 'internal' + Пълен's divest-to-zero
  // 'withdrawn' + Интер's per-type-kept published link) + 1 family + Канонов's canonicalized single link +
  // Алфа & Бета (two officials on one winner, ПАРТНЬОРИ 5); Мария (quarantined), Акционер (securities),
  // Двусмислен (unknown holder) & Безинст (empty institution) none.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM interest_links').get().n, 16);
  // 19 persons: everyone who declared a holding, incl. no-link Мария, Акционер, Двусмислен, Безинст,
  // zero-contract Нула and the two ПАРТНЬОРИ co-owners; Канонов's two institution-variant filings fold to ONE.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM persons').get().n, 19);
  db.close();
});

test('a FAMILY-scope suppression (…|family key) survives re-import — the takedown keys on the exact link_key', () => {
  // The self key is `pid|eik`; a family link's key carries the `|family` suffix (load.mjs). A takedown filed on
  // the family key MUST keep matching after a rebuild — else a family (defamation-sensitive) сваляне silently
  // no-ops. Assert the key form, fingerprint it into the list, rebuild, confirm it stays removed.
  let db = new DatabaseSync(DB);
  const key = db
    .prepare("SELECT link_key FROM interest_links WHERE interest_class='family_ownership'")
    .get().link_key;
  assert.match(
    key,
    /\|family$/,
    'a family link_key must carry the |family suffix (asymmetric key)',
  );
  db.close();

  const suppFile = path.join(dir, 'supp-family.jsonl');
  fs.writeFileSync(
    suppFile,
    JSON.stringify({
      fp: fingerprint(key, SUPP_SALT),
      key_version: '1',
      reason: 'family takedown',
      suppressed_at: '2026-07-29',
    }) + '\n',
  );
  runLoad({ CACBG_SUPP_LIST: suppFile, SUPPRESSION_SALT: SUPP_SALT });

  db = open();
  assert.equal(
    db.prepare('SELECT status FROM interest_links WHERE link_key=?').get(key).status,
    'suppressed',
    'a family link keyed pid|eik|family must be suppressed after re-import',
  );
  db.close();
});

test('a non-empty suppression list with no salt FAILS the build (never silently un-suppresses)', () => {
  // Fail-closed: building with suppressions present but SUPPRESSION_SALT unset would fingerprint to nothing
  // and silently re-expose every taken-down link. load.mjs must refuse (non-zero exit) instead.
  const suppFile = path.join(dir, 'supp-nosalt.jsonl');
  fs.writeFileSync(
    suppFile,
    JSON.stringify({ fp: 'deadbeef', reason: 'x', suppressed_at: '2026-07-29' }) + '\n',
  );
  assert.throws(
    () => runLoad({ CACBG_SUPP_LIST: suppFile, SUPPRESSION_SALT: '' }),
    (err) => /SUPPRESSION_SALT is unset/.test(String(err.stderr ?? '') + String(err.message ?? '')),
  );
});

test('a suppression that matches NO built link FAILS the build (B3 unused-suppression gate)', () => {
  // A fingerprint of a link_key that does not exist (a changed institution / reformatted ЕИК, or a plain
  // typo) would silently un-suppress nothing while the operator believes a takedown is in force. The build
  // must refuse (non-zero exit) rather than ship a stale/mis-keyed suppression.
  const suppFile = path.join(dir, 'supp-orphan.jsonl');
  fs.writeFileSync(
    suppFile,
    JSON.stringify({
      fp: fingerprint('person:no|such|link', SUPP_SALT), // valid fingerprint, but matches no built link
      key_version: '1',
      reason: 'stale',
      suppressed_at: '2026-07-30',
    }) + '\n',
  );
  assert.throws(
    () => runLoad({ CACBG_SUPP_LIST: suppFile, SUPPRESSION_SALT: SUPP_SALT }),
    (err) => /matched NO built link/.test(String(err.stderr ?? '') + String(err.message ?? '')),
  );
});

test('a suppression on a ROTATED key_version FAILS the build (B3 no silent salt mismatch)', () => {
  // If the salt rotates, an entry left on the old key_version would fingerprint to nothing under the new
  // salt and silently un-suppress. The loader refuses an entry whose key_version ≠ the current one.
  const key = (() => {
    const db = new DatabaseSync(DB);
    const k = db
      .prepare("SELECT link_key FROM interest_links WHERE eik='444444447' LIMIT 1")
      .get().link_key;
    db.close();
    return k;
  })();
  const suppFile = path.join(dir, 'supp-rotated.jsonl');
  fs.writeFileSync(
    suppFile,
    JSON.stringify({
      fp: fingerprint(key, SUPP_SALT),
      key_version: '2', // current SUPPRESSION_KEY_VERSION defaults to '1' → mismatch
      reason: 'rotated',
      suppressed_at: '2026-07-30',
    }) + '\n',
  );
  assert.throws(
    () => runLoad({ CACBG_SUPP_LIST: suppFile, SUPPRESSION_SALT: SUPP_SALT }),
    (err) => /key_version/.test(String(err.stderr ?? '') + String(err.message ?? '')),
  );
});
