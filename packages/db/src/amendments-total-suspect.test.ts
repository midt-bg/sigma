/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #305 single-annex value double-count: a driving annex whose value_after is >=2x its value_before is
// a data defect — ЗОП чл.116 caps a single amendment at +50%, so one step cannot legally more than
// double a contract. Such contracts get value_flag = 'annex_total_suspect' and fall back to
// signing_value, exactly like annex_suspect, so the doubled figure is excluded from every EUR
// aggregate. The ABS(value_after - current_value) tie binds the flag to the annex that DRIVES
// current_value: a doubled annex later superseded by a correct one is NOT flagged.
//
// The flag CASE and its value-fallback siblings live in copies across both derive paths (normalize-raw
// and refresh-slice) plus refresh-slice's reconciliation re-flag, so the rule is exercised through the
// REAL scripts in pipeline order on a real SQLite database. A copy left behind fails here.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration1Path = resolve(root, 'packages/db/migrations/0001_flow_pairs_bidder_index.sql');
const migration2Path = resolve(root, 'packages/db/migrations/0002_current_value_currency.sql');
const migration3Path = resolve(root, 'packages/db/migrations/0003_related_persons_foundation.sql');
const stagingPath = resolve(root, 'scripts/work-staging-schema.sql');
const derivePath = resolve(root, 'scripts/derive-amendments.sql');
const normalizePath = resolve(root, 'scripts/normalize-raw.sql');
const promotePath = resolve(root, 'scripts/promote-amendments.sql');
const precomputePath = resolve(root, 'scripts/precompute.sql');
const refreshSlicePath = resolve(root, 'scripts/refresh-slice.sql');

