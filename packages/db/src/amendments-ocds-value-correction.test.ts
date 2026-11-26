// A contract value corrected at the source and published only as OCDS contract updates, with no EOP annex:
// the latest release that moves the value away from the signing value becomes the contract's current value,
// on the full build (derive-amendments.sql → normalize-raw.sql → promote-amendments.sql → precompute.sql)
// and on the daily path (refresh-slice.sql, the release arriving in a later window than the contract). Every
// other OCDS row keeps the #286 shape — the release value as value_before, no after-value — and a contract
// with an EOP annex keeps the EOP annex as its only value source.
//
// Runs the REAL scripts through the sqlite3 CLI. All names, numbers and amounts are invented.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_SCHEMA } from './base-schema';
import { checkContractValueRule } from '../../../scripts/integrity-checks.mjs';

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
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', [dbPath], {
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
  const rows = sqliteJson<{ name: string }>(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'raw_%' ORDER BY name DESC",
  );
  for (const row of rows) sqlite(dbPath, `DROP TABLE IF EXISTS "${row.name}";`);
  readScript(dbPath, workStagingSchema);
}

function fullBuild(dbPath: string, seed: string): void {
  initWorkDb(dbPath);
  sqlite(dbPath, seed);
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

function contract(signing: number, currency = 'EUR'): string {
  return `INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
       published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
       cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
       award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
       lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
       awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
       eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
    VALUES
      ('eop:contracts:2026-10-05', 2026, 'eop', '2026-10-06T00:00:00Z', 0, 'DOC-${CONTRACT}',
       '2026-10-05', '${UNP}', '${TENDER_ID}', 'open', 'Test tender', '45000000',
       'Construction', 'works', ${ESTIMATE}, '${currency}', 'basis', 'lowest', 'Община Тест',
       '733456781', 'public', 'activity', 'notice', NULL, '${CONTRACT}', '2026-10-05', ${signing},
       '${currency}', 'Test contract', 0, '787777778', 'ТЕСТ ГРУП ЕООД', 'BG', 'small', 0, 1, 1, 0, 0, 365);`;
}

// An OCDS contractUpdate release, staged the way releaseToAmendments maps it: the contract value in the
// release as value_before, no after-value, keyed by the OCID until the bridge recovers the УНП.
function release(o: {
  published: string;
  value: number;
  currency?: string;
  description?: string;
  doc?: string | null;
}): string {
  const doc =
    o.doc === undefined ? `'${OCID}-${o.published}/${o.published}-contractupdate'` : 'NULL';
  const description = o.description ? `'${o.description}'` : 'NULL';
  return `INSERT INTO raw_amendments
      (source, dataset_year, dataset_variant, fetched_at, document_number, contract_number,
       contract_date, published_at, unp, tender_ext_id, authority_eik, authority_name,
       procurement_subject, contract_kind, value_before, value_after, value_delta, currency,
       description)
    VALUES
      ('ocds:${o.published}', 2026, 'OCDS', '${o.published}T06:00:00Z', ${doc}, '${CONTRACT}',
       '2026-10-05', '${o.published}', '${OCID}', '${TENDER_ID}', '733456781', 'Община Тест',
       'Test tender', 'works', ${o.value}, NULL, NULL, '${o.currency ?? 'EUR'}', ${description});`;
}

function eopAnnex(before: number, after: number): string {
  return `INSERT INTO raw_amendments
      (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number, contract_number,
       contract_date, published_at, unp, authority_eik, authority_name, procurement_subject,
       contract_kind, value_before, value_after, value_delta, currency, description)
    VALUES
      ('eop:annexes:2026-11-02', 2026, 'eop', '2026-11-03T00:00:00Z', '1', 'ANX-1', '${CONTRACT}',
       '2026-10-05', '2026-11-02', '${UNP}', '733456781', 'Община Тест', 'Test tender', 'works',
       ${before}, ${after}, ${after - before}, 'EUR', 'EOP annex');`;
}

const NOTE = 'Техническа грешка в стойността на договора';

interface ContractState {
  annex_count: number;
  current_value: number | null;
  value_flag: string;
  amount: number;
  amount_eur: number;
}

const contractState = (dbPath: string): ContractState | undefined =>
  sqliteJson<ContractState>(
    dbPath,
    `SELECT annex_count, current_value, value_flag, amount, ROUND(amount_eur, 2) AS amount_eur
     FROM contracts WHERE contract_number = '${CONTRACT}'`,
  )[0];

const timeline = (dbPath: string) =>
  sqliteJson<Record<string, unknown>>(
    dbPath,
    `SELECT published_at, substr(source, 1, 4) AS source, value_before, value_after, value_delta,
       raw_value_after, description
     FROM amendments WHERE contract_number = '${CONTRACT}' ORDER BY published_at, id`,
  );

const homeValue = (dbPath: string) =>
  sqliteJson<{ v: number }>(dbPath, 'SELECT ROUND(value_eur, 2) AS v FROM home_totals')[0]?.v;

const valueRule = (dbPath: string) =>
  checkContractValueRule((sql: string) => sqliteJson<Record<string, unknown>>(dbPath, sql));

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

describe('OCDS source correction on the full build', () => {
  it('takes a value corrected down x0.01 as the current value; the flag, the amount and the sums follow', async () => {
    // Control: the mistyped contract with only the release that repeats it.
    fullBuild(
      fullDb,
      `${tender()} ${contract(MISTYPED)} ${release({ published: '2026-11-23', value: MISTYPED })}`,
    );
    expect(contractState(fullDb)).toEqual({
      annex_count: 1,
      current_value: null,
      value_flag: 'review',
      amount: MISTYPED,
      amount_eur: MISTYPED,
    });
    rmSync(fullDb);

    // The first release still carries the mistyped value; only the second carries the correction.
    fullBuild(
      fullDb,
      `${tender()} ${contract(MISTYPED)}
       ${release({ published: '2026-11-23', value: MISTYPED })}
       ${release({ published: '2026-11-24', value: CORRECT, description: NOTE })}`,
    );
    expect(contractState(fullDb)).toEqual({
      annex_count: 2,
      current_value: CORRECT,
      value_flag: 'ok',
      amount: CORRECT,
      amount_eur: CORRECT,
    });
    // The timeline: the earlier release is unchanged (no after-value); the correction reads as the change
    // from the signing value to the corrected one, with the source's explanation.
    expect(timeline(fullDb)).toEqual([
      {
        published_at: '2026-11-23',
        source: 'ocds',
        value_before: MISTYPED,
        value_after: null,
        value_delta: null,
        raw_value_after: null,
        description: null,
      },
      {
        published_at: '2026-11-24',
        source: 'ocds',
        value_before: MISTYPED,
        value_after: CORRECT,
        value_delta: CORRECT - MISTYPED,
        raw_value_after: CORRECT,
        description: NOTE,
      },
    ]);
    expect(homeValue(fullDb)).toBe(CORRECT);
    expect((await valueRule(fullDb)).ok).toBe(true);

    // Re-running the derive on the same staging changes nothing.
    const before = sqliteJson(fullDb, 'SELECT * FROM raw_amendments ORDER BY id');
    readScript(fullDb, script('derive-amendments.sql'));
    expect(sqliteJson(fullDb, 'SELECT * FROM raw_amendments ORDER BY id')).toEqual(before);
  });

  it('changes nothing when the latest release repeats the signing value', () => {
    fullBuild(
      fullDb,
      `${tender()} ${contract(CORRECT)} ${release({ published: '2026-11-23', value: CORRECT })}`,
    );
    expect(contractState(fullDb)).toMatchObject({
      annex_count: 1,
      current_value: null,
      amount: CORRECT,
    });
    expect(timeline(fullDb)).toMatchObject([{ value_before: CORRECT, value_after: null }]);
  });

  it('decides by the latest release only: an earlier differing one followed by the signing value changes nothing', () => {
    fullBuild(
      fullDb,
      `${tender()} ${contract(MISTYPED)}
       ${release({ published: '2026-11-23', value: CORRECT })}
       ${release({ published: '2026-11-24', value: MISTYPED })}`,
    );
    expect(contractState(fullDb)).toMatchObject({ current_value: null, amount: MISTYPED });
    expect(timeline(fullDb)).toMatchObject([
      { value_before: CORRECT, value_after: null },
      { value_before: MISTYPED, value_after: null },
    ]);
  });

  it('keeps the EOP annex as the only value source when the contract has one', () => {
    fullBuild(
      fullDb,
      `${tender()} ${contract(MISTYPED)}
       ${eopAnnex(MISTYPED, MISTYPED + 100000)}
       ${release({ published: '2026-11-24', value: CORRECT, description: NOTE })}`,
    );
    // The OCDS twin is dropped (#286); the EOP after-value stands.
    expect(contractState(fullDb)).toMatchObject({
      annex_count: 1,
      current_value: MISTYPED + 100000,
    });
    expect(timeline(fullDb)).toMatchObject([{ source: 'eop:', value_after: MISTYPED + 100000 }]);
  });

  it('changes nothing for a release in another currency than the signing value', () => {
    // A lev contract whose later release states the euro amount: a different number, not a correction.
    fullBuild(
      fullDb,
      `${tender('BGN')} ${contract(7317200, 'BGN')}
       ${release({ published: '2026-11-24', value: 3741205, currency: 'EUR' })}`,
    );
    expect(contractState(fullDb)).toMatchObject({ current_value: null, amount: 7317200 });
  });

  it('changes nothing for a non-positive release value or a release without a document number', () => {
    fullBuild(
      fullDb,
      `${tender()} ${contract(MISTYPED)} ${release({ published: '2026-11-24', value: 0 })}`,
    );
    expect(contractState(fullDb)).toMatchObject({ current_value: null, amount: MISTYPED });
    rmSync(fullDb);

    fullBuild(
      fullDb,
      `${tender()} ${contract(MISTYPED)}
       ${release({ published: '2026-11-24', value: CORRECT, doc: null })}`,
    );
    expect(contractState(fullDb)).toMatchObject({ current_value: null, amount: MISTYPED });
  });

  it('changes nothing when the contract publications disagree on the signing value', () => {
    // Two lots under one contract number, signed for different amounts: there is no single "before".
    const secondLot = contract(MISTYPED + 1)
      .replace(`'DOC-${CONTRACT}'`, `'DOC-${CONTRACT}-2'`)
      .replace("'notice', NULL,", "'notice', '2',");
    fullBuild(
      fullDb,
      `${tender()} ${contract(MISTYPED)} ${secondLot}
       ${release({ published: '2026-11-24', value: CORRECT })}`,
    );
    expect(
      sqliteJson<{ current_value: number | null }>(
        fullDb,
        `SELECT DISTINCT current_value FROM contracts WHERE contract_number = '${CONTRACT}'`,
      ),
    ).toEqual([{ current_value: null }]);
  });

  it('holds an implausible "correction" upwards with the existing annex guards', () => {
    // x100 up: the annex ratio guard; the sums keep the signing value.
    fullBuild(
      fullDb,
      `${tender()} ${contract(CORRECT)} ${release({ published: '2026-11-24', value: MISTYPED })}`,
    );
    expect(contractState(fullDb)).toEqual({
      annex_count: 1,
      current_value: MISTYPED,
      value_flag: 'annex_suspect',
      amount: CORRECT,
      amount_eur: CORRECT,
    });
    rmSync(fullDb);

    // x10 up: the step guard (after >= 10 x before) with a ratio >= 5.
    fullBuild(
      fullDb,
      `${tender()} ${contract(CORRECT)} ${release({ published: '2026-11-24', value: CORRECT * 10 })}`,
    );
    expect(contractState(fullDb)).toMatchObject({
      current_value: CORRECT * 10,
      value_flag: 'annex_suspect',
      amount: CORRECT,
    });
    rmSync(fullDb);

    // x3 up: the doubled-total guard holds it at the signing value as well.
    fullBuild(
      fullDb,
      `${tender()} ${contract(CORRECT)} ${release({ published: '2026-11-24', value: CORRECT * 3 })}`,
    );
    expect(contractState(fullDb)).toMatchObject({
      current_value: CORRECT * 3,
      value_flag: 'annex_total_suspect',
      amount: CORRECT,
    });
  });
});

describe('OCDS source correction on the daily path', () => {
  it('applies a correction that arrives in a later window than the contract, as the full build does', async () => {
    const first = `${tender()} ${contract(MISTYPED)} ${release({ published: '2026-11-23', value: MISTYPED })}`;
    const second = release({ published: '2026-11-24', value: CORRECT, description: NOTE });
    dailyWindows(dailyDb, [first]);
    expect(contractState(dailyDb)).toMatchObject({ current_value: null, value_flag: 'review' });

    resetRawStaging(dailyDb);
    sqlite(dailyDb, second);
    readScript(dailyDb, script('refresh-slice.sql'));
    fullBuild(fullDb, `${first} ${second}`);

    expect(contractState(dailyDb)).toEqual({
      annex_count: 2,
      current_value: CORRECT,
      value_flag: 'ok',
      amount: CORRECT,
      amount_eur: CORRECT,
    });
    expect(contractState(dailyDb)).toEqual(contractState(fullDb));
    expect(timeline(dailyDb)).toEqual(timeline(fullDb));
    expect(homeValue(dailyDb)).toBe(CORRECT);
    expect((await valueRule(dailyDb)).ok).toBe(true);

    // The same window again: nothing moves.
    const contracts = sqliteJson(dailyDb, 'SELECT * FROM contracts ORDER BY id');
    const amendments = sqliteJson(dailyDb, 'SELECT * FROM amendments ORDER BY id');
    resetRawStaging(dailyDb);
    sqlite(dailyDb, second);
    readScript(dailyDb, script('refresh-slice.sql'));
    expect(sqliteJson(dailyDb, 'SELECT * FROM contracts ORDER BY id')).toEqual(contracts);
    expect(sqliteJson(dailyDb, 'SELECT * FROM amendments ORDER BY id')).toEqual(amendments);
  });

  it('moves the correction to a later release and back out, matching the full build at every step', async () => {
    const releases = [
      `${tender()} ${contract(MISTYPED)} ${release({ published: '2026-11-23', value: MISTYPED })}`,
      release({ published: '2026-11-24', value: CORRECT, description: NOTE }),
      // A later update that carries the corrected value forward: the leading row moves to it, and the
      // earlier correction goes back to the #286 shape, as a full build would leave it.
      release({ published: '2026-11-30', value: CORRECT, description: 'Срок' }),
      // A release that restates the signing value: the latest release decides, so nothing is corrected.
      release({ published: '2026-12-07', value: MISTYPED }),
    ];
    initWorkDb(dailyDb);
    for (let i = 0; i < releases.length; i++) {
      if (i > 0) resetRawStaging(dailyDb);
      sqlite(dailyDb, releases[i]!);
      readScript(dailyDb, script('refresh-slice.sql'));

      const full = resolve(dir, `full-${i}.sqlite`);
      fullBuild(full, releases.slice(0, i + 1).join('\n'));
      expect(contractState(dailyDb), `window ${i + 1}`).toEqual(contractState(full));
      expect(timeline(dailyDb), `window ${i + 1}`).toEqual(timeline(full));
      expect((await valueRule(dailyDb)).ok, `window ${i + 1}`).toBe(true);
    }
    expect(contractState(dailyDb)).toMatchObject({ current_value: null, amount: MISTYPED });
    expect(timeline(dailyDb).filter((r) => r.value_after !== null)).toEqual([]);
  });

  it('leaves a contract with a served EOP annex to that annex when a differing release arrives', () => {
    dailyWindows(dailyDb, [
      `${tender()} ${contract(MISTYPED)} ${eopAnnex(MISTYPED, MISTYPED + 100000)}`,
      release({ published: '2026-11-24', value: CORRECT, description: NOTE }),
    ]);
    expect(contractState(dailyDb)).toMatchObject({
      annex_count: 1,
      current_value: MISTYPED + 100000,
    });
    expect(timeline(dailyDb)).toMatchObject([{ source: 'eop:' }]);
  });
});
