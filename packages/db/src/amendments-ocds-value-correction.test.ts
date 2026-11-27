// Exercise signing corrections through the actual full-build and daily SQL paths.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_SCHEMA } from './base-schema';
import { AMENDMENTS_SQL } from './queries/details';
import {
  BASE_CONTRACT_COLS,
  baseSqlLiteral,
  escapeSqlText,
  mapBaseRecord,
} from '../../ingest/src/base';
import {
  AMENDMENT_STAGING_COLS,
  CONTRACT_STAGING_COLS,
  parseOcdsPackage,
  releaseToAmendments,
  releaseToContracts,
  type OcdsPackage,
  type OcdsRelease,
} from '../../ingest/src/ocds';
import {
  assertIntegrity,
  checkContractValueRule,
  checkOcdsSourceValue,
} from '../../../scripts/integrity-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration = (name: string) => resolve(root, 'packages/db/migrations', name);
const WORK_SCHEMA = [
  ...BASE_SCHEMA,
  migration('0001_flow_pairs_bidder_index.sql'),
  migration('0002_current_value_currency.sql'),
  migration('0003_related_persons_foundation.sql'),
  migration('0009_interest_link_evidence.sql'),
  migration('0013_registry.sql'),
  migration('0014_person_profile.sql'),
  migration('0015_person_observations.sql'),
  migration('0017_registry_identity_observations.sql'),
  migration('0018_person_entities.sql'),
  migration('0006_amendment_restated.sql'),
  migration('0007_amendment_value_suspect.sql'),
];
const script = (name: string) => resolve(root, 'scripts', name);
const workStagingSchema = script('work-staging-schema.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', ['-bail', dbPath], { input: sql, encoding: 'utf8' });
}

function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], {
    input: `PRAGMA foreign_keys=ON;\n.read ${path}\n`,
    stdio: 'pipe',
  });
}

function initWorkDb(dbPath: string): void {
  for (const file of WORK_SCHEMA) readScript(dbPath, file);
  readScript(dbPath, workStagingSchema);
}

// A new staging lifecycle between two daily windows: the raw tables hold only the next window.
function resetRawStaging(dbPath: string): void {
  const rows = sqliteJson<{ name: string; type: 'view' | 'table' }>(
    dbPath,
    "SELECT name, type FROM sqlite_master WHERE type IN ('view', 'table') AND name GLOB 'raw_*' ORDER BY type DESC",
  );
  for (const row of rows) sqlite(dbPath, `DROP ${row.type} IF EXISTS "${row.name}";`);
  readScript(dbPath, workStagingSchema);
}

function fullBuild(dbPath: string, seed: string): void {
  initWorkDb(dbPath);
  sqlite(dbPath, seed);
  readScript(dbPath, script('resolve-amendment-contracts.sql'));
  readScript(dbPath, script('derive-amendments.sql'));
  readScript(dbPath, script('normalize-raw.sql'));
  readScript(dbPath, script('promote-amendments.sql'));
  readScript(dbPath, script('precompute.sql'));
}

// The daily path: each window is staged afresh and refreshed in turn.
function dailyWindows(dbPath: string, windows: string[]): void {
  initWorkDb(dbPath);
  windows.forEach((seed, i) => {
    if (i > 0) resetRawStaging(dbPath);
    sqlite(dbPath, seed);
    readScript(dbPath, script('refresh-slice.sql'));
  });
}

const UNP = '09999-2026-0001';
const TENDER_ID = '900001';
const OCID = `ocds-e82gsb-${TENDER_ID}`;
const CONTRACT = 'D-1001';
// The procedure estimate, the value the authority meant, and the same value with the decimal comma two
// places to the right — a hundred times too much, the shape of the source defect.
const ESTIMATE = 4180000;
const CORRECT = 3741205;
const MISTYPED = 374120500;

function tender(currency = 'EUR'): string {
  return `INSERT INTO raw_tenders
      (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
       cpv_code, cpv_description, contract_kind, estimated_value, currency, authority_name,
       authority_eik, authority_type, published_at)
    VALUES
      ('eop:tenders:2026-10-01', 2026, '2026-10-02T00:00:00Z', '${UNP}', '${TENDER_ID}', 'open',
       'Test tender', '45000000', 'Construction', 'works', ${ESTIMATE}, '${currency}', 'Община Тест',
       '733456781', 'public', '2026-10-01');`;
}

function contract(
  signing: number,
  currency = 'EUR',
  { number = CONTRACT, supplier = '787777778' } = {},
): string {
  return `INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
       published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
       cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
       award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
       lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
       awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
       eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
    VALUES
      ('eop:contracts:2026-10-05', 2026, 'eop', '2026-10-06T00:00:00Z', 0, 'DOC-${number}',
       '2026-10-05', '${UNP}', '${TENDER_ID}', 'open', 'Test tender', '45000000',
       'Construction', 'works', ${ESTIMATE}, '${currency}', 'basis', 'lowest', 'Община Тест',
       '733456781', 'public', 'activity', 'notice', NULL, '${number}', '2026-10-05', ${signing},
       '${currency}', 'Test contract', 0, '${supplier}', 'ТЕСТ ГРУП ЕООД', 'BG', 'small', 0, 1, 1, 0, 0, 365);`;
}

