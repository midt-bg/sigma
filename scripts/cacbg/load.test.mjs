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
// The seal vocabulary is asserted with the PRODUCTION predicate, imported from the module that writes it.
import { isSealedFact } from '../tr/evidence.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
import { seedVerdicts, readFixtureDeed } from './tr-fixture.mjs';

const SUPP_SALT = 'test-salt-9f3a'; // stand-in for the CI secret SUPPRESSION_SALT
let dir, DB, STAGING, TR_DB, TR_RAW;

function runLoad(extraEnv = {}) {
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
        ...extraEnv,
      },
      stdio: 'pipe',
    },
  );
}

/**
 * Build a Trade Register cache + raw deeds covering the fixture's winners.
 *
 * `spec[eik]` describes one deed: `owners` / `managers` are full names placed in SEPARATE registry
 * entities (so the entity-boundary rule is exercised end to end), `form` is the numeric legalForm and
 * `suffix` the ЗТРРЮЛНЦ form on fullName. Anything omitted from `spec` is still cached — as a deed
 * naming somebody else — because the loader must FAIL CLOSED on a cache that does not cover every
 * candidate, and a test that silently left ЕИК uncovered would exercise that path by accident.
 */
function buildTrCache(dbFile, rawDir, spec = {}, { omit = [] } = {}) {
  fs.mkdirSync(rawDir, { recursive: true });
  const cache = new DatabaseSync(dbFile);
  cache.exec(`CREATE TABLE IF NOT EXISTS deeds (
    eik TEXT PRIMARY KEY, status TEXT NOT NULL, http_status INTEGER, fetched_at TEXT NOT NULL,
    raw_path TEXT, body_sha256 TEXT, legal_form_code INTEGER, legal_form_verdict TEXT,
    seat_normalized TEXT, seat_entry_date TEXT, latest_own_entry_date TEXT,
    attempts INTEGER NOT NULL DEFAULT 1, outside_reason TEXT)`);
  const src = new DatabaseSync(DB, { readOnly: true });
  const eiks = src
    .prepare('SELECT eik_normalized e FROM bidders WHERE eik_normalized IS NOT NULL')
    .all()
    .map((r) => r.e);
  src.close();

  const container = (t) =>
    `<div class='record-container record-container--preview'><p class='field-text'>${t}</p></div>`;
  const joinEntities = (names) => names.map(container).join(`<hr class='hr--report' />`);

  for (const eik of eiks) {
    if (omit.includes(eik)) continue;
    const d = spec[eik] ?? {};
    if (d.outsideTr) {
      cache
        .prepare(
          'INSERT OR REPLACE INTO deeds(eik,status,fetched_at,outside_reason) VALUES(?,?,?,?)',
        )
        .run(eik, 'outside_tr', '2026-08-05T00:00:00Z', 'HTTP 200, empty body');
      continue;
    }
    const fields = [];
    const push = (nameCode, names, entryDate) =>
      names?.length &&
      fields.push({
        nameCode,
        htmlData: joinEntities(names),
        fieldEntryNumber: '20110502101007',
        fieldEntryDate: `${entryDate ?? '2011-05-02'}T00:00:00`,
      });
    push('CR_F_19_L', d.owners ?? ['НЯКОЙ ДРУГ СОБСТВЕНИК'], d.ownEntryDate);
    push('CR_F_7_L', d.managers, d.ownEntryDate);
    if (d.seat) push('CR_F_5_L', [`Населено място: ${d.seat}`], d.seatEntryDate ?? d.ownEntryDate);
    const deed = {
      uic: eik,
      fullName: `"ФИКС" ${d.suffix ?? 'ООД'}`,
      legalForm: d.form ?? 4,
      sections: [{ subDeeds: [{ groups: [{ fields }] }] }],
    };
    fs.writeFileSync(path.join(rawDir, `${eik}.json`), JSON.stringify(deed));
    cache
      .prepare(
        `INSERT OR REPLACE INTO deeds(eik,status,http_status,fetched_at,raw_path,legal_form_code,
           legal_form_verdict,seat_normalized,latest_own_entry_date)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        eik,
        'fetched',
        200,
        '2026-08-05T00:00:00Z',
        `${eik}.json`,
        d.form ?? 4,
        d.suffix && /АД|КДА/.test(d.suffix) ? 'joint_stock' : 'closely_held',
        d.seat ? d.seat.replace(/^гр\.\s*/, '').toUpperCase() : null,
        d.ownEntryDate ?? '2011-05-02',
      );
  }
  cache.close();

  // The deeds alone decide nothing now: since ADR-0037 the verdict is reached by the crawler and the
  // loader only reads it. Run the REAL decision over these fixture deeds, so these tests keep
  // exercising the evidence ladder end to end instead of hand-written verdict rows.
  seedVerdicts({
    workDb: DB,
    staging: STAGING,
    trDb: dbFile,
    deedFor: (eik) => {
      if (omit.includes(eik)) return null; // never reached — no verdict, an incomplete cache
      if ((spec[eik] ?? {}).outsideTr) return { outsideTr: true };
      return readFixtureDeed(rawDir, eik);
    },
  });
}
const open = () => new DatabaseSync(DB, { readOnly: true });

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-load-'));
  DB = path.join(dir, 'fixture.sqlite');
  STAGING = path.join(dir, 'staging');
  TR_DB = path.join(dir, 'tr-cache.sqlite');
  TR_RAW = path.join(dir, 'tr-deeds');
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
    -- §1.3 unparseable filing YEAR: Безгодин owns ДИВЕСТ БЕЗГОД (2019), then files a later declaration whose
    -- <year> is unreadable while its FOLDER carries 2023. The folder must supply the horizon, or the filing
    -- is dropped, the horizon never advances, and a sold stake stays published — a stale public claim.
    INSERT INTO bidders VALUES ('eik:212121218','ДИВЕСТ БЕЗГОД 9 ЕООД','212121218',1,'София');
    INSERT INTO contracts VALUES ('c17','t1','eik:212121218','2019-05-01',120000);
    -- §1.3 positive control: Дрънкан's later filing is datable by NEITHER <year> NOR folder. It must be
    -- ignored, never guessed — an undatable filing is no evidence of a sale, so this stake stays published.
    INSERT INTO bidders VALUES ('eik:232323231','ДРЪНКАН ТЕХ 10 ЕООД','232323231',1,'София');
    INSERT INTO contracts VALUES ('c18','t1','eik:232323231','2019-05-01',110000);
    -- ADR-0035 winner-vs-non-winner homonym: „ХОМОНИМ ТРЕЙД" is a GENERIC фирма (two content words) and the
    -- sole WINNER holding it. Хомоним Иванов Тестов declared a stake in a company of that name — but the one
    -- he owns never bid, so the resolver lands on this winner instead. This winner's deed happens to name a
    -- HOMONYM (identical three tokens), which under a name-only rung 2 „proves" a link false in both halves.
    -- Nothing corroborates the company (no declared ЕИК, no declared seat), so it must be withheld.
    INSERT INTO bidders VALUES ('eik:242424248','ХОМОНИМ ТРЕЙД ЕООД','242424248',1,'София');
    INSERT INTO contracts VALUES ('c19','t1','eik:242424248','2023-05-01',95000);
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
    -- FAMILY positive control (#279): identical in shape to Кмет's case but the official DECLARED the
    -- company's seat, which is what confirms the company's identity when the registered owner is the
    -- relative whose name we never hold. Without this case „family published: 0" would be
    -- indistinguishable from a structurally dead path (ADR-0027's false-zero lesson).
    INSERT INTO bidders VALUES ('eik:191919199','СЕМЕЕН ДОМ ЕООД','191919199',1,'Русе');
    INSERT INTO contracts VALUES ('c16','t4','eik:191919199','2023-07-01',180000);
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
      person: 'Мария Иванова Петрова',
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
      person: 'Петър Иванов Николов',
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
      person: 'Георги Иванов Стоянов',
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
      person: 'Стефан Иванов Колев',
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
      person: 'Радка Иванова Илиева',
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
      person: 'Борис Иванов Манолов',
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
      person: 'Виктор Иванов Асенов',
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
      person: 'Николай Иванов Дивестов',
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
      person: 'Николай Иванов Дивестов',
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
      person: 'Кмет Иванов Тестов',
      position: 'кмет',
      entity: 'ЕВРОСТРОЙ 21 ЕООД',
      kind: 'shares',
      detail: '100%',
      timing: 'annual',
      seat: '',
      holderRelation: 'related',
      controlHash: 'H11',
    },
    // FAMILY positive control: same as Кмет, but with the seat declared → rung 3 confirms the company.
    {
      folder: '2024',
      xmlFile: 'K2.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'ОБЩИНА ТЕСТ',
      person: 'Кметица Иванова Втора',
      position: 'кмет',
      entity: 'СЕМЕЕН ДОМ ЕООД',
      kind: 'shares',
      detail: '100%',
      timing: 'annual',
      seat: 'Русе',
      holderRelation: 'related',
      controlHash: 'H11b',
    },
    // SECURITIES: Акционер holds LISTED joint-stock shares (kind securities) → excluded, no ownership link.
    {
      folder: '2024',
      xmlFile: 'L.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'S',
      person: 'Акционер Иванов Тестов',
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
      person: 'Нула Иванов Тестов',
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
      person: 'Пълен Иванов Дивестов',
      position: '',
      entity: 'ДИВЕСТ ЗЕРО 4 ЕООД',
      kind: 'shares',
      detail: '100%',
      timing: 'annual',
      seat: '',
      holderRelation: 'self',
      controlHash: 'H14',
    },
    // §1.3 unparseable filing year: Безгодин's 2019 stake. His later filing (in filings.jsonl, no holdings
    // row) carries an unreadable <year> but a 2023 FOLDER — the fallback that must withdraw this stake.
    {
      folder: '2020',
      xmlFile: 'BG0.xml',
      year: '2019',
      template: 'assets',
      category: '',
      institution: 'T3',
      person: 'Безгодин Иванов Дивестов',
      position: '',
      entity: 'ДИВЕСТ БЕЗГОД 9 ЕООД',
      kind: 'shares',
      detail: '100%',
      timing: 'annual',
      seat: 'гр. София',
      holderRelation: 'self',
      controlHash: 'H20',
    },
    // §1.3 positive control: Дрънкан's 2019 stake, whose only later filing is undatable (see filings.jsonl).
    {
      folder: '2020',
      xmlFile: 'DR0.xml',
      year: '2019',
      template: 'assets',
      category: '',
      institution: 'T4',
      person: 'Дрънкан Иванов Тестов',
      position: '',
      entity: 'ДРЪНКАН ТЕХ 10 ЕООД',
      kind: 'shares',
      detail: '100%',
      timing: 'annual',
      seat: '',
      holderRelation: 'self',
      controlHash: 'H21',
    },
    // ADR-0035: Хомоним's declared stake in a generic-named company, with NO ЕИК and NO seat declared.
    {
      folder: '2024',
      xmlFile: 'HOM.xml',
      year: '2023',
      template: 'assets',
      category: '',
      institution: 'T5',
      person: 'Хомоним Иванов Тестов',
      position: '',
      entity: 'ХОМОНИМ ТРЕЙД ЕООД',
      kind: 'shares',
      detail: '100%',
      timing: 'annual',
      seat: '',
      holderRelation: 'self',
      controlHash: 'H22',
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
      person: 'Двусмислен Иванов Тестов',
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
      person: 'Канонов Иванов Тестов',
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
      person: 'Канонов Иванов Тестов',
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
      person: 'Безинст Иванов Тестов',
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
      person: 'Интер Иванов Тестов',
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
      person: 'Алфа Иванов Партньоров',
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
      person: 'Бета Иванов Партньоров',
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
    person: 'Пълен Иванов Дивестов',
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
    person: 'Интер Иванов Тестов',
    institution: 'INT',
  });
  // §1.3: the divesting filing whose <year> is UNREADABLE. `folder` carries 2023 and is the only thing that
  // can date it. Dropping the record leaves the horizon at 2019, `divested` false, and a sold stake on the
  // public surface — the failure direction that matters here, since the claim names a real official.
  filings.push({
    folder: '2023',
    xmlFile: 'BG1.xml',
    year: 'н/д',
    template: 'assets',
    person: 'Безгодин Иванов Дивестов',
    institution: 'T3',
  });
  // POSITIVE CONTROL for the same fallback: a filing datable by NEITHER field must still be ignored, not
  // guessed at. Дрън's stake stays published — an undatable filing is no evidence of a sale.
  filings.push({
    folder: 'архив',
    xmlFile: 'DR1.xml',
    year: '',
    template: 'assets',
    person: 'Дрънкан Иванов Тестов',
    institution: 'T4',
  });
  fs.writeFileSync(
    path.join(STAGING, 'filings.jsonl'),
    filings.map((f) => JSON.stringify(f)).join('\n') + '\n',
  );

  // The Trade Register evidence each link now has to rest on (#279, ADR-0033). Shaped so every
  // existing case keeps the INTENT it was written for, under the new rule rather than the old one:
  //   • a person the register names as owner/manager  → „Документ"
  //   • a declared seat matching the registered seat  → „Потвърдено"
  //   • a declared ЕИК                                → „Потвърдено" (never name-gated, ADR-0028)
  //   • nobody we can match and nothing to confirm    → „Неизвестна", held
  buildTrCache(TR_DB, TR_RAW, {
    111111119: { managers: ['ИВАН ПЕТРОВ ТЕСТОВ'] }, // manages → document/manager (class keeps it internal)
    444444447: { seat: 'гр. Бургас' }, // Петър declared Бургас → confirmed; Георги declared none → held
    555555556: {
      managers: ['БОРИС ИВАНОВ МАНОЛОВ', 'ВИКТОР ИВАНОВ АСЕНОВ'],
      suffix: 'ЕАД',
      form: 5,
    },
    666666665: { owners: ['СЪВСЕМ ДРУГ СОБСТВЕНИК'] }, // Николай absent → his divestment stands
    777777773: { owners: ['НИКОЛАЙ ИВАНОВ ДИВЕСТОВ'] }, // still the registered owner → document
    888888884: { owners: ['РОДНИНА КМЕТОВА'] }, // family: the RELATIVE owns it, not the official
    999999998: { suffix: 'АД', form: 5 },
    101010104: { owners: ['ДРУГ СОБСТВЕНИК'] }, // Пълен absent → divest-to-zero stands
    131313136: { owners: ['КАНОНОВ ИВАНОВ ТЕСТОВ'] },
    161616163: { owners: ['ИНТЕР ИВАНОВ ТЕСТОВ'] },
    181818187: { owners: ['АЛФА ИВАНОВ ПАРТНЬОРОВ', 'БЕТА ИВАНОВ ПАРТНЬОРОВ'] },
    121212129: { owners: ['НУЛА ИВАНОВ ТЕСТОВ'] },
    191919199: { owners: ['РОДНИНА ВТОРА'], seat: 'гр. Русе' }, // family + declared seat → confirmed
    // Безгодин is ABSENT from the deed (so §7 reconciliation cannot reverse the divestment) but his
    // declared seat matches the registered one, so rung 3 says „Потвърдено" and the link PUBLISHES.
    // Only the folder-dated divestment withdraws it — making the pre-fix failure the dangerous one.
    212121218: { owners: ['ДРУГ СОБСТВЕНИК СЪВСЕМ'], seat: 'гр. София' },
    232323231: { owners: ['ДРЪНКАН ИВАНОВ ТЕСТОВ'] }, // still the owner → the undatable filing changes nothing
    // The homonym: the deed names someone with Хомоним's exact three tokens. Rung 2 matches — and must
    // still withhold, because nothing says this is the company he declared.
    242424248: { owners: ['ХОМОНИМ ИВАНОВ ТЕСТОВ'] },
  });
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
  assert.equal(ivan.publish_tier, 'document'); // the register names him a manager of this company
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
  assert.equal(link('222222229', 'Мария Иванова Петрова'), undefined);
  assert.equal(link('333333338', 'Мария Иванова Петрова'), undefined);
  // the only links onto the colliding ЕИК come from declared_eik (Стефан/Радка), never exact_name_key
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM interest_links WHERE eik IN (?,?) AND match_method='exact_name_key'",
      )
      .get('222222229', '333333338').n,
    0,
  );

  const petar = link('444444447', 'Петър Иванов Николов');
  assert.equal(petar.publish_tier, 'confirmed'); // declared seat == registered seat
  assert.equal(petar.status, 'published');
  assert.equal(petar.interest_class, 'private_ownership'); // declared a share → the headline conflict signal

  // two officials manage the SAME company → deterministically classed ex-officio (public board), not private
  const boris = link('555555556', 'Борис Иванов Манолов');
  const viktor = link('555555556', 'Виктор Иванов Асенов');
  assert.equal(boris.interest_class, 'ex_officio_board');
  assert.equal(viktor.interest_class, 'ex_officio_board');
  assert.equal(boris.relation, 'manages');
  // ex_officio_board never surfaces → stored 'internal', not 'published' (self-describing D1; fails safe)
  assert.equal(boris.status, 'internal');
  assert.equal(viktor.status, 'internal');

  const georgi = link('444444447', 'Георги Иванов Стоянов');
  assert.equal(georgi.publish_tier, 'unknown'); // same company, but he declared no seat → nothing confirms
  assert.equal(georgi.status, 'held');

  // E11 divestment: Николай's 2019 stake in ДИВЕСТ 1 is superseded by a 2022 filing that omits it → withdrawn;
  // his current ДИВЕСТ 2 stake stays published. A later ownership filing that drops a company ends that link.
  const gone = link('666666665', 'Николай Иванов Дивестов');
  const kept = link('777777773', 'Николай Иванов Дивестов');
  assert.equal(gone.status, 'withdrawn'); // divested — excluded from the published surface
  assert.equal(gone.interest_class, 'private_ownership');
  assert.equal(gone.last_declared_year, '2019'); // dated to its last declaration, never asserted "current"
  assert.equal(kept.status, 'published');
  assert.equal(kept.last_declared_year, '2022');

  // certain ЕИК (declared_eik) behind a colliding name, no seat → the declarant-provided ЕИК is the
  // national unique identifier, so identity is deterministic → publishes as A_eik, NOT held for
  // name-genericness (ADR-0016; the ЕИК is at least as certain as the seat that rescues Радка below).
  const stefan = link('222222229', 'Стефан Иванов Колев');
  assert.equal(stefan.match_method, 'declared_eik'); // ЕИК resolution IS certain
  assert.equal(stefan.publish_tier, 'confirmed'); // the declared ЕИК confirms the company, never name-gated
  assert.equal(stefan.status, 'published'); // private_ownership (20% ООД share) → surfaces
  // same colliding name, resolved by her declared ЕИК (with seat as extra corroboration) → the ЕИК is the
  // identity, so A_eik (not A_seat); publishable. A_seat's own path stays covered by Петър above.
  const radka = link('333333338', 'Радка Иванова Илиева');
  assert.equal(radka.match_method, 'declared_eik');
  assert.equal(radka.publish_tier, 'confirmed');
  assert.equal(radka.status, 'published');

  // FAMILY: a close relative's declared stake in a winner that sold to the official's OWN institution.
  // Now PUBLISHED on the named surface identically to a self stake (ADR-0032, superseding ADR-0030): a
  // relative's declared stake in a procurement winner is the same public-interest signal. class
  // family_ownership, relation 'related', own_institution exact. It has real contract money (€250k, cCount>0)
  // so the zero-contract gate keeps it.
  const family = link('888888884', 'Кмет Иванов Тестов');
  assert.equal(family.relation, 'related');
  assert.equal(family.interest_class, 'family_ownership');
  // #279 NARROWS the family surface, and this is where it shows. The registered owner of a family
  // stake is the RELATIVE, whose name we deliberately never store (ADR-0010 item 4, ADR-0032 #2) — so
  // rung 2 („Документ") can never fire for a family link, by construction. Its identity can only be
  // confirmed by something the OFFICIAL declared: the seat, or the ЕИК. Кмет declared neither, so his
  // link is now HELD rather than published. ADR-0032's decision is untouched — family publishes on the
  // named surface exactly like self — but it now needs the same registry evidence as everything else.
  assert.equal(family.status, 'held');
  assert.equal(family.publish_tier, 'unknown');
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
  const alfa = link('181818187', 'Алфа Иванов Партньоров');
  const beta = link('181818187', 'Бета Иванов Партньоров');
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
  const zero = link('121212129', 'Нула Иванов Тестов');
  assert.equal(zero.contract_count, 0);
  assert.equal(zero.interest_class, 'private_ownership'); // it IS own material ownership …
  assert.equal(zero.publish_tier, 'document'); // … with registry evidence …
  assert.equal(zero.status, 'internal'); // … but the zero-contract gate withholds it from the surface

  // SECURITIES/materiality: a self holding of LISTED joint-stock shares forms NO ownership link.
  assert.equal(link('999999998', 'Акционер Иванов Тестов'), undefined);
  // but it is still recorded as a declared interest (census), tagged kind securities
  assert.equal(
    db.prepare("SELECT kind FROM declared_interests WHERE entity_raw='ЛИСТЕД ТЕСТ АД'").get().kind,
    'securities',
  );

  // B1 divest-to-ZERO: Пълен owned ДИВЕСТ ЗЕРО in 2019, then filed an EMPTY declaration in 2023 (no holdings
  // row — only a filings.jsonl entry). The empty filing advances his horizon to 2023, so the 2019 stake is
  // WITHDRAWN. Without the filing horizon (pre-B1) his scope-max would be 2019 and this would stay published.
  const divZero = link('101010104', 'Пълен Иванов Дивестов');
  assert.equal(divZero.interest_class, 'private_ownership');
  assert.equal(divZero.last_declared_year, '2019'); // dated to its last declaration, never asserted current
  assert.equal(divZero.status, 'withdrawn'); // caught by the empty later filing (B1)

  // #226 (Todor B1) PER-TYPE horizon: Интер declared ИНТЕР ТЕХ 8 only in an INTERESTS declaration (2020) and
  // later filed only an ASSET declaration (2023) that, for him, lists no company. A per-person horizon reads
  // that asset-declaration silence as a sale and WITHDRAWS the stake; the per-type horizon must not — no later
  // INTERESTS filing omits the company. This link must stay PUBLISHED. (Guards against dropping a true link:
  // 13% of holders declare a stake only in the interests declaration.)
  // ADR-0035 — the CRITICAL, end to end. Хомоним declared a stake in „ХОМОНИМ ТРЕЙД ЕООД"; the company he
  // actually owns never bid, so `resolveEntity` resolved his declaration to the same-named WINNER, whose
  // deed names a person with his exact three tokens. Rung 2 matches. It must NOT publish: the register
  // proves someone of that name owns THIS company, not that this is the company he declared. `nameGlobally-
  // Unique` cannot catch it — it ranges over bidders, and this winner is the only bidder with the name.
  const homonym = link('242424248', 'Хомоним Иванов Тестов');
  assert.equal(homonym.publish_tier, 'document_uncorroborated');
  assert.notEqual(homonym.status, 'published');
  // The seal must record WHY it was withheld, and must not carry the role the rung refused to assert.
  const homonymSeal = db
    .prepare(
      'SELECT evidence_kind, registry_role, matched_fact FROM interest_link_evidence WHERE link_key=?',
    )
    .get(homonym.link_key);
  assert.equal(homonymSeal.evidence_kind, 'document_uncorroborated');
  assert.equal(homonymSeal.registry_role, null);
  assert.equal(homonymSeal.matched_fact, null);

  // §1.3 unparseable filing YEAR: Безгодин's later declaration has an unreadable <year> ('н/д') but a 2023
  // FOLDER. Dropping that record — the pre-fix behaviour — leaves his horizon at 2019, so `divested` stays
  // false and a stake he no longer holds keeps naming him on the public surface. The folder must date it.
  const noYear = link('212121218', 'Безгодин Иванов Дивестов');
  assert.equal(noYear.interest_class, 'private_ownership');
  assert.equal(noYear.status, 'withdrawn');
  // POSITIVE CONTROL: datable by NEITHER field ⇒ ignored, not guessed. The fallback must not become a
  // licence to invent a horizon — an undatable filing is no evidence of a sale, so this link stays up.
  const noDate = link('232323231', 'Дрънкан Иванов Тестов');
  assert.equal(noDate.status, 'published');

  const crossType = link('161616163', 'Интер Иванов Тестов');
  assert.equal(crossType.interest_class, 'private_ownership');
  assert.equal(crossType.status, 'published'); // NOT withdrawn — the later asset filing is a different type

  // B4 UNKNOWN holder: an ambiguous holder cell forms NO link at all (counted nowhere) — it must never
  // reach the leaderboard, self or family (ADR-0032). Двусмислен gets no interest_link.
  assert.equal(link('111111119', 'Двусмислен Иванов Тестов'), undefined);
  // but the person + declared_interest are still recorded (census), and it is neither self nor family.
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM interest_links il JOIN persons p ON p.id=il.person_id WHERE p.name='Двусмислен Иванов Тестов'",
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
  const kanon = link('131313136', 'Канонов Иванов Тестов');
  assert.equal(kanon.status, 'published'); // distinctive, private ownership, has a contract
  // N10 empty-institution: an empty institution cannot distinguish homonyms → Безинст forms NO link.
  assert.equal(link('141414141', 'Безинст Иванов Тестов'), undefined);
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
  // 20 links: 15 self (incl. withdrawn/held + the zero-contract 'internal' + Пълен's divest-to-zero
  // 'withdrawn' + Безгодин's folder-dated 'withdrawn' + Дрънкан's undatable-filing 'published' +
  // Хомоним's ADR-0035 'document_uncorroborated' hold + Интер's per-type-kept published link) + 2 family (Кмет's, now held for want of registry evidence,
  // and Кметица's seat-confirmed one) + Канонов's canonicalized single link +
  // Алфа & Бета (two officials on one winner, ПАРТНЬОРИ 5); Мария (quarantined), Акционер (securities),
  // Двусмислен (unknown holder) & Безинст (empty institution) none.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM interest_links').get().n, 20);
  // 23 persons: everyone who declared a holding, incl. no-link Мария, Акционер, Двусмислен, Безинст,
  // zero-contract Нула, the two ПАРТНЬОРИ co-owners, the two §1.3 filing-date cases and Хомоним;
  // Канонов's two institution-variant filings fold to ONE.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM persons').get().n, 23);
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

// ── the fail-closed evidence gates (ADR-0033 decision 7) ─────────────────────────────────────────
// Both directions of "no evidence ⇒ no publish", because the partial case is the dangerous one: it does
// NOT fail loudly downstream. An 80%-restored cache yields roughly 80 published links, which clears
// ship-related-persons.mjs's floor of 50 — so it would ship a decimated surface and then wipe the rest
// of the live links. The loader is the only place that can still tell the difference.
test('a MISSING Trade Register cache refuses the whole load', () => {
  const gone = path.join(dir, 'no-such-cache.sqlite');
  assert.throws(
    () => runLoad({ TR_CACHE_DB: gone }),
    /REFUSE TO LOAD[\s\S]*no Trade Register cache/,
  );
});

test('a verdict from an OLDER rules version is held, never published', () => {
  // The last fail-closed check before publishing a claim about a named person, and it was untested:
  // both `rules_version` comparisons could be deleted with all 273 tests still green. Without it a
  // forgotten RULES_VERSION bump means a correction to the evidence ladder does not withdraw the
  // claims the old ladder made — for as long as the verdict cache keeps them.
  const staleDb = path.join(dir, 'stale-rules.sqlite');
  const staleRaw = path.join(dir, 'stale-rules-deeds');
  buildTrCache(staleDb, staleRaw, { 111111119: { managers: ['ИВАН ПЕТРОВ ТЕСТОВ'] } });

  const before = (() => {
    runLoad({ TR_CACHE_DB: staleDb, TR_RAW_DIR: staleRaw });
    const db = open();
    const n = db.prepare(`SELECT COUNT(*) n FROM interest_links WHERE status='published'`).get().n;
    db.close();
    return n;
  })();
  assert.ok(before > 0, 'the fixture must publish something for this to prove anything');

  // Age the LADDER, not the lookup: same inputs, same freshness, a version the code no longer speaks.
  const cache = new DatabaseSync(staleDb);
  cache.exec(`UPDATE verdicts SET rules_version = 'tr-rules-0'`);
  cache.close();

  assert.throws(
    () => runLoad({ TR_CACHE_DB: staleDb, TR_RAW_DIR: staleRaw }),
    /REFUSE TO LOAD[\s\S]*current registry verdict/,
    'not one claim may ride a ladder version this code no longer speaks — and the run says so loudly',
  );
  runLoad(); // restore the full built state for any later reader
});

test('a MOSTLY complete cache still publishes — an incremental crawl has to be able to', () => {
  // The change that makes an incremental crawl possible at all: a run whose crawl was cut short must
  // still publish. Note what „incomplete" now means — a verdict merely past its refresh age is still
  // usable, because the loader's currency test ignores age deliberately. Only a link that has NEVER
  // been decided counts against the floor, and a few of those are tolerable.
  const partialDb = path.join(dir, 'partial-warm.sqlite');
  const partialRaw = path.join(dir, 'partial-warm-deeds');
  buildTrCache(partialDb, partialRaw, {}, { omit: ['121212129'] });
  assert.doesNotThrow(() => runLoad({ TR_CACHE_DB: partialDb, TR_RAW_DIR: partialRaw }));
  runLoad(); // restore the full built state for any later reader
});

test('a substantially incomplete cache refuses EVEN WITH a prior published surface', () => {
  // The floor used to switch off entirely the moment anything had ever been published — so one
  // leftover row from a partial ship, or from the direct UPDATE the suppression runbook sanctions,
  // disabled it. Monotonicity would then dutifully protect that single row while a decimated surface
  // shipped past the ship floor of 50 underneath it.
  const partialDb = path.join(dir, 'partial-cold.sqlite');
  const partialRaw = path.join(dir, 'partial-cold-deeds');
  buildTrCache(partialDb, partialRaw, {}, { omit: ['444444447', '777777773', '666666665'] });
  const db = open();
  const prior = db
    .prepare(`SELECT COUNT(*) n FROM interest_links WHERE status='published'`)
    .get().n;
  db.close();
  assert.ok(prior > 0, 'there must be a prior surface for this to prove anything');
  assert.throws(
    () => runLoad({ TR_CACHE_DB: partialDb, TR_RAW_DIR: partialRaw }),
    /REFUSE TO LOAD[\s\S]*current registry verdict/,
  );
  runLoad(); // restore the full built state for any later reader
});

test('--allow-partial-tr is the deliberate, stated override', () => {
  // Without an override a single permanently unreachable ЕИК would deadlock the pipeline forever.
  const partialDb = path.join(dir, 'partial-ok.sqlite');
  const partialRaw = path.join(dir, 'partial-ok-deeds');
  buildTrCache(partialDb, partialRaw, {}, { omit: ['121212129'] });
  assert.doesNotThrow(() =>
    execFileSync(
      'node',
      [
        '--import',
        path.join(HERE, 'register-ts.mjs'),
        path.join(HERE, 'load.mjs'),
        '--allow-partial-tr',
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CACBG_DB: DB,
          CACBG_STAGING: STAGING,
          TR_CACHE_DB: partialDb,
          TR_RAW_DIR: partialRaw,
        },
        stdio: 'pipe',
      },
    ),
  );
  runLoad(); // restore the full-cache state for any later reader
});

test('the candidate ЕИК list is written for the crawler, covering held links too', () => {
  runLoad();
  const listed = fs
    .readFileSync(path.join(STAGING, 'candidate-eiks.txt'), 'utf8')
    .split('\n')
    .filter(Boolean);
  const db = open();
  const all = db
    .prepare('SELECT DISTINCT eik FROM interest_links')
    .all()
    .map((r) => r.eik);
  db.close();
  // Every resolved ЕИК, not just the published ones: a link held for want of evidence still needs a
  // deed to explain why it is held.
  for (const e of all) assert.ok(listed.includes(e), `${e} missing from candidate-eiks.txt`);
  assert.equal(new Set(listed).size, listed.length, 'no duplicates — each ЕИК costs one request');
});

test('every link carries an evidence seal, and no seal carries a name', () => {
  runLoad();
  const db = open();
  const links = db.prepare('SELECT link_key, publish_tier, status FROM interest_links').all();
  const seals = db.prepare('SELECT * FROM interest_link_evidence').all();
  assert.equal(seals.length, links.length, 'a seal for EVERY link, held and withdrawn included');

  // The PRODUCTION predicate, imported from the module that WRITES the vocabulary — a restated regex
  // here was looser than the real one and would have passed a seat token carrying a full name.
  for (const s of seals) {
    assert.ok(isSealedFact(s.matched_fact), s.matched_fact);
    assert.ok(s.rules_version.length > 0);
    assert.match(s.lookup_date, /^\d{4}-\d{2}-\d{2}$/);
  }
  // The rail, stated as an assertion rather than a convention. Scope it precisely: `link_key` carries
  // the OFFICIAL's own identity by design — they are named on the public surface from their own
  // declaration — so the rail is about everyone else. No name that exists only inside a registry deed
  // (a co-owner, a manager, the relative who actually holds a family stake) may reach a sealed column.
  const evidenceOnly = seals.map(({ link_key: _ignored, ...rest }) => rest);
  const blob = JSON.stringify(evidenceOnly).toUpperCase();
  for (const thirdParty of [
    'РОДНИНА', // the relative who owns the family company
    'СЪВСЕМ ДРУГ СОБСТВЕНИК', // a registry co-owner nobody declared
    'НЯКОЙ ДРУГ',
    'ДРУГ СОБСТВЕНИК',
  ])
    assert.ok(!blob.includes(thirdParty), `a third-party name reached the seal: ${thirdParty}`);
  // …and the declarant's name must not be duplicated into the evidence fields either.
  for (const surname of ['ТЕСТОВ', 'ДИВЕСТОВ', 'ПАРТНЬОРОВ'])
    assert.ok(!blob.includes(surname), `a declarant name reached an evidence column: ${surname}`);
  db.close();
});

test('a family stake publishes ONLY when the official confirmed the company themselves', () => {
  // The positive control for the narrowest published path. A family link can never earn „Документ" —
  // the registered owner is the relative, whose name we never hold — so it stands or falls on the seat
  // or ЕИК the OFFICIAL declared. Without this case „family published: 0" would be indistinguishable
  // from a structurally dead path (ADR-0027).
  runLoad();
  const db = open();
  const withSeat = db
    .prepare(
      "SELECT il.status, il.publish_tier FROM interest_links il JOIN persons p ON p.id=il.person_id WHERE il.eik='191919199' AND p.name='Кметица Иванова Втора'",
    )
    .get();
  assert.equal(withSeat.status, 'published');
  assert.equal(withSeat.publish_tier, 'confirmed');
  const seal = db
    .prepare(
      "SELECT matched_fact FROM interest_link_evidence WHERE link_key LIKE '%191919199|family'",
    )
    .get();
  assert.equal(seal.matched_fact, 'seat:РУСЕ');
  db.close();
});

test('the published surface is exported BEFORE the wipe, so the audit can gate monotonicity', () => {
  // ADR-0033 decision 6. The loader rebuilds the CACBG tables from scratch every run, so the previous
  // published set exists only in the instant before the DROP. Without this export the audit has
  // nothing to compare against and the monotonicity gate can never fire — which is precisely the state
  // review found: rules_version was written and never read.
  // A FIRST run, on its own database: interest_links does not exist yet, so the export must be an
  // empty set that is WRITTEN rather than skipped — a missing file has to keep meaning „the loader
  // never ran", not „nothing was published".
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-load-first-'));
  fs.mkdirSync(path.join(fresh, 'staging'), { recursive: true });
  for (const f of fs.readdirSync(STAGING))
    fs.copyFileSync(path.join(STAGING, f), path.join(fresh, 'staging', f));
  // The base DB (bidders, contracts) comes from the main pipeline and is a precondition of the load —
  // a genuinely empty file is not a first run, it is a broken one. So: copy the base and drop the
  // CACBG tables, which is exactly the state before the loader has ever run against it.
  const firstDb = path.join(fresh, 'first.sqlite');
  fs.copyFileSync(DB, firstDb);
  const fdb = new DatabaseSync(firstDb);
  for (const t of [
    'interest_link_evidence',
    'interest_link_authorities',
    'interest_links',
    'declared_interests',
    'related_persons_internal',
    'declarations',
    'persons',
  ])
    fdb.exec(`DROP TABLE IF EXISTS ${t}`);
  fdb.close();
  runLoad({ CACBG_DB: firstDb, CACBG_STAGING: path.join(fresh, 'staging') });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(fresh, 'staging', 'published-snapshot.json'), 'utf8')),
    [],
  );
  fs.rmSync(fresh, { recursive: true, force: true });

  const SNAP = path.join(STAGING, 'published-snapshot.json');
  runLoad();
  const db = open();
  const published = db
    .prepare("SELECT link_key FROM interest_links WHERE status='published'")
    .all()
    .map((r) => r.link_key);
  db.close();
  assert.ok(published.length > 0, 'fixture must publish something for this test to mean anything');

  runLoad();
  const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  assert.deepEqual(
    snap.map((s) => s.link_key).sort(),
    [...published].sort(),
    'the export must hold exactly what was published before the wipe',
  );
  // rules_version travels WITH each key: the gate distinguishes „vanished under unchanged rules"
  // (a regression) from „vanished under a rules bump" (an intentional removal), and it cannot do that
  // from the current version alone.
  for (const s of snap)
    assert.ok(s.rules_version?.length > 0, 'each exported key carries its rules');
  // Held and withdrawn links must NOT be exported — they were never a public claim, so their absence
  // next run is not a regression to gate on.
  assert.equal(snap.length, published.length);
});

