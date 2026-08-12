/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Issue #247, second reported contract. The стотинки band added in #298 measures against the PROCEDURE
// estimate, so it only fires when the whole procedure is one lot. On a multi-lot procedure the dropped
// decimal point still lands at exactly 100x the LOT's own estimate, while the ratio to the procedure
// total lands wherever that lot's share puts it - 00621-2020-0008 sits at 89.8x and is served at
// 14,212,416 EUR instead of ~142,000 EUR.
//
// The own-row estimate CANNOT be used on its own: docs/etl.md is explicit that for framework and
// unit-price procedures (medicines, fuel) it is a UNIT price, and a whole call-off legitimately dwarfs
// it. So the arm is a conjunction - 95x..105x of the own estimate AND at least 10x the procedure
// estimate, the threshold that already means "implausibly large for this procedure". A unit-price
// call-off sits at ~1x the procedure estimate and is spared.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration2Path = resolve(root, 'packages/db/migrations/0002_current_value_currency.sql');
const migration3Path = resolve(root, 'packages/db/migrations/0003_related_persons_foundation.sql');
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
  const dir = mkdtempSync(resolve(tmpdir(), `sigma-lotband-${label}-`));
  const dbPath = resolve(dir, 'test.sqlite');
  try {
    readScript(dbPath, schemaPath);
    readScript(dbPath, migration2Path);
    readScript(dbPath, migration3Path);
    readScript(dbPath, stagingPath);
    run(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The lot's own estimate: 195_583 BGN = exactly 100_000 EUR, so the multiples read directly. */
const OWN_BGN = 195_583;
const AUTH_EIK = '000695114';
const BIDDER_EIK = '831646048';

interface Case {
  unp: string;
  /** Contract value, in BGN. */
  valueBgn: number;
  /** The lot's own estimate on the contract row, in BGN. */
  ownEstBgn: number;
  /** The whole procedure's estimate, in BGN. */
  procEstBgn: number;
}

function seed(dbPath: string, cases: Case[]): void {
  const tenders = cases
    .map(
      (c) =>
        `('eop:tenders:${c.unp}', '2026-06-01T00:00:00Z', '${c.unp}', '${AUTH_EIK}', 'Тестов възложител', 'public', ${c.procEstBgn}, 'BGN')`,
    )
    .join(',\n');
  const contracts = cases
    .map(
      (c) =>
        `('eop:contracts:${c.unp}', '2026-06-01T00:00:00Z', '${c.unp}', '${AUTH_EIK}', 'Тестов възложител', 'C-${c.unp}', '2026-06-01', ${c.valueBgn}, 'BGN', ${c.ownEstBgn}, 'BGN', '${BIDDER_EIK}', 'Тестов изпълнител')`,
    )
    .join(',\n');
  sqlite(
    dbPath,
    `INSERT INTO raw_tenders
       (source, fetched_at, unp, authority_eik, authority_name, authority_type, estimated_value, currency)
     VALUES ${tenders};

     INSERT INTO raw_contracts
       (source, fetched_at, unp, authority_eik, authority_name, contract_number,
        contract_date, signing_value, currency, estimated_value, procurement_currency,
        contractor_eik, contractor_name)
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
  for (const r of rows) out.set(r.id.split(':')[2]!, r);
  return out;
};

describe('стотинки band measured against the lot estimate (issue #247)', () => {
  for (const [label, scriptPath] of etlPaths) {
    it(`${label}: catches the reported multi-lot case the procedure band misses`, () => {
      withEtlDb(label, (dbPath) => {
        seed(dbPath, [
          // The shape of 00621-2020-0008: exactly 100x the lot estimate, but only 89.8x the procedure
          // estimate, so the #298 band (which measures against the procedure) never sees it.
          {
            unp: 'UNP-LOT100',
            valueBgn: OWN_BGN * 100,
            ownEstBgn: OWN_BGN,
            procEstBgn: Math.round(OWN_BGN * (100 / 89.8)),
          },
        ]);
        readScript(dbPath, scriptPath);
        const row = flagsByUnp(dbPath).get('UNP-LOT100');
        expect(row?.value_flag).toBe('value_suspect');
        // Repaired to the procedure estimate, the established anchor for value_suspect.
        expect(row?.amount_eur).toBe(111_358);
      });
    });

    it(`${label}: spares a unit-price call-off at 100x its own per-unit estimate`, () => {
      withEtlDb(label, (dbPath) => {
        seed(dbPath, [
          // A framework/unit-price procedure: the row estimate is a UNIT price, the call-off is 100x it
          // in absolute terms but only a fifth of the procedure ceiling. Repairing this would DESTROY a
          // real contract - it must stay untouched.
          {
            unp: 'UNP-UNIT',
            valueBgn: OWN_BGN * 100,
            ownEstBgn: OWN_BGN,
            procEstBgn: OWN_BGN * 500,
          },
        ]);
        readScript(dbPath, scriptPath);
        const row = flagsByUnp(dbPath).get('UNP-UNIT');
        expect(row?.value_flag).not.toBe('value_suspect');
        // Served at face value: 100 x 100_000 EUR.
        expect(row?.amount_eur).toBe(10_000_000);
      });
    });

    it(`${label}: pins the procedure-level floor of the conjunction at 10x`, () => {
      withEtlDb(label, (dbPath) => {
        seed(dbPath, [
          // Exactly at the floor: 100x the lot estimate and exactly 10x the procedure estimate.
          {
            unp: 'UNP-AT10',
            valueBgn: OWN_BGN * 100,
            ownEstBgn: OWN_BGN,
            procEstBgn: OWN_BGN * 10,
          },
          // Just under it: 100x the lot estimate but only ~8.9x the procedure estimate.
          {
            unp: 'UNP-UNDER10',
            valueBgn: OWN_BGN * 100,
            ownEstBgn: OWN_BGN,
            procEstBgn: Math.round(OWN_BGN * 11.2),
          },
        ]);
        readScript(dbPath, scriptPath);
        const flags = flagsByUnp(dbPath);
        expect(flags.get('UNP-AT10')?.value_flag).toBe('value_suspect');
        expect(flags.get('UNP-UNDER10')?.value_flag).not.toBe('value_suspect');
      });
    });
  }
});
