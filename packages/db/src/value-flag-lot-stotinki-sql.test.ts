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
// The амендмент columns refresh-slice.sql/promote-amendments.sql now write into served `amendments`
// (#305 value_restated/value_treatment/value_suspect, #306 contract_number_raw/link_method). Without
// them sqlite3 aborts on the amendment promotion long before it reaches the value_flag CASE under test.
const migration6Path = resolve(root, 'packages/db/migrations/0006_amendment_restated.sql');
const migration7Path = resolve(root, 'packages/db/migrations/0007_amendment_value_suspect.sql');
const migration8Path = resolve(root, 'packages/db/migrations/0008_amendment_provenance.sql');
// #279/ADR-0033: refresh-slice.sql's свързани-лица block reads interest_link_evidence, so 0009 too.
const migration9Path = resolve(root, 'packages/db/migrations/0009_interest_link_evidence.sql');
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
    readScript(dbPath, migration6Path);
    readScript(dbPath, migration7Path);
    readScript(dbPath, migration8Path);
    readScript(dbPath, migration9Path);
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
  /** The lot's own estimate on the contract row, in BGN. `null` = the row carries none. */
  ownEstBgn: number | null;
  /** The whole procedure's estimate, in BGN. */
  procEstBgn: number;
  /** Currency the row's OWN estimate is denominated in (`procurement_currency`). Defaults to BGN. */
  ownEstCurrency?: string;
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
        `('eop:contracts:${c.unp}', '2026-06-01T00:00:00Z', '${c.unp}', '${AUTH_EIK}', 'Тестов възложител', 'C-${c.unp}', '2026-06-01', ${c.valueBgn}, 'BGN', ${c.ownEstBgn ?? 'NULL'}, '${c.ownEstCurrency ?? 'BGN'}', '${BIDDER_EIK}', 'Тестов изпълнител')`,
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

/**
 * An annex on the contract. With `afterBgn` omitted it is a no-op (before = after), which leaves
 * `current_value` on the signing value and `eff_eur` unchanged; its only job then is to make the row
 * visible to refresh-slice.sql's reconciliation pass, whose `contract_base` requires the contract to
 * HAVE an amendment. With a raised `afterBgn` it also trips the annex condition that makes that pass
 * actually recompute the flag rather than keep the one the INSERT path assigned.
 */