// The crawl input and the crawl's consumer are the same script, which used to make the two workflows
// deadlock: the decision run refused without a deed cache, the refresh run refused without a candidate
// list, and each produced only what the other needed. Merged into one job, the job still has to be able
// to BOOTSTRAP — produce the candidate list on a runner that has no cache yet — and it cannot do that by
// running the full load and ignoring a non-zero exit, because that exit is also how a genuinely broken
// run reports itself. Hence an explicit mode that stops at the list and succeeds.
test('--emit-candidates writes the crawl list and exits 0 with NO Trade Register cache', () => {
  const gone = path.join(dir, 'bootstrap-absent.sqlite');
  const listFile = path.join(STAGING, 'candidate-eiks.txt');
  fs.rmSync(listFile, { force: true });
  assert.doesNotThrow(() =>
    execFileSync(
      'node',
      [
        '--import',
        path.join(HERE, 'register-ts.mjs'),
        path.join(HERE, 'load.mjs'),
        '--emit-candidates',
      ],
      {
        cwd: ROOT,
        env: { ...process.env, CACBG_DB: DB, CACBG_STAGING: STAGING, TR_CACHE_DB: gone },
        stdio: 'pipe',
      },
    ),
  );
  const listed = fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean);
  assert.ok(listed.length > 0, 'the bootstrap must actually produce candidates');
  assert.equal(new Set(listed).size, listed.length);
  runLoad(); // restore the full built state for any later reader
});