function eopAnnex(before: number, after: number, day = '2026-11-02', number = CONTRACT): string {
  return `INSERT INTO raw_amendments
      (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number, contract_number,
       contract_date, published_at, unp, authority_eik, authority_name, procurement_subject,
       contract_kind, value_before, value_after, value_delta, currency, description, contractor_eik)
    VALUES
      ('eop:annexes:${day}', 2026, 'eop', '${day}T06:00:00Z', '1', 'ANX-${day}', '${number}',
       '2026-10-05', '${day}', '${UNP}', '733456781', 'Община Тест', 'Test tender', 'works',
       ${before}, ${after}, ${after - before}, 'EUR', 'EOP annex', '999999995');`;
}

const NOTE = 'Техническа грешка в стойността на договора';

function ocdsSigning(
  value: number | undefined,
  { day = '2026-10-05', document = 'TEST-SIGNING' } = {},
): string {
  const [row] = releaseToContracts(
    {
      ocid: OCID,
      id: document,
      tag: ['contract'],
      date: `${day}T06:00:00Z`,
      tender: { id: TENDER_ID, value: { amount: ESTIMATE, currency: 'EUR' } },
      buyer: { id: 'TEST-BUYER', name: 'Община Тест' },
      parties: [
        {
          id: 'TEST-BUYER',
          roles: ['buyer'],
          identifier: { id: '733456781' },
          name: 'Община Тест',
        },
      ],
      contracts: [
        { id: CONTRACT, dateSigned: '2026-10-05', value: { amount: value, currency: 'EUR' } },
      ],
    },
    {
      source: `ocds:${day}`,
      year: 2026,
      datasetUri: null,
      resourceUri: null,
      fetchedAt: `${day}T06:00:00Z`,
    },
  );
  const values = CONTRACT_STAGING_COLS.map((col) => sqlValue(row?.[col]));
  return `INSERT INTO raw_contracts (${CONTRACT_STAGING_COLS.join(', ')}) VALUES (${values.join(', ')});`;
}

function sqlValue(value: number | string | null | undefined) {
  if (value == null) return 'NULL';
  return typeof value === 'number' ? String(value) : escapeSqlText(value);
}

function mappedSigning(
  lot: string,
  value: number | undefined,
  currency: string | undefined,
  day = '2026-10-05',
): string {
  const row = mapBaseRecord(
    'contracts',
    {
      uniqueProcurementNumber: UNP,
      tenderId: TENDER_ID,
      noticeId: `DOC-${lot}-${day}`,
      publicationDate: day,
      contractNumber: CONTRACT,
      contractDate: '2026-10-05',
      lotIdentifier: lot,
      buyerName: 'Община Тест',
      buyerRegistryNumber: '733456781',
      supplierName: 'ТЕСТ ГРУП ЕООД',
      supplierRegisterNumber: '787777778',
      contractValue: value,
      contractCurrency: currency,
    },
    { day, fetchedAt: `${day}T06:00:00Z` },
  );
  expect(row).toMatchObject({ signing_value: value ?? null, currency: currency ?? null });
  const values = BASE_CONTRACT_COLS.map((col) => baseSqlLiteral('contracts', col, row?.[col]));
  return `INSERT INTO raw_contracts (${BASE_CONTRACT_COLS.join(', ')}) VALUES (${values.join(', ')});`;
}

interface ReportOptions {
  day?: string;
  amount?: number | string;
  currency?: string;
  dateSigned?: string;
  taggedAmendment?: boolean;
  document?: boolean;
  publication?: string;
  timestamp?: string;
  rationale?: string;
  tenderId?: string | null;
  jsonAmount?: string;
}

function mappedRelease({
  day = '2026-11-24',
  amount = CORRECT,
  currency = 'EUR',
  dateSigned = '2026-10-05',
  taggedAmendment = false,
  document = true,
  publication = `TEST-REPORT-${day}`,
  timestamp = `${day}T06:00:00Z`,
  rationale = NOTE,
  tenderId = TENDER_ID,
  jsonAmount,
}: ReportOptions = {}): string {
  let release: OcdsRelease = {
    ocid: OCID,
    id: document ? publication : undefined,
    date: timestamp,
    tag: [taggedAmendment ? 'contractAmendment' : 'contractUpdate'],
    tender: tenderId === null ? undefined : { id: tenderId },
    contracts: [
      {
        id: CONTRACT,
        dateSigned,
        value: { amount: jsonAmount === undefined ? amount : 'TEST-RAW-AMOUNT', currency },
        amendments: [{ rationale }],
      },
    ],
  };
  if (jsonAmount !== undefined) {
    const json = JSON.stringify({ releases: [release] }).replace('"TEST-RAW-AMOUNT"', jsonAmount);
    const pkg = parseOcdsPackage(json) as OcdsPackage;
    release = pkg.releases![0]!;
  }
  const [row] = releaseToAmendments(release, {
    source: `ocds:${day}`,
    datasetUri: null,
    resourceUri: null,
    year: 2026,
    fetchedAt: `${day}T06:00:00Z`,
  });
  expect(row).toMatchObject({
    value_before: Number(jsonAmount ?? amount),
    value_after: null,
    currency,
  });
  const values = AMENDMENT_STAGING_COLS.map((col) => sqlValue(row?.[col]));
  return `INSERT INTO raw_amendments (${AMENDMENT_STAGING_COLS.join(', ')}) VALUES (${values.join(', ')});`;
}

