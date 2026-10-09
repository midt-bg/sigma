/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFrameworkCeilingsUnsummed } from '../../../scripts/integrity-checks.mjs';

// A framework agreement's own record carries its CEILING — the most its buyers may order under it — and
// the orders placed under it are separate contracts. ЦАИС ЕОП says which is which. Summing both counts the
// same money twice, and an agreement concluded with several suppliers („А; Б") used to rank as one
// „обединение". Exercised through the REAL derive scripts, once per path, then precompute for the rollups.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrations = [
  'packages/db/migrations/0000_init.sql',
  'packages/db/migrations/0002_current_value_currency.sql',
  'packages/db/migrations/0003_related_persons_foundation.sql',
  'packages/db/migrations/0009_interest_link_evidence.sql',
  'packages/db/migrations/0014_person_profile.sql',
  'packages/db/migrations/0015_person_observations.sql',
  'packages/db/migrations/0018_person_entities.sql',
  'packages/db/migrations/0006_amendment_restated.sql',
  'packages/db/migrations/0007_amendment_value_suspect.sql',
  'packages/db/migrations/0008_amendment_provenance.sql',
  'scripts/work-staging-schema.sql',
].map((p) => resolve(root, p));
const precomputePath = resolve(root, 'scripts/precompute.sql');
const etlPaths = [
  ['normalize-raw', resolve(root, 'scripts/normalize-raw.sql')],
  ['refresh-slice', resolve(root, 'scripts/refresh-slice.sql')],
] as const;

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
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