function emitCandidates(trCacheDb) {
  execFileSync(
    'node',
    [
      '--import',
      path.join(HERE, 'register-ts.mjs'),
      path.join(HERE, 'load.mjs'),
      '--emit-candidates',
    ],
    {
      cwd: ROOT,
      env: { ...process.env, CACBG_DB: DB, CACBG_STAGING: STAGING, TR_CACHE_DB: trCacheDb },
      stdio: 'pipe',
    },
  );
}

test('a bootstrap pass leaves the REAL work DB untouched — it runs on a throwaway copy', () => {
  // Reaching the candidate list means rebuilding the corpus tables, and the pass never publishes, so
  // against the real DB it would leave interest_links empty. That is the damage: not the pass itself,
  // but what the NEXT run then reads.
  runLoad();
  const db = open();
  const before = db.prepare('SELECT COUNT(*) AS n FROM interest_links').get().n;
  db.close();
  assert.ok(before > 0, 'the fixture must actually publish something');

  emitCandidates(path.join(dir, 'bootstrap-absent-2.sqlite'));

  const after = open();
  assert.equal(
    after.prepare('SELECT COUNT(*) AS n FROM interest_links').get().n,
    before,
    'the bootstrap pass must not empty the domain it was pointed at',
  );
  after.close();
  assert.equal(fs.existsSync(`${DB}.bootstrap`), false, 'the throwaway copy must be cleaned up');
});