function seedAnnex(dbPath: string, unp: string, beforeBgn: number, afterBgn = beforeBgn): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_amendments
       (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number, contract_number,
        contract_date, published_at, unp, authority_eik, authority_name, value_before, value_after,
        value_delta, currency, contractor_eik, description)
     VALUES
       ('eop:annexes:${unp}', 2026, 'eop', '2026-06-08T00:00:00Z', '1', 'AMD-${unp}', 'C-${unp}',
        '2026-06-01', '2026-06-09', '${unp}', '${AUTH_EIK}', 'Тестов възложител', ${beforeBgn},
        ${afterBgn}, ${afterBgn - beforeBgn}, 'BGN', '${BIDDER_EIK}', 'Изменение');`,
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
        expect(row, 'the seeded contract must reach the served table').toBeDefined();
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
        // Without this the `.not.toBe` below passes vacuously on an unseeded row (review cefothe #1).
        expect(row, 'the seeded contract must reach the served table').toBeDefined();
        expect(row?.value_flag).not.toBe('value_suspect');
        // Served at face value: 100 x 100_000 EUR.
        expect(row?.amount_eur).toBe(10_000_000);
      });
    });

    it(`${label}: pins the 95x/105x edges of the band`, () => {
      withEtlDb(label, (dbPath) => {
        seed(dbPath, [
          // Exactly on each edge — both inside, because the band is inclusive on purpose.
          { unp: 'UNP-AT95', valueBgn: OWN_BGN * 95, ownEstBgn: OWN_BGN, procEstBgn: OWN_BGN * 9 },
          {
            unp: 'UNP-AT105',
            valueBgn: OWN_BGN * 105,
            ownEstBgn: OWN_BGN,
            procEstBgn: OWN_BGN * 10,
          },
          // One step outside each edge — a dropped decimal lands AT ~100x, never at 94x or 106x, so
          // these are ordinary large contracts and must keep their money.
          { unp: 'UNP-AT94', valueBgn: OWN_BGN * 94, ownEstBgn: OWN_BGN, procEstBgn: OWN_BGN * 9 },
          {
            unp: 'UNP-AT106',
            valueBgn: OWN_BGN * 106,
            ownEstBgn: OWN_BGN,
            procEstBgn: OWN_BGN * 10,
          },
        ]);
        readScript(dbPath, scriptPath);
        const flags = flagsByUnp(dbPath);
        for (const unp of ['UNP-AT95', 'UNP-AT105', 'UNP-AT94', 'UNP-AT106'])
          expect(flags.get(unp), `seeded contract ${unp} missing`).toBeDefined();
        expect(flags.get('UNP-AT95')?.value_flag).toBe('value_suspect');
        expect(flags.get('UNP-AT105')?.value_flag).toBe('value_suspect');
        expect(flags.get('UNP-AT94')?.value_flag).not.toBe('value_suspect');
        expect(flags.get('UNP-AT106')?.value_flag).not.toBe('value_suspect');
        expect(flags.get('UNP-AT94')?.amount_eur).toBe(9_400_000);
        expect(flags.get('UNP-AT106')?.amount_eur).toBe(10_600_000);
      });
    });

    it(`${label}: pins the 1000 EUR floors on both estimates`, () => {
      withEtlDb(label, (dbPath) => {
        const TINY = 1_000; // ≈ 511 EUR — under the floor
        seed(dbPath, [
          // Own estimate under 1000 EUR: at these sizes a 100x ratio is noise, not a dropped decimal.
          { unp: 'UNP-TINYOWN', valueBgn: TINY * 100, ownEstBgn: TINY, procEstBgn: TINY * 10 },
          // Procedure estimate under 1000 EUR: same reasoning on the other half of the conjunction.
          { unp: 'UNP-TINYPROC', valueBgn: OWN_BGN * 100, ownEstBgn: OWN_BGN, procEstBgn: TINY },
        ]);
        readScript(dbPath, scriptPath);
        const flags = flagsByUnp(dbPath);
        expect(flags.get('UNP-TINYOWN'), 'seeded contract missing').toBeDefined();
        expect(flags.get('UNP-TINYPROC'), 'seeded contract missing').toBeDefined();
        expect(flags.get('UNP-TINYOWN')?.value_flag).not.toBe('value_suspect');
        expect(flags.get('UNP-TINYPROC')?.value_flag).not.toBe('value_suspect');
      });
    });

    it(`${label}: a row with NO own estimate is not caught by the own-row arm`, () => {
      withEtlDb(label, (dbPath) => {
        seed(dbPath, [
          // No own estimate at all. The own-row arm has nothing to measure against and must not fire;
          // the procedure-level band (#298) is the only thing that could still speak here, and at 10x
          // the procedure estimate it does not. This is the one place the INSERT and the UPDATE path
          // could disagree, because the reconciliation pass reads the estimate from a different column.
          { unp: 'UNP-NOOWN', valueBgn: OWN_BGN * 100, ownEstBgn: null, procEstBgn: OWN_BGN * 10 },
        ]);
        seedAnnex(dbPath, 'UNP-NOOWN', OWN_BGN * 100);
        readScript(dbPath, scriptPath);
        const row = flagsByUnp(dbPath).get('UNP-NOOWN');
        expect(row, 'the seeded contract must reach the served table').toBeDefined();
        expect(row?.value_flag).not.toBe('value_suspect');
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
        expect(flags.get('UNP-AT10'), 'seeded contract missing').toBeDefined();
        expect(flags.get('UNP-UNDER10'), 'seeded contract missing').toBeDefined();
        expect(flags.get('UNP-AT10')?.value_flag).toBe('value_suspect');
        expect(flags.get('UNP-UNDER10')?.value_flag).not.toBe('value_suspect');
        // Served at face value — the spared row keeps its money, which is the thing that matters.
        expect(flags.get('UNP-UNDER10')?.amount_eur).toBe(10_000_000);
      });
    });
  }

  // refresh-slice only. The reconciliation pass keeps whatever flag the INSERT path computed unless the
  // contract ALSO trips an annex condition — so that is the only shape in which its own copy of the band
  // decides anything, and the only way to pin it. (review cefothe #4/#5)
  it(`refresh-slice reconciliation: converts the own estimate through ITS currency, not the contract's`, () => {
    withEtlDb('reconcile-currency', (dbPath) => {
      const AFTER_BGN = OWN_BGN * 100; // 10 000 000 EUR
      const SIGNING_BGN = 100_000; // an annex ratio ≥ 100x, which forces the recompute
      seed(dbPath, [
        {
          unp: 'UNP-RECCUR',
          valueBgn: SIGNING_BGN,
          ownEstBgn: 100_000, // …denominated in EUR: the contract value is exactly 100x it
          ownEstCurrency: 'EUR',
          procEstBgn: 977_915, // 500 000 EUR, so the 10x procedure floor is cleared
        },
      ]);
      seedAnnex(dbPath, 'UNP-RECCUR', SIGNING_BGN, AFTER_BGN);
      readScript(dbPath, resolve(root, 'scripts/refresh-slice.sql'));
      const row = flagsByUnp(dbPath).get('UNP-RECCUR');
      expect(row, 'the seeded contract must reach the served table').toBeDefined();
      // Converting the estimate with the CONTRACT's currency divides an already-EUR figure by 1.95583,
      // lands at ~196x instead of 100x, drops out of the band — and the row falls through to
      // annex_suspect, which repairs to the signing value: 51 129 EUR shown instead of 500 000.
      expect(row?.value_flag).toBe('value_suspect');
      expect(row?.amount_eur).toBe(500_000);
    });
  });
});