interface ContractState {
  signing_value: number;
  signing_value_original: number;
  annex_count: number;
  current_value: number | null;
  value_flag: string;
  amount: number;
  amount_eur: number;
}

const contractState = (dbPath: string): ContractState | undefined =>
  sqliteJson<ContractState>(
    dbPath,
    `SELECT signing_value, signing_value_original, annex_count, current_value, value_flag, amount, ROUND(amount_eur, 2) AS amount_eur,
       signing_value_eur, current_value_eur, current_value_currency,
       fx_converted, fx_rate
     FROM contracts WHERE contract_number = '${CONTRACT}' ORDER BY id`,
  )[0];

const timeline = (dbPath: string) =>
  sqliteJson<Record<string, unknown>>(
    dbPath,
    `SELECT published_at, substr(source, 1, 4) AS source, value_before, value_after, value_delta,
       raw_value_after, raw_value_delta, value_evidence_known, value_suspect, description
     FROM amendments WHERE contract_number = '${CONTRACT}' ORDER BY published_at, id`,
  );

const homeValue = (dbPath: string) =>
  sqliteJson<{ v: number }>(dbPath, 'SELECT ROUND(value_eur, 2) AS v FROM home_totals')[0]?.v;

const integrityRunner = (dbPath: string) => (sql: string) =>
  sqliteJson<Record<string, unknown>>(dbPath, sql);
const valueRule = (dbPath: string) => checkContractValueRule(integrityRunner(dbPath));
const sourceValueGate = (dbPath: string, build = false) =>
  checkOcdsSourceValue(integrityRunner(dbPath), { build });

let dir: string;
let fullDb: string;
let dailyDb: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'sigma-ocds-value-correction-'));
  fullDb = resolve(dir, 'full.sqlite');
  dailyDb = resolve(dir, 'daily.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function snapshot(db: string) {
  return {
    contracts: contractState(db),
    history: timeline(db),
    homeValue: homeValue(db),
    bidderTotals: sqliteJson(db, 'SELECT won_eur FROM company_totals'),
    authorityTotals: sqliteJson(db, 'SELECT spent_eur FROM authority_totals'),
    flowTotals: sqliteJson(db, 'SELECT won_eur FROM flow_pairs'),
    reports: sqliteJson(db, 'SELECT * FROM contract_signing_corrections ORDER BY document_number'),
  };
}

function replay(db: string, update: string) {
  resetRawStaging(db);
  sqlite(db, update);
  readScript(db, script('refresh-slice.sql'));
}

async function expectClean(db: string) {
  for (const build of [false, true])
    expect(await sourceValueGate(db, build)).toMatchObject({
      ok: true,
      warn: false,
      skipped: false,
    });
  expect(await valueRule(db)).toMatchObject({ ok: true });
}