test('a published link with no evidence row (pre-#309 regime) carries null rules_version, not a masking fallback', () => {
  // The one-way transition #309 introduced. interest_links pre-dates interest_link_evidence: any
  // link published before ADR-0033 landed has no evidence row and no rules_version to travel with.
  // Defaulting the LEFT JOIN miss to RULES_VERSION erased that distinction and made the audit see 37
  // legitimate regime-transition removals as silent recalls on the first post-#309 staging run
  // (32736025202). The snapshot has to carry null through so declaredRemoval can read it.
  const SNAP = path.join(STAGING, 'published-snapshot.json');
  runLoad();
  // Read-only lookup, then a writable connection to simulate the pre-#309 state.
  const rdb = open();
  const preExistingKey = rdb
    .prepare("SELECT link_key FROM interest_links WHERE status='published' LIMIT 1")
    .get().link_key;
  rdb.close();
  const wdb = new DatabaseSync(DB);
  // Simulate the pre-#309 state: this key was published before the evidence table existed, so its
  // evidence row is gone. The current run's REBUILD would resurface it, but the snapshot export
  // reads what stands BEFORE the wipe — which on staging on 2026-08-24 was 103 such orphaned rows.
  wdb.prepare('DELETE FROM interest_link_evidence WHERE link_key = ?').run(preExistingKey);
  wdb.close();
  runLoad();
  const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  const orphan = snap.find((s) => s.link_key === preExistingKey);
  assert.ok(
    orphan,
    'the pre-evidence link must still appear in the snapshot — the gate needs to see it',
  );
  assert.equal(
    orphan.rules_version,
    null,
    'a missing evidence row must surface as null, not as the current RULES_VERSION',
  );
});