// Real pipeline order (scripts/import.mjs): full derive runs derive-amendments → normalize-raw →
// promote-amendments → precompute; the slice derive runs derive-amendments → refresh-slice (which
// promotes the window's amendments itself) → precompute. precompute populates current_value_eur, which
// these assertions read.
const etlRuns = [
  ['normalize-raw', [derivePath, normalizePath, promotePath, precomputePath]],
  ['refresh-slice', [derivePath, refreshSlicePath, precomputePath]],
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
  const dir = mkdtempSync(resolve(tmpdir(), `sigma-totalsuspect-${label}-`));
  const dbPath = resolve(dir, 'test.sqlite');
  try {
    readScript(dbPath, schemaPath);
    readScript(dbPath, migration1Path);
    readScript(dbPath, migration2Path);
    readScript(dbPath, migration3Path);
    readScript(dbPath, stagingPath);
    run(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Signing value in BGN; exactly 100_000 EUR at the fixed peg (÷1.95583) so the fallback reads directly.
const SIGNING_BGN = 195_583;
const AUTH_EIK = '000695114';
const BIDDER_EIK = '831646048';

interface AmendmentStep {
  before: number | null;
  after: number;
  publishedAt: string;
}

interface Case {
  unp: string;
  signing: number;
  steps: AmendmentStep[];
}

function seedContracts(dbPath: string, cases: Case[]): void {
  const tenders = cases
    .map(
      (c) =>
        `('eop:tenders:${c.unp}', '2026-06-01T00:00:00Z', '${c.unp}', '${AUTH_EIK}', 'Тестов възложител', 'public', ${c.signing}, 'BGN')`,
    )
    .join(',\n');
  const contracts = cases
    .map(
      (c) =>
        `('eop:contracts:${c.unp}', '2026-06-01T00:00:00Z', '${c.unp}', '${AUTH_EIK}', 'Тестов възложител', 'C-${c.unp}', '2026-06-01', ${c.signing}, 'BGN', '${BIDDER_EIK}', 'Тестов изпълнител')`,
    )
    .join(',\n');
  sqlite(
    dbPath,
    `INSERT INTO raw_tenders
       (source, fetched_at, unp, authority_eik, authority_name, authority_type, estimated_value, currency)
     VALUES ${tenders};

     INSERT INTO raw_contracts
       (source, fetched_at, unp, authority_eik, authority_name, contract_number,
        contract_date, signing_value, currency, contractor_eik, contractor_name)
     VALUES ${contracts};`,
  );
}

function seedAmendments(dbPath: string, cases: Case[]): void {
  const rows = cases
    .flatMap((c) =>
      c.steps.map(
        (s, i) =>
          `('eop:annexes:${c.unp}', '2026-06-01T00:00:00Z', 'A-${c.unp}-${i + 1}', '${c.unp}', 'C-${c.unp}', '${s.publishedAt}', ${s.before ?? 'NULL'}, ${s.after}, 'BGN')`,
      ),
    )
    .join(',\n');
  if (!rows) return;
  sqlite(
    dbPath,
    `INSERT INTO raw_amendments
       (source, fetched_at, document_number, unp, contract_number, published_at,
        value_before, value_after, currency)
     VALUES ${rows};`,
  );
}

interface Row {
  id: string;
  value_flag: string;
  amount_eur: number | null;
  current_value_eur: number | null;
}

const rowsByUnp = (dbPath: string): Map<string, Row> => {
  const rows = sqliteJson<Row>(
    dbPath,
    `SELECT id, value_flag, ROUND(amount_eur) AS amount_eur,
            ROUND(current_value_eur) AS current_value_eur
       FROM contracts`,
  );
  const out = new Map<string, Row>();
  for (const r of rows) out.set(r.id.split(':')[2]!, r);
  return out;
};

describe('#305 annex_total_suspect single-annex value double-count', () => {
  for (const [label, scriptPaths] of etlRuns) {
    it(`${label}: flags a doubled driving annex and falls back to the signing value`, () => {
      withEtlDb(label, (dbPath) => {
        const cases: Case[] = [
          // (a) The bug: 77M signed, one annex reports value_after = 2x value_before (154M). ЗОП caps a
          // single amendment at +50%, so this is a double-count defect: flag it and drop back to signing.
          {
            unp: 'UNP-DOUBLE',
            signing: 77_000_000,
            steps: [{ before: 77_000_000, after: 154_000_000, publishedAt: '2026-06-10' }],
          },
          // (b) A genuine small increase (+30%): before 100 → after 130. Must stay 'ok' and keep its
          // current value, guarding against false positives.
          {
            unp: 'UNP-SMALL',
            signing: 100,
            steps: [{ before: 100, after: 130, publishedAt: '2026-06-10' }],
          },
        ];
        seedContracts(dbPath, cases);
        seedAmendments(dbPath, cases);
        for (const p of scriptPaths) readScript(dbPath, p);

        const rows = rowsByUnp(dbPath);

        // (a) flagged, value base falls back to signing (77M BGN ÷1.95583), NOT the doubled 154M.
        const doubled = rows.get('UNP-DOUBLE');
        expect(doubled?.value_flag, 'doubled annex flagged').toBe('annex_total_suspect');
        const signingEur = Math.round(77_000_000 / 1.95583);
        expect(doubled?.amount_eur, 'amount_eur falls back to signing').toBe(signingEur);
        // Excluded from the current_value aggregate entirely.
        expect(doubled?.current_value_eur, 'current_value_eur suppressed').toBeNull();

        // (b) genuine +30% increase untouched: stays ok, value reflects current_value (130 BGN).
        const small = rows.get('UNP-SMALL');
        expect(small?.value_flag, 'small increase stays ok').toBe('ok');
        expect(small?.amount_eur, 'small increase keeps current value').toBe(
          Math.round(130 / 1.95583),
        );
        expect(small?.current_value_eur).toBe(Math.round(130 / 1.95583));
      });
    });

    it(`${label}: an old doubled annex superseded by a correct later annex is NOT flagged`, () => {
      withEtlDb(label, (dbPath) => {
        const cases: Case[] = [
          // (d) An early annex doubled (before 100 → after 200), but a LATER annex sets a correct,
          // sub-2x current_value (before 200 → after 130). The doubled step no longer DRIVES
          // current_value, so the ABS(...-current_value) tie must leave the contract 'ok'.
          {
            unp: 'UNP-SUPERSEDED',
            signing: 100,
            steps: [
              { before: 100, after: 200, publishedAt: '2026-06-10' },
              { before: 200, after: 130, publishedAt: '2026-06-20' },
            ],
          },
        ];
        seedContracts(dbPath, cases);
        seedAmendments(dbPath, cases);
        for (const p of scriptPaths) readScript(dbPath, p);

        const row = rowsByUnp(dbPath).get('UNP-SUPERSEDED');
        expect(row?.value_flag, 'superseded double is not flagged').toBe('ok');
        // Served at the corrected current value (130 BGN), not the transient doubled 200.
        expect(row?.amount_eur).toBe(Math.round(130 / 1.95583));
        expect(row?.current_value_eur).toBe(Math.round(130 / 1.95583));
      });
    });
  }

  it('full-vs-slice parity: the doubled contract gets the same value_flag on both paths', () => {
    const cases: Case[] = [
      {
        unp: 'UNP-DOUBLE',
        signing: 77_000_000,
        steps: [{ before: 77_000_000, after: 154_000_000, publishedAt: '2026-06-10' }],
      },
    ];

    let fullFlag: string | undefined;
    withEtlDb('parity-full', (dbPath) => {
      seedContracts(dbPath, cases);
      seedAmendments(dbPath, cases);
      for (const p of [derivePath, normalizePath, promotePath, precomputePath])
        readScript(dbPath, p);
      fullFlag = rowsByUnp(dbPath).get('UNP-DOUBLE')?.value_flag;
    });

    let sliceFlag: string | undefined;
    withEtlDb('parity-slice', (dbPath) => {
      seedContracts(dbPath, cases);
      seedAmendments(dbPath, cases);
      for (const p of [derivePath, refreshSlicePath, precomputePath]) readScript(dbPath, p);
      sliceFlag = rowsByUnp(dbPath).get('UNP-DOUBLE')?.value_flag;
    });

    expect(fullFlag).toBe('annex_total_suspect');
    expect(sliceFlag).toBe('annex_total_suspect');
    expect(fullFlag).toBe(sliceFlag);
  });
});