describe('technical source values across full build and daily refresh', () => {
  it('revokes a correction when a distinct unpriced OCDS signing arrives', async () => {
    const first = tender() + ocdsSigning(9000);
    const correction = mappedRelease({ amount: 1200 });
    const unpriced = ocdsSigning(undefined, {
      day: '2026-11-26',
      document: 'TEST-UNPRICED-SIGNING',
    });
    fullBuild(fullDb, first + correction + unpriced);
    dailyWindows(dailyDb, [first, correction]);
    expect(homeValue(dailyDb)).toBe(1200);
    replay(dailyDb, unpriced);
    for (const db of [fullDb, dailyDb]) {
      expect(sqliteJson(db, 'SELECT ocds_signing_incomplete FROM contracts')).toEqual([
        { ocds_signing_incomplete: 1 },
      ]);
      expect(snapshot(db)).toMatchObject({
        homeValue: 9000,
        bidderTotals: [{ won_eur: 9000 }],
        authorityTotals: [{ spent_eur: 9000 }],
        flowTotals: [{ won_eur: 9000 }],
      });
      await expectClean(db);
    }
    replay(dailyDb, first + correction);
    expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
    await expectClean(dailyDb);
  });

  it.each([false, true])(
    'retains public IDs for conflicting OCDS notices (overlap: %s)',
    async (overlap) => {
      const first = tender() + ocdsSigning(9000);
      const correction = mappedRelease({ amount: 1200 });
      const second = ocdsSigning(8000, { day: '2026-11-26', document: 'TEST-SECOND-SIGNING' });
      fullBuild(fullDb, second + correction + first);
      dailyWindows(dailyDb, [first, correction]);
      expect(homeValue(dailyDb)).toBe(1200);
      replay(dailyDb, (overlap ? first : '') + second);
      for (const db of [fullDb, dailyDb]) {
        const prefix = `c:o:${OCID}:${CONTRACT}:_:unknown:анонимен:`;
        expect(
          sqliteJson(db, 'SELECT id, document_number, signing_value FROM contracts ORDER BY id'),
        ).toEqual([
          { id: `${prefix}1`, document_number: 'TEST-SIGNING', signing_value: 9000 },
          { id: `${prefix}2`, document_number: 'TEST-SECOND-SIGNING', signing_value: 8000 },
        ]);
        expect(snapshot(db)).toMatchObject({
          homeValue: 17000,
          bidderTotals: [{ won_eur: 17000 }],
          authorityTotals: [{ spent_eur: 17000 }],
          flowTotals: [{ won_eur: 17000 }],
        });
        await expectClean(db);
      }
      expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
      const before = snapshot(dailyDb);
      replay(dailyDb, second + correction);
      expect(snapshot(dailyDb)).toEqual(before);
    },
  );

  it('reconsiders a served value anchor when a competing signing arrives', async () => {
    const first = tender() + contract(9000, 'EUR', { supplier: '999999995' });
    const annex = eopAnnex(1000, 800, '2026-11-02', 'TEST-ALTERNATE');
    const correction = mappedRelease({ amount: 1000 });
    const second = contract(1000, 'EUR', { number: 'TEST-SECOND', supplier: '999999995' });
    fullBuild(fullDb, first + annex + correction + second);
    dailyWindows(dailyDb, [first, annex, correction]);
    expect(homeValue(dailyDb)).toBe(800);
    replay(dailyDb, second);
    for (const db of [fullDb, dailyDb]) {
      expect(sqliteJson(db, 'SELECT contract_number, link_method FROM amendments')).toEqual([
        { contract_number: 'TEST-ALTERNATE', link_method: null },
      ]);
      expect(snapshot(db)).toMatchObject({
        homeValue: 2000,
        bidderTotals: [{ won_eur: 2000 }],
        authorityTotals: [{ spent_eur: 2000 }],
        flowTotals: [{ won_eur: 2000 }],
      });
      await expectClean(db);
    }
    expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
    const changes = sqlite(
      dailyDb,
      `
      CREATE TRIGGER test_no_anchor_write BEFORE UPDATE ON amendments
      BEGIN SELECT RAISE(ABORT, 'identical correction rewrote an annex'); END;
      CREATE TRIGGER test_no_signing_write BEFORE UPDATE ON contracts
      BEGIN SELECT RAISE(ABORT, 'identical correction rewrote a signing'); END;
      CREATE TRIGGER test_no_report_write BEFORE UPDATE ON ocds_amendment_publications
      BEGIN SELECT RAISE(ABORT, 'identical correction rewrote a source version'); END;
    `,
    );
    expect(changes).toBe('');
    replay(dailyDb, correction);
    expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
  });

  it.each([
    'Техническа грешка в стойността на договора не е допусната.',
    'Техническа грешка в стойността на договора не са установили.',
    'Техническа грешка в стойността на договора не се констатира.',
    'Техническа грешка в стойността на договора няма.',
    'Техническа грешка в стойността на договора липсва.',
    'Без техническа грешка в стойността на договора.',
    'Не е вярно, че има техническа грешка в стойността на договора.',
    'Техническа грешка в стойността на договора, както сочи проверката, не е допусната.',
    'Страните изменят срока за изпълнение. Отстранява се техническа грешка в стойността на договора.',
    'Изменение на срока за изпълнение. Техническа грешка в стойността на договора.',
    'Страните удължават срока. Техническа грешка в стойността на договора.',
    'Страните променят срока на договора. Техническа грешка в стойността на договора.',
    'Страните изменят обхвата на договора. Техническа грешка в стойността на договора.',
    'Срокът за изпълнение се изменя. Техническа грешка в стойността на договора.',
    'Срокът за изпълнение на договора се удължава с един месец. Отстранена е техническа грешка в стойността на договора.',
    'Сроковете за изпълнение на договора бяха съкратени. Техническа грешка в стойността на договора.',
    'Подновява се договореният срок. Техническа грешка в стойността на договора.',
    'Промяна на продължителността на договора. Техническа грешка в стойността на договора.',
  ])('keeps denials and contractual changes in the amendment path (%s)', async (rationale) => {
    const signing = tender() + contract(9000);
    const update = mappedRelease({ amount: 1000, rationale });
    fullBuild(fullDb, signing + update);
    dailyWindows(dailyDb, [signing, update]);
    for (const db of [fullDb, dailyDb]) {
      expect(contractState(db)).toMatchObject({ signing_value: 9000, annex_count: 1 });
      expect(timeline(db)).toMatchObject([{ value_before: 1000, value_after: null }]);
      await expectClean(db);
    }
  });

  it.each([
    ['contractual', {}, { taggedAmendment: true }, 1],
    ['metadata-only', { taggedAmendment: true }, { rationale: '' }, 0],
  ] as const)(
    'keeps the newest %s publication across paths and replays',
    async (kind, oldClass, newClass, annexCount) => {
      const signing = tender() + contract(9000);
      const publication = 'TEST-SHARED-VERSION';
      // The newer instant has the earlier packet name. Both versions are on the same UTC day.
      const older = mappedRelease({
        ...oldClass,
        day: '2026-11-26',
        timestamp: '2026-11-24T10:15:00.1231Z',
        publication,
        amount: 1200,
      });
      const newer = mappedRelease({
        ...newClass,
        day: '2026-11-25',
        timestamp: '2026-11-24T12:15:00.1232+02:00',
        publication,
        amount: 1500,
      });
      fullBuild(fullDb, signing + newer + older);
      dailyWindows(dailyDb, [signing, older]);
      expect(contractState(dailyDb)).toMatchObject({
        signing_value: kind === 'contractual' ? 1200 : 9000,
        annex_count: kind === 'contractual' ? 0 : 1,
      });
      replay(dailyDb, newer);
      for (const db of [fullDb, dailyDb]) {
        expect(contractState(db)).toMatchObject({ signing_value: 9000, annex_count: annexCount });
        expect(timeline(db)).toMatchObject(
          annexCount ? [{ value_before: 1500, value_after: null }] : [],
        );
        await expectClean(db);
        expect(
          sqliteJson(db, 'SELECT kind, published_at FROM ocds_amendment_publications'),
        ).toEqual([
          {
            kind: kind === 'contractual' ? kind : 'metadata',
            published_at: '2026-11-24T10:15:00.1232',
          },
        ]);
      }
      expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
      replay(dailyDb, older);
      expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));

      const reversed = resolve(dir, 'reversed.sqlite');
      dailyWindows(reversed, [signing, newer, older]);
      expect(snapshot(reversed)).toEqual(snapshot(fullDb));
      await expectClean(reversed);
    },
  );

  it('retires a bridged publication when newer metadata omits tender.id', async () => {
    const signing = tender() + contract(9000);
    const publication = 'TEST-RETIRED-PUBLICATION';
    const older = mappedRelease({ publication, taggedAmendment: true });
    const newer = mappedRelease({
      day: '2026-11-25',
      publication,
      rationale: '',
      tenderId: null,
    });
    fullBuild(fullDb, signing + older + newer);
    dailyWindows(dailyDb, [signing, older]);
    expect(sqliteJson(dailyDb, 'SELECT unp FROM amendments')).toEqual([{ unp: UNP }]);
    replay(dailyDb, newer);
    for (const db of [fullDb, dailyDb]) {
      expect(contractState(db)).toMatchObject({ signing_value: 9000, annex_count: 0 });
      expect(timeline(db)).toEqual([]);
      await expectClean(db);
    }
    replay(dailyDb, older);
    expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
    await expectClean(dailyDb);
  });

  it('corrects the OCDS signing when the resolved EOP procedure has no signing for that number', async () => {
    const signing = tender() + ocdsSigning(MISTYPED);
    fullBuild(fullDb, signing + mappedRelease());
    dailyWindows(dailyDb, [signing, mappedRelease()]);
    for (const db of [fullDb, dailyDb]) {
      expect(contractState(db)).toMatchObject({ signing_value: CORRECT, annex_count: 0 });
      expect(homeValue(db)).toBe(CORRECT);
      expect(snapshot(db)).toMatchObject({
        bidderTotals: [{ won_eur: CORRECT }],
        authorityTotals: [{ spent_eur: CORRECT }],
        flowTotals: [{ won_eur: CORRECT }],
      });
      await expectClean(db);
      sqlite(db, 'UPDATE contracts SET signing_value = signing_value_original');
      for (const build of [false, true])
        expect(await sourceValueGate(db, build)).toMatchObject({ ok: false });
    }
  });

  it('moves the correction to the EOP signing when it supersedes the OCDS document', async () => {
    const procedure = tender();
    const ocds = ocdsSigning(1000);
    const eop = contract(1200);
    const correction = mappedRelease({ amount: 1400 });
    fullBuild(fullDb, procedure + ocds + eop + correction);
    dailyWindows(dailyDb, [procedure + ocds, correction]);
    expect(contractState(dailyDb)).toMatchObject({
      signing_value: 1400,
      signing_value_original: 1000,
    });
    replay(dailyDb, eop);
    for (const db of [fullDb, dailyDb]) {
      expect(
        sqliteJson(db, 'SELECT tender_id, signing_value_original, signing_value FROM contracts'),
      ).toEqual([{ tender_id: `t:${UNP}`, signing_value_original: 1200, signing_value: 1400 }]);
      await expectClean(db);
    }
  });

  it('revisits a served alternate-number annex when the correction supplies its signing anchor', async () => {
    const signing = tender() + contract(MISTYPED, 'EUR', { supplier: '999999995' });
    const after = CORRECT * 0.8;
    const annex = eopAnnex(CORRECT, after, '2026-11-02', 'TEST-ALTERNATE');
    fullBuild(fullDb, signing + annex + mappedRelease());
    dailyWindows(dailyDb, [signing, annex]);
    expect(contractState(dailyDb)?.annex_count).toBe(0);
    replay(dailyDb, mappedRelease());
    for (const db of [fullDb, dailyDb]) {
      expect(sqliteJson(db, 'SELECT contract_number, link_method FROM amendments'), db).toEqual([
        { contract_number: CONTRACT, link_method: 'value_anchor' },
      ]);
      expect(contractState(db), db).toMatchObject({
        signing_value: CORRECT,
        current_value: after,
        annex_count: 1,
      });
      expect(homeValue(db)).toBe(after);
      expect(snapshot(db)).toMatchObject({
        bidderTotals: [{ won_eur: after }],
        authorityTotals: [{ spent_eur: after }],
        flowTotals: [{ won_eur: after }],
      });
      await expectClean(db);
    }
    expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
  });

  it('preserves ambiguity when the corrected anchor also matches another contract', async () => {
    const signing =
      tender() +
      contract(MISTYPED, 'EUR', { supplier: '999999995' }) +
      contract(CORRECT, 'EUR', { number: 'TEST-OTHER-SIGNING', supplier: '999999995' });
    const annex = eopAnnex(CORRECT, CORRECT * 0.8, '2026-11-02', 'TEST-AMBIGUOUS');
    fullBuild(fullDb, signing + annex + mappedRelease());
    dailyWindows(dailyDb, [signing, annex, mappedRelease()]);
    for (const db of [fullDb, dailyDb]) {
      expect(sqliteJson(db, 'SELECT contract_number, link_method FROM amendments')).toEqual([
        { contract_number: 'TEST-AMBIGUOUS', link_method: null },
      ]);
      expect(contractState(db)).toMatchObject({
        signing_value: CORRECT,
        current_value: null,
        annex_count: 0,
      });
      await expectClean(db);
    }
  });

  it('orders same-day corrections by timestamp and breaks actual ties by document key', async () => {
    const signing = tender() + contract(1000);
    const early = mappedRelease({
      publication: 'TEST-Z',
      timestamp: '2026-11-24T08:00:00Z',
      amount: 1200,
    });
    const late = mappedRelease({
      publication: 'TEST-A',
      timestamp: '2026-11-24T18:00:00Z',
      amount: 1500,
    });
    const tied = mappedRelease({
      publication: 'TEST-B',
      timestamp: '2026-11-24T20:00:00+02:00',
      amount: 1600,
    });
    fullBuild(fullDb, signing + early + late + tied);
    dailyWindows(dailyDb, [signing, late, early]);
    expect(contractState(dailyDb)?.signing_value).toBe(1500);
    replay(dailyDb, tied);
    expect(contractState(dailyDb)?.signing_value).toBe(1600);
    expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
    for (const db of [fullDb, dailyDb]) await expectClean(db);
  });

  it.each([
    [100, 100.005, true],
    [100, 99.995, true],
    [100, 100.0049999, false],
    [100, 99.9950001, false],
    [100, 100.004, false],
    [100, 99.996, false],
    [100.0000001, 100.005, false],
    [100.0000001, 99.9950001, true],
    [10_000_000_000, 10_000_000_000.005, true],
    [10_000_000_000, 9_999_999_999.995, true],
    [10_000_000_000, 10_000_000_000.004, false],
    [10_000_000_000, 9_999_999_999.996, false],
    [10_000_000_000, '10000000000.0049999', false],
    [10_000_000_000, '9999999999.9950001', false],
  ])('compares the exact half-cent boundary from %s to %s', async (original, amount, replace) => {
    const signing = tender() + mappedSigning('LOT-1', original, 'EUR');
    const correction = mappedRelease({ amount });
    fullBuild(fullDb, signing + correction);
    dailyWindows(dailyDb, [signing, correction]);
    for (const db of [fullDb, dailyDb]) {
      expect(contractState(db)?.signing_value).toBe(replace ? Number(amount) : original);
      await expectClean(db);
    }
  });

  it.each([
    ['10000000000.0049999', false],
    ['9999999999.9950001', false],
    ['10000000000.005', true],
    ['9999999999.995', true],
  ])(
    'applies the exact half-cent boundary to unquoted JSON amount %s',
    async (jsonAmount, replace) => {
      const original = 10_000_000_000;
      const signing = tender() + ocdsSigning(original);
      const correction = mappedRelease({ jsonAmount });
      fullBuild(fullDb, signing + correction);
      dailyWindows(dailyDb, [signing, correction]);
      for (const db of [fullDb, dailyDb]) {
        expect(contractState(db)?.signing_value).toBe(replace ? Number(jsonAmount) : original);
        await expectClean(db);
      }
    },
  );

  it('replaces signing and rollups without producing any annex or after-value', async () => {
    const signing = tender() + contract(MISTYPED);
    const earlyReport = mappedRelease({ day: '2026-11-23', amount: MISTYPED });
    const correction = mappedRelease();

    fullBuild(fullDb, signing + earlyReport + correction);
    dailyWindows(dailyDb, [signing, earlyReport, correction]);
    const publicHistory = AMENDMENTS_SQL.replace('am.unp = ?', `am.unp = '${UNP}'`).replace(
      'am.contract_number = ?',
      `am.contract_number = '${CONTRACT}'`,
    );

    for (const db of [fullDb, dailyDb]) {
      expect(contractState(db)).toMatchObject({
        signing_value_original: MISTYPED,
        signing_value: CORRECT,
        signing_value_eur: CORRECT,
        current_value: null,
        current_value_eur: null,
        annex_count: 0,
        amount: CORRECT,
        amount_eur: CORRECT,
        value_flag: 'ok',
      });
      expect(sqliteJson(db, publicHistory)).toEqual([]);
      expect(homeValue(db)).toBe(CORRECT);
      expect(snapshot(db)).toMatchObject({
        bidderTotals: [{ won_eur: CORRECT }],
        authorityTotals: [{ spent_eur: CORRECT }],
      });
      await expectClean(db);
    }

    const expected = snapshot(fullDb);
    replay(dailyDb, earlyReport + correction);
    expect(snapshot(dailyDb)).toEqual(expected);
    for (const file of [
      'derive-amendments.sql',
      'normalize-raw.sql',
      'promote-amendments.sql',
      'precompute.sql',
    ])
      readScript(fullDb, script(file));
    expect(snapshot(fullDb)).toEqual(expected);
  });

  it.each([CORRECT * 1.1, CORRECT * 0.8])(
    'keeps structured EOP increases and decreases on top of the corrected signing (%s)',
    async (after) => {
      const signing = tender() + contract(MISTYPED);
      const correction = mappedRelease();
      const before = CORRECT;
      const annex = eopAnnex(before, after);
      const twin = mappedRelease({ day: '2026-11-02', amount: before, taggedAmendment: true });
      fullBuild(fullDb, signing + correction + annex + twin);
      dailyWindows(dailyDb, [signing, annex + twin, correction]);

      for (const db of [fullDb, dailyDb]) {
        expect(contractState(db)).toMatchObject({
          signing_value: CORRECT,
          current_value: after,
          annex_count: 1,
          amount_eur: expect.closeTo(after, 2),
        });
        expect(timeline(db)).toMatchObject([
          { source: 'eop:', value_before: before, value_after: after },
        ]);
        await expectClean(db);
      }
      expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
      replay(dailyDb, annex + twin + correction);
      expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
    },
  );

  it('retains an OCDS-only contractual amendment without treating its release value as an after-value', async () => {
    const signing = tender() + contract(MISTYPED);
    const amendment = mappedRelease({ day: '2026-11-25', taggedAmendment: true });
    fullBuild(fullDb, signing + mappedRelease() + amendment);
    dailyWindows(dailyDb, [signing, mappedRelease(), amendment]);

    expect(contractState(dailyDb)).toMatchObject({
      signing_value: CORRECT,
      current_value: null,
      annex_count: 1,
    });
    expect(timeline(dailyDb)).toMatchObject([
      { source: 'ocds', value_before: CORRECT, value_after: null },
    ]);
    expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
    await expectClean(dailyDb);
  });

  it('resolves a retained correction when the original signing and procedure arrive later', async () => {
    const signing = tender() + contract(MISTYPED);
    const correction = mappedRelease();
    fullBuild(fullDb, signing + correction);
    dailyWindows(dailyDb, [correction, signing]);

    expect(contractState(dailyDb)?.signing_value).toBe(CORRECT);
    expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
    await expectClean(dailyDb);
  });

  it('converts a corrected BGN signing to euros through the ordinary currency rule', async () => {
    const signing = tender('BGN') + contract(MISTYPED, 'BGN');
    const correction = mappedRelease({ currency: 'BGN' });
    fullBuild(fullDb, signing + correction);
    dailyWindows(dailyDb, [signing, correction]);

    expect(contractState(dailyDb)).toMatchObject({
      signing_value: CORRECT,
      signing_value_eur: expect.closeTo(CORRECT / 1.95583, 2),
      amount: CORRECT,
      amount_eur: expect.closeTo(CORRECT / 1.95583, 2),
      current_value: null,
      annex_count: 0,
    });
    expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
    await expectClean(dailyDb);
  });

  it('chooses the latest matching correction and can restore the published signing', async () => {
    const signing = tender() + contract(MISTYPED);
    const correction = mappedRelease();
    const later = mappedRelease({ day: '2026-11-25', amount: CORRECT * 1.5 });
    const restored = mappedRelease({ day: '2026-11-26', amount: MISTYPED });
    dailyWindows(dailyDb, [signing, correction, later]);
    expect(contractState(dailyDb)?.signing_value).toBe(CORRECT * 1.5);
    replay(dailyDb, restored);
    fullBuild(fullDb, restored + later + correction + signing);

    expect(contractState(dailyDb)).toMatchObject({
      signing_value: MISTYPED,
      current_value: null,
      annex_count: 0,
    });
    expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
    await expectClean(dailyDb);
  });

  it.each([
    ['different currency', { currency: 'BGN' }],
    ['different signing date', { dateSigned: '2026-10-06' }],
    ['missing document number', { document: false }],
    ['zero amount', { amount: 0 }],
  ])('keeps the signing for an unusable technical report (%s)', async (_, inputs) => {
    const signing = tender() + contract(MISTYPED);
    const correction = mappedRelease(inputs);
    fullBuild(fullDb, signing + correction);
    dailyWindows(dailyDb, [signing, correction]);

    expect(contractState(dailyDb)).toMatchObject({
      signing_value: MISTYPED,
      current_value: null,
      annex_count: 0,
    });
    expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
    await expectClean(dailyDb);
  });

  it.each([
    ['unpriced', undefined],
    ['different amount', CORRECT],
  ])('keeps the signing when sibling lots disagree (%s)', async (_, siblingAmount) => {
    const signing =
      tender() +
      mappedSigning('LOT-1', MISTYPED, 'EUR') +
      mappedSigning('LOT-2', siblingAmount, 'EUR');
    const correction = mappedRelease();
    fullBuild(fullDb, signing + correction);
    dailyWindows(dailyDb, [signing, correction]);

    expect(
      sqliteJson(
        dailyDb,
        'SELECT signing_value, annex_count FROM contracts ORDER BY signing_value DESC',
      ),
    ).toEqual([
      { signing_value: MISTYPED, annex_count: 0 },
      ...(siblingAmount === undefined ? [] : [{ signing_value: siblingAmount, annex_count: 0 }]),
    ]);
    expect(snapshot(dailyDb)).toEqual(snapshot(fullDb));
    await expectClean(dailyDb);
  });

  it('requires explicit signing currency and applies ordinary value guards after correction', async () => {
    const correction = mappedRelease({ amount: CORRECT * 1000 });
    const signing = tender() + contract(MISTYPED);
    fullBuild(fullDb, signing + correction);
    expect(contractState(fullDb)).toMatchObject({
      signing_value: CORRECT * 1000,
      annex_count: 0,
      current_value: null,
      signing_value_eur: null,
      value_flag: 'value_suspect',
      amount_eur: ESTIMATE,
    });
    await expectClean(fullDb);

    dailyWindows(dailyDb, [
      tender('BGN') + mappedSigning('LOT-1', MISTYPED, undefined),
      mappedRelease({ currency: 'BGN' }),
    ]);
    expect(contractState(dailyDb)).toMatchObject({
      signing_value: MISTYPED,
      annex_count: 0,
      current_value: null,
    });
    await expectClean(dailyDb);
  });

  it('replaces legacy inferred history when the identifiable publications are replayed', async () => {
    dailyWindows(dailyDb, [tender() + contract(MISTYPED)]);
    sqlite(
      dailyDb,
      `INSERT INTO amendments
      (id, natural_key, unp, contract_number, document_number, source, published_at, value_before, value_after, currency)
      VALUES ('old-1', 'old-1', '${UNP}', '${CONTRACT}', 'TEST-REPORT-2026-11-23', 'ocds:2026-11-23', '2026-11-23', ${MISTYPED}, NULL, 'EUR'),
             ('old-2', 'old-2', '${UNP}', '${CONTRACT}', 'TEST-REPORT-2026-11-24', 'ocds:2026-11-24', '2026-11-24', ${MISTYPED}, ${CORRECT}, 'EUR');
      UPDATE contracts SET annex_count=2, current_value=${CORRECT};`,
    );
    expect(await sourceValueGate(dailyDb)).toMatchObject({ ok: true, warn: true });
    expect(await sourceValueGate(dailyDb, true)).toMatchObject({ ok: false });
    replay(dailyDb, mappedRelease({ day: '2026-11-23', amount: MISTYPED }) + mappedRelease());

    expect(timeline(dailyDb)).toEqual([]);
    expect(contractState(dailyDb)).toMatchObject({
      signing_value: CORRECT,
      annex_count: 0,
      current_value: null,
      amount_eur: CORRECT,
    });
    const checks = await assertIntegrity(integrityRunner(dailyDb), { build: true, exit: false });
    expect(checks.filter((c) => !c.ok || c.warn)).toEqual([]);
  });

  it('retires only the identifiable metadata-only OCDS publication on replay', async () => {
    const signing = tender() + contract(1000);
    const metadata = mappedRelease({ rationale: '' });
    fullBuild(fullDb, signing + metadata);
    dailyWindows(dailyDb, [signing]);
    sqlite(
      dailyDb,
      `INSERT INTO amendments
        (id, natural_key, unp, contract_number, document_number, source)
      VALUES ('old-bridge', 'old-bridge', '${UNP}', '${CONTRACT}', 'TEST-REPORT-2026-11-24', 'ocds:2026-11-24'),
             ('old-ocid', 'old-ocid', '${OCID}', '${CONTRACT}', 'TEST-REPORT-2026-11-24', 'ocds:2026-11-24'),
             ('other', 'other', '${UNP}', '${CONTRACT}', 'TEST-OTHER', 'ocds:2026-11-24');
      UPDATE contracts SET annex_count = 2;`,
    );
    replay(dailyDb, metadata);
    expect(sqliteJson(dailyDb, 'SELECT id FROM amendments')).toEqual([{ id: 'other' }]);
    expect(contractState(dailyDb)?.annex_count).toBe(1);
    expect(timeline(fullDb)).toEqual([]);
    await expectClean(dailyDb);
  });

  it('detects a superseded metadata-only publication in served history', async () => {
    const signing = tender() + contract(9000);
    const metadata = mappedRelease({ rationale: '' });
    fullBuild(fullDb, signing + metadata);
    sqlite(
      fullDb,
      `
      INSERT INTO amendments (id, natural_key, unp, contract_number, document_number, source)
      VALUES ('TEST-LEGACY', 'TEST-LEGACY', '${UNP}', '${CONTRACT}',
        'TEST-REPORT-2026-11-24', 'ocds:2026-11-24');
    `,
    );
    for (const build of [false, true]) {
      expect(await sourceValueGate(fullDb, build)).toMatchObject({
        ok: false,
        detail: expect.stringContaining('metadata-only publications in history: 1'),
      });
    }
  });

  it('rejects an inconsistent signing or a known correction left in history in either gate mode', async () => {
    fullBuild(fullDb, tender() + contract(MISTYPED) + mappedRelease());
    sqlite(fullDb, 'UPDATE contracts SET signing_value = signing_value_original');
    for (const build of [false, true])
      expect(await sourceValueGate(fullDb, build)).toMatchObject({
        ok: false,
        detail: expect.stringContaining('Incorrect OCDS signing projections: 1'),
      });

    sqlite(
      fullDb,
      `UPDATE contracts SET signing_value = ${CORRECT};
      INSERT INTO amendments (id, natural_key, unp, contract_number, document_number, source)
      VALUES ('old', 'old', '${UNP}', '${CONTRACT}', 'TEST-REPORT-2026-11-24', 'ocds:2026-11-24');`,
    );
    for (const build of [false, true])
      expect(await sourceValueGate(fullDb, build)).toMatchObject({
        ok: false,
        detail: expect.stringContaining('technical publications in history: 1'),
      });
  });
});