test('the monotonicity gate still sees a prior surface AFTER a bootstrap pass', () => {
  // The end-to-end shape of the merged workflow: real run → bootstrap (to produce the crawl list) →
  // real run. If the bootstrap emptied interest_links, the second real run would export an EMPTY
  // prior-published set, and the gate — whose only job is to notice a published claim disappearing —
  // would pass unconditionally, for ever.
  const snapshot = path.join(STAGING, 'published-snapshot.json');
  runLoad();
  emitCandidates(path.join(dir, 'bootstrap-absent-3.sqlite'));
  runLoad();
  const prior = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  assert.ok(
    prior.length > 0,
    'the snapshot went empty — the gate is now vacuous and would never fire again',
  );
});

// ── the corrections list — ADR-0033 decision 6's second sanctioned removal ────────────────────────
// Decision 6 licenses removal by „a rules-version bump, or a correction of wrong input". Only the
// first was expressible. Suppression cannot carry a correction: correcting the input UNBUILDS the
// link, and the B3 unused-suppression gate above then fails the build for a fingerprint that matched
// nothing — so the two sanctioned removals failed in opposite directions and a real correction had no
// path at all. The list is fingerprinted for the same reason ADR-0031's is: `pid|eik` in git would
// record which named official was linked to which company, for ever.

