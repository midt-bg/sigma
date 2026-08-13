/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The стотинки band (#247): a value entered in cents rather than leva lands at almost exactly 100x the
// procedure estimate, well under the 200x threshold that value_suspect used to need, so it was served
// at face value. Measured on the real corpus the ratios form an isolated cluster - 13 contracts between
// 95x and 105x, two between 85x and 95x, and NOTHING between 105x and 200x - which is why the band is
// narrow rather than a lowered multiplier.
//
// Both derive paths carry their own copy of the flag CASE (two in normalize-raw, three in
// refresh-slice), so the rule is exercised through the REAL scripts on a real SQLite database, once per
// path. A copy left behind fails here rather than in production.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration2Path = resolve(root, 'packages/db/migrations/0002_current_value_currency.sql');
const migration3Path = resolve(root, 'packages/db/migrations/0003_related_persons_foundation.sql');
// #305 Tier-2: served amendments gained value_restated/value_treatment (promote + refresh-slice write them).
const migration6Path = resolve(root, 'packages/db/migrations/0006_amendment_restated.sql');
const migration7Path = resolve(root, 'packages/db/migrations/0007_amendment_value_suspect.sql');
const stagingPath = resolve(root, 'scripts/work-staging-schema.sql');
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
  const dir = mkdtempSync(resolve(tmpdir(), `sigma-stotinki-${label}-`));
  const dbPath = resolve(dir, 'test.sqlite');
  try {
    readScript(dbPath, schemaPath);
    readScript(dbPath, migration2Path);
    readScript(dbPath, migration3Path);
    readScript(dbPath, migration6Path);
    readScript(dbPath, migration7Path);
    readScript(dbPath, stagingPath);
    run(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Estimate in BGN; the EUR estimate is this ÷ 1.95583. Contract values below are in BGN too. */
const ESTIMATE_BGN = 195_583; // exactly 100_000 EUR, so the multiples below are easy to read
const AUTH_EIK = '000695114';
const BIDDER_EIK = '831646048';

/** One tender + one contract per case, so each case gets its own procedure estimate. */
function seed(dbPath: string, cases: { unp: string; valueBgn: number }[]): void {
  const tenders = cases
    .map(
      (c) =>
        `('eop:tenders:${c.unp}', '2026-06-01T00:00:00Z', '${c.unp}', '${AUTH_EIK}', 'Тестов възложител', 'public', ${ESTIMATE_BGN}, 'BGN')`,
    )
    .join(',\n');
  const contracts = cases
    .map(
      (c) =>
        `('eop:contracts:${c.unp}', '2026-06-01T00:00:00Z', '${c.unp}', '${AUTH_EIK}', 'Тестов възложител', 'C-${c.unp}', '2026-06-01', ${c.valueBgn}, 'BGN', '${BIDDER_EIK}', 'Тестов изпълнител')`,
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

interface Row {
  id: string;
  value_flag: string;
  amount_eur: number | null;
}

const flagsByUnp = (dbPath: string): Map<string, Row> => {
  const rows = sqliteJson<Row>(
    dbPath,
    `SELECT id, value_flag, ROUND(amount_eur) AS amount_eur FROM contracts`,
  );
  const out = new Map<string, Row>();
  for (const r of rows) {
    const unp = r.id.split(':')[2]!;
    out.set(unp, r);
  }
  return out;
};

describe('стотинки band in the value_flag CASE', () => {
  for (const [label, scriptPath] of etlPaths) {
    it(`${label}: flags a value at ~100x the estimate and repairs it to the estimate`, () => {
      withEtlDb(label, (dbPath) => {
        seed(dbPath, [
          // Exactly 100x: the signature of a value typed in стотинки.
          { unp: 'UNP-X100', valueBgn: ESTIMATE_BGN * 100 },
          // Inside the band but not exactly 100x: the стотинки value of a contract whose own price came
          // in slightly under the procedure estimate, so the ratio lands a little below the multiple.
          { unp: 'UNP-X97', valueBgn: Math.round(ESTIMATE_BGN * 97) },
        ]);
        readScript(dbPath, scriptPath);

        const flags = flagsByUnp(dbPath);
        for (const unp of ['UNP-X100', 'UNP-X97']) {
          expect(flags.get(unp)?.value_flag, `${unp} should be value_suspect`).toBe(
            'value_suspect',
          );
          // Repaired to the procedure estimate (100 000 EUR), not served at 100x.
          expect(flags.get(unp)?.amount_eur, `${unp} repaired amount`).toBe(100_000);
        }
      });
    });

    it(`${label}: leaves ordinary overruns and the gap above the band alone`, () => {
      withEtlDb(label, (dbPath) => {
        seed(dbPath, [
          // A real overrun: flagged 'review' since 2020, but the value is kept.
          { unp: 'UNP-X20', valueBgn: ESTIMATE_BGN * 20 },
          // Just above the band. The corpus has nothing between 105x and 200x; if a case ever appears
          // there it must NOT be silently repaired to the estimate.
          { unp: 'UNP-X120', valueBgn: ESTIMATE_BGN * 120 },
          // Just below the band, where the two real 85x-95x contracts live.
          { unp: 'UNP-X90', valueBgn: ESTIMATE_BGN * 90 },
        ]);
        readScript(dbPath, scriptPath);

        const flags = flagsByUnp(dbPath);
        for (const unp of ['UNP-X20', 'UNP-X120', 'UNP-X90']) {
          expect(flags.get(unp)?.value_flag, `${unp} must not be value_suspect`).toBe('review');
          // Kept at face value, which is the whole point of 'review' as opposed to 'value_suspect'.
          expect(flags.get(unp)?.amount_eur, `${unp} keeps its value`).toBeGreaterThan(1_000_000);
        }
      });
    });

    it(`${label}: still catches the plain over-200x case it always did`, () => {
      withEtlDb(label, (dbPath) => {
        seed(dbPath, [{ unp: 'UNP-X500', valueBgn: ESTIMATE_BGN * 500 }]);
        readScript(dbPath, scriptPath);
        const flags = flagsByUnp(dbPath);
        expect(flags.get('UNP-X500')?.value_flag).toBe('value_suspect');
        expect(flags.get('UNP-X500')?.amount_eur).toBe(100_000);
      });
    });
  }
});