function withEtlDb(label: string, run: (dbPath: string) => void): void {
  const dir = mkdtempSync(resolve(tmpdir(), `sigma-framework-${label}-`));
  const dbPath = resolve(dir, 'test.sqlite');
  try {
    for (const path of migrations) readScript(dbPath, path);
    run(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const AUTH_EIK = '123456786'; // invented
const PEG = 1.95583;
const bgn = (eur: number) => Math.round(eur * PEG * 100) / 100;

interface RawContract {
  unp: string;
  number: string;
  contractor: string;
  eur: number;
  notice: number | null; // isFrameworkAgreement
  calloff: number | null; // frameworkAgreementContract, already read as a flag
}

const CASES: RawContract[] = [
  // The agreement itself, concluded with two suppliers: a ceiling of 1 000 000 €, not spending.
  {
    unp: 'UNP-FA',
    number: 'РС-1',
    contractor: 'ДОСТАВЧИК АЛФА ЕООД; ДОСТАВЧИК БЕТА ЕООД',
    eur: 1_000_000,
    notice: 1,
    calloff: null,
  },
  // Two orders placed under it — the money actually committed.
  {
    unp: 'UNP-CO1',
    number: 'Д-1',
    contractor: 'ДОСТАВЧИК АЛФА ЕООД',
    eur: 100_000,
    notice: 0,
    calloff: 1,
  },
  {
    unp: 'UNP-CO2',
    number: 'Д-2',
    contractor: 'ДОСТАВЧИК БЕТА ЕООД',
    eur: 200_000,
    notice: null,
    calloff: 1,
  },
  // A real joint bid with a member list: an ordinary contract, so it stays an обединение.
  {
    unp: 'UNP-JV',
    number: 'Д-3',
    contractor: 'ФИРМА ГАМА ЕООД; ФИРМА ДЕЛТА ЕООД',
    eur: 150_000,
    notice: 0,
    calloff: null,
  },
];

function seed(dbPath: string): void {
  const tenders = CASES.map(
    (c) =>
      `('eop:tenders:${c.unp}', '2026-06-01T00:00:00Z', '${c.unp}', '${AUTH_EIK}', 'Тестов възложител', 'public', ${bgn(c.eur)}, 'BGN')`,
  ).join(',\n');
  const contracts = CASES.map(
    (c) =>
      `('eop:contracts:${c.unp}', '2026-06-01T00:00:00Z', '${c.unp}', '${AUTH_EIK}', 'Тестов възложител', '${c.number}', '2026-06-01', ${bgn(c.eur)}, 'BGN', NULL, '${c.contractor}', ${c.notice ?? 'NULL'}, ${c.calloff ?? 'NULL'})`,
  ).join(',\n');
  sqlite(
    dbPath,
    `INSERT INTO raw_tenders
       (source, fetched_at, unp, authority_eik, authority_name, authority_type, estimated_value, currency)
     VALUES ${tenders};

     INSERT INTO raw_contracts
       (source, fetched_at, unp, authority_eik, authority_name, contract_number,
        contract_date, signing_value, currency, contractor_eik, contractor_name,
        framework_notice, framework_contract)
     VALUES ${contracts};`,
  );
}

interface ContractRow {
  unp: string;
  framework: number | null;
  amount_eur: number | null;
  signing_value_eur: number | null;
  bidder_kind: string;
}

const contractsByUnp = (dbPath: string) =>
  new Map(
    sqliteJson<ContractRow>(
      dbPath,
      `SELECT substr(c.tender_id, 3) AS unp, c.framework, ROUND(c.amount_eur) AS amount_eur,
              ROUND(c.signing_value_eur) AS signing_value_eur, b.kind AS bidder_kind
       FROM contracts c JOIN bidders b ON b.id = c.bidder_id`,
    ).map((r) => [r.unp, r]),
  );

describe('framework agreements: the ceiling is never summed, the orders are', () => {
  for (const [label, scriptPath] of etlPaths) {
    it(`${label}: marks the agreement and its orders from the source flags`, () => {
      withEtlDb(label, (dbPath) => {
        seed(dbPath);
        readScript(dbPath, scriptPath);
        const rows = contractsByUnp(dbPath);
        expect(rows.get('UNP-FA')).toMatchObject({ framework: 2, amount_eur: null });
        expect(rows.get('UNP-CO1')).toMatchObject({ framework: 1, amount_eur: 100_000 });
        expect(rows.get('UNP-CO2')).toMatchObject({ framework: 1, amount_eur: 200_000 });
        expect(rows.get('UNP-JV')).toMatchObject({ framework: null, amount_eur: 150_000 });
      });
    });

    it(`${label}: the parties to an agreement are not an обединение, a real joint bid still is`, () => {
      withEtlDb(label, (dbPath) => {
        seed(dbPath);
        readScript(dbPath, scriptPath);
        const rows = contractsByUnp(dbPath);
        expect(rows.get('UNP-FA')?.bidder_kind).toBe('framework_parties');
        expect(rows.get('UNP-JV')?.bidder_kind).toBe('consortium');
      });
    });
  }

  it('precompute: totals and rankings count the orders once and leave the ceiling out', () => {
    withEtlDb('precompute', (dbPath) => {
      seed(dbPath);
      readScript(dbPath, etlPaths[0][1]);
      readScript(dbPath, precomputePath);

      const home = sqliteJson<{ value_eur: number }>(
        dbPath,
        'SELECT ROUND(value_eur) AS value_eur FROM home_totals',
      )[0];
      expect(home?.value_eur).toBe(450_000); // 100 000 + 200 000 + 150 000 — not + the 1 000 000 ceiling

      const totals = sqliteJson<{ kind: string; won_eur: number }>(
        dbPath,
        'SELECT kind, ROUND(won_eur) AS won_eur FROM company_totals ORDER BY won_eur DESC',
      );
      expect(totals.map((t) => t.kind)).not.toContain('framework_parties');
      expect(totals.map((t) => t.won_eur)).toEqual([200_000, 150_000, 100_000]);

      const authority = sqliteJson<{ spent_eur: number; contracts: number }>(
        dbPath,
        'SELECT ROUND(spent_eur) AS spent_eur, contracts FROM authority_totals',
      )[0];
      expect(authority).toEqual({ spent_eur: 450_000, contracts: 3 });

      // The list shows the agreement as a row, but not as an unconfirmed value, and its headline sum
      // leaves the ceiling out. The cube's grand-total row has every dimension at '(all)'.
      const rollup = sqliteJson<{ contracts: number; value_eur: number; unverified: number }>(
        dbPath,
        `SELECT contracts, ROUND(value_eur) AS value_eur, unverified FROM contract_rollup
         WHERE procedure_type = '(all)' AND eu = '(all)' AND sector = '(all)' AND one_offer = '(all)'
           AND value_bucket = '(all)' AND year = '(all)'`,
      )[0];
      expect(rollup).toEqual({ contracts: 4, value_eur: 450_000, unverified: 0 });

      // The ceiling stays readable for display.
      expect(contractsByUnp(dbPath).get('UNP-FA')?.signing_value_eur).toBe(1_000_000);

      // No consortium tie is drawn between the two suppliers of the agreement.
      const links = sqliteJson<{ n: number }>(
        dbPath,
        "SELECT COUNT(*) AS n FROM consortium_members m JOIN bidders b ON b.id = m.consortium_id WHERE b.kind = 'framework_parties'",
      )[0];
      expect(links?.n).toBe(0);
    });
  });

  it('integrity gate: an agreement record with an amount fails framework-ceilings-unsummed', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-framework-gate-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      for (const path of migrations) readScript(dbPath, path);
      seed(dbPath);
      readScript(dbPath, etlPaths[0][1]);
      const runner = (sql: string) => sqliteJson<Record<string, unknown>>(dbPath, sql);
      expect((await checkFrameworkCeilingsUnsummed(runner)).ok).toBe(true);
      sqlite(dbPath, 'UPDATE contracts SET amount_eur = 1000000 WHERE framework = 2;');
      const failed = await checkFrameworkCeilingsUnsummed(runner);
      expect(failed.ok).toBe(false);
      expect(failed.detail).toMatch(/1 framework-agreement record/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