test('a corrections entry marks its key in the snapshot, so the audit reads a declared removal', () => {
  runLoad();
  const db = open();
  const key = db
    .prepare("SELECT link_key FROM interest_links WHERE status='published' LIMIT 1")
    .get().link_key;
  db.close();

  const corrFile = path.join(dir, 'corr.jsonl');
  fs.writeFileSync(
    corrFile,
    JSON.stringify({
      fp: fingerprint(key, SUPP_SALT),
      key_version: '1',
      reason: 'the declaration row was misparsed; the stake was never declared',
      corrected_at: '2026-08-11',
    }) + '\n',
  );
  runLoad({ CACBG_CORRECTIONS_LIST: corrFile, SUPPRESSION_SALT: SUPP_SALT });

  const snap = JSON.parse(fs.readFileSync(path.join(STAGING, 'published-snapshot.json'), 'utf8'));
  const marked = snap.find((s) => s.link_key === key);
  assert.ok(marked, 'the key must still be exported — the gate needs to SEE it leave');
  assert.equal(marked.corrected, true);
  // Every other key stays unflagged: an acknowledgement is per-link, never a blanket amnesty.
  assert.equal(
    snap.filter((s) => s.corrected === true).length,
    1,
    'one acknowledgement must not clear the whole surface',
  );
});

test('a corrections entry matching NO previously published link fails the build', () => {
  // The B3 rail, mirrored. A stale acknowledgement is worse than a missing one: it sits in the list
  // and would clear a FUTURE disappearance of the same link — the exact regression the gate exists to
  // catch — with nobody having decided that.
  const corrFile = path.join(dir, 'corr-stale.jsonl');
  fs.writeFileSync(
    corrFile,
    JSON.stringify({
      fp: fingerprint('p-nobody|999999999', SUPP_SALT),
      key_version: '1',
      reason: 'stale',
      corrected_at: '2026-08-11',
    }) + '\n',
  );
  runLoad();
  assert.throws(
    () => runLoad({ CACBG_CORRECTIONS_LIST: corrFile, SUPPRESSION_SALT: SUPP_SALT }),
    (err) =>
      /correction/i.test(String(err.stderr ?? '') + String(err.message ?? '')) &&
      /matched NO/i.test(String(err.stderr ?? '') + String(err.message ?? '')),
  );
});

test('corrections are fail-closed on a missing salt, exactly like suppressions', () => {
  const corrFile = path.join(dir, 'corr-nosalt.jsonl');
  fs.writeFileSync(
    corrFile,
    JSON.stringify({ fp: 'deadbeef', key_version: '1', reason: 'x', corrected_at: '2026-08-11' }) +
      '\n',
  );
  assert.throws(
    () => runLoad({ CACBG_CORRECTIONS_LIST: corrFile, SUPPRESSION_SALT: '' }),
    (err) => /SUPPRESSION_SALT is unset/.test(String(err.stderr ?? '') + String(err.message ?? '')),
  );
});
