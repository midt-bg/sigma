/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The mis-keyed annex rule (#248): annex_suspect used to need the aggregate current/signing ratio to
// reach 100x, so a single annex with a mis-typed value that pushed a contract to, say, 30x its signed
// value was served at face value. The new rule is a CONJUNCTION: one annex step jumped >=10x AND the
// aggregate ended >=5x over signing. Both halves are load-bearing - the corpus has chains with a
// 36,058x single step whose aggregate ends BELOW signing (a later annex corrects the typo), where
// flagging would RAISE the shown value, and slow legitimate chains that double a few times without any
// single suspicious step.
//
// The flag CASE lives in five copies across the two derive paths, plus a re-flag guard in the
// refresh-slice reconciliation pass, so the rule is exercised through the REAL scripts (in their real
// pipeline order) on a real SQLite database. A copy left behind in normalize-raw, or in the
// reconciliation pass, fails here rather than in production. The two refresh-slice INSERT-time copies
// are the one thing these tests CANNOT pin in isolation: refresh-slice promotes the window's
// amendments itself and its reconciliation pass then re-flags every amended contract, so a stale
// INSERT copy is always superseded in-script and never observable in the end state.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration2Path = resolve(root, 'packages/db/migrations/0002_current_value_currency.sql');
const migration3Path = resolve(root, 'packages/db/migrations/0003_related_persons_foundation.sql');
// #305 Tier-2: served amendments gained value_restated/value_treatment (promote + refresh-slice write them).
const migration6Path = resolve(root, 'packages/db/migrations/0006_amendment_restated.sql');
const migration7Path = resolve(root, 'packages/db/migrations/0007_amendment_value_suspect.sql');
// #306 provenance columns on served `amendments` — promote/refresh-slice write contract_number_raw + link_method.
const migration8Path = resolve(root, 'packages/db/migrations/0008_amendment_provenance.sql');
const stagingPath = resolve(root, 'scripts/work-staging-schema.sql');
const derivePath = resolve(root, 'scripts/derive-amendments.sql');
const promotePath = resolve(root, 'scripts/promote-amendments.sql');
// Real pipeline order (scripts/import.mjs): the full derive runs derive-amendments before
// normalize-raw; the slice derive runs derive-amendments, and promote-amendments has populated the
// served amendments table that refresh-slice's reconciliation pass re-rolls current_value from.
const etlRuns = [
  ['normalize-raw', [derivePath, resolve(root, 'scripts/normalize-raw.sql')]],
  ['refresh-slice', [derivePath, promotePath, resolve(root, 'scripts/refresh-slice.sql')]],
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
  const dir = mkdtempSync(resolve(tmpdir(), `sigma-annexstep-${label}-`));
  const dbPath = resolve(dir, 'test.sqlite');
  try {
    readScript(dbPath, schemaPath);
    readScript(dbPath, migration2Path);
    readScript(dbPath, migration3Path);
    readScript(dbPath, migration6Path);
    readScript(dbPath, migration7Path);
    readScript(dbPath, migration8Path);
    readScript(dbPath, stagingPath);
    run(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Signing value in BGN; exactly 100_000 EUR so the multiples below read directly. The procedure
 *  estimate is the same, which keeps every case away from the estimate-driven flags (the стотинки
 *  band sits at 95x-105x the estimate; the largest aggregate used here is 30x). */
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
  steps: AmendmentStep[];
}

function seedContracts(dbPath: string, cases: { unp: string }[]): void {
  const tenders = cases
    .map(
      (c) =>
        `('eop:tenders:${c.unp}', '2026-06-01T00:00:00Z', '${c.unp}', '${AUTH_EIK}', 'Тестов възложител', 'public', ${SIGNING_BGN}, 'BGN')`,
    )
    .join(',\n');
  const contracts = cases
    .map(
      (c) =>
        `('eop:contracts:${c.unp}', '2026-06-01T00:00:00Z', '${c.unp}', '${AUTH_EIK}', 'Тестов възложител', 'C-${c.unp}', '2026-06-01', ${SIGNING_BGN}, 'BGN', '${BIDDER_EIK}', 'Тестов изпълнител')`,
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

describe('mis-keyed annex step in the value_flag CASE', () => {
  for (const [label, scriptPaths] of etlRuns) {
    it(`${label}: flags one big annex step whose aggregate stays inflated, and repairs to signing`, () => {
      withEtlDb(label, (dbPath) => {
        const cases: Case[] = [
          // A single mis-typed annex: 30x in one step, nothing corrects it. Far below the 100x the
          // old rule needed.
          {
            unp: 'UNP-STEP30',
            steps: [{ before: SIGNING_BGN, after: SIGNING_BGN * 30, publishedAt: '2026-06-10' }],
          },
          // Both thresholds exactly at the boundary: step exactly 10x, aggregate exactly 5x.
          {
            unp: 'UNP-EDGE',
            steps: [{ before: SIGNING_BGN / 2, after: SIGNING_BGN * 5, publishedAt: '2026-06-10' }],
          },
        ];
        seedContracts(dbPath, cases);
        seedAmendments(dbPath, cases);
        for (const p of scriptPaths) readScript(dbPath, p);

        const flags = flagsByUnp(dbPath);
        for (const unp of ['UNP-STEP30', 'UNP-EDGE']) {
          expect(flags.get(unp)?.value_flag, `${unp} should be annex_suspect`).toBe(
            'annex_suspect',
          );
          // Fell back to the signed value (100 000 EUR), not served at the inflated current value.
          expect(flags.get(unp)?.amount_eur, `${unp} repaired amount`).toBe(100_000);
        }
      });
    });

    it(`${label}: never flags a chain whose later annex corrects the typo back down`, () => {
      withEtlDb(label, (dbPath) => {
        const cases: Case[] = [
          // The corpus counter-example class: a huge step UP, then a correction that lands the
          // aggregate BELOW signing. Flagging would replace 50 000 EUR with 100 000 EUR - the
          // repair itself would inflate the contract.
          {
            unp: 'UNP-CORRECTED',
            steps: [
              { before: 5, after: SIGNING_BGN, publishedAt: '2026-06-10' },
              { before: SIGNING_BGN, after: SIGNING_BGN / 2, publishedAt: '2026-06-20' },
            ],
          },
        ];
        seedContracts(dbPath, cases);
        seedAmendments(dbPath, cases);
        for (const p of scriptPaths) readScript(dbPath, p);

        const flags = flagsByUnp(dbPath);
        expect(flags.get('UNP-CORRECTED')?.value_flag).toBe('ok');
        // Served at the corrected current value - half the signing value.
        expect(flags.get('UNP-CORRECTED')?.amount_eur).toBe(50_000);
      });
    });

    it(`${label}: needs BOTH halves - a big step under 5x aggregate, and a slow climb without one`, () => {
      withEtlDb(label, (dbPath) => {
        const cases: Case[] = [
          // Step 49x, but the aggregate stops at 4.9x signing - under the 5x floor.
          {
            unp: 'UNP-AGG49',
            steps: [
              { before: SIGNING_BGN / 10, after: SIGNING_BGN * 4.9, publishedAt: '2026-06-10' },
            ],
          },
          // Aggregate 8x through three doublings - no single step comes near 10x.
          {
            unp: 'UNP-SLOW8',
            steps: [
              { before: SIGNING_BGN, after: SIGNING_BGN * 2, publishedAt: '2026-06-10' },
              { before: SIGNING_BGN * 2, after: SIGNING_BGN * 4, publishedAt: '2026-06-20' },
              { before: SIGNING_BGN * 4, after: SIGNING_BGN * 8, publishedAt: '2026-06-30' },
            ],
          },
        ];
        seedContracts(dbPath, cases);
        seedAmendments(dbPath, cases);
        for (const p of scriptPaths) readScript(dbPath, p);

        const flags = flagsByUnp(dbPath);
        for (const unp of ['UNP-AGG49', 'UNP-SLOW8']) {
          expect(flags.get(unp)?.value_flag, `${unp} must not be annex_suspect`).toBe('ok');
        }
        // Both keep their as-recorded current value.
        expect(flags.get('UNP-AGG49')?.amount_eur).toBe(490_000);
        expect(flags.get('UNP-SLOW8')?.amount_eur).toBe(800_000);
      });
    });

    it(`${label}: the plain >=100x aggregate still flags even with no usable step`, () => {
      withEtlDb(label, (dbPath) => {
        const cases: Case[] = [
          // value_before missing on the only annex, so the step half can't fire - the original
          // aggregate rule must still catch the 150x blow-up on its own.
          {
            unp: 'UNP-AGG150',
            steps: [{ before: null, after: SIGNING_BGN * 150, publishedAt: '2026-06-10' }],
          },
        ];
        seedContracts(dbPath, cases);
        seedAmendments(dbPath, cases);
        for (const p of scriptPaths) readScript(dbPath, p);

        const flags = flagsByUnp(dbPath);
        expect(flags.get('UNP-AGG150')?.value_flag).toBe('annex_suspect');
        expect(flags.get('UNP-AGG150')?.amount_eur).toBe(100_000);
      });
    });
  }

  it('refresh-slice: the CLI slice path (no external promote) lands the same flags', () => {
    // scripts/import.mjs runSliceDerive runs derive-amendments + refresh-slice WITHOUT
    // promote-amendments. That still works because refresh-slice promotes the window's amendments
    // itself (INSERT OR REPLACE INTO amendments) before its reconciliation pass, which is therefore
    // authoritative for annex flags on this path too - this run pins exactly that pipeline shape.
    withEtlDb('no-promote', (dbPath) => {
      const cases: Case[] = [
        {
          unp: 'UNP-STEP30',
          steps: [{ before: SIGNING_BGN, after: SIGNING_BGN * 30, publishedAt: '2026-06-10' }],
        },
        {
          unp: 'UNP-CORRECTED',
          steps: [
            { before: 5, after: SIGNING_BGN, publishedAt: '2026-06-10' },
            { before: SIGNING_BGN, after: SIGNING_BGN / 2, publishedAt: '2026-06-20' },
          ],
        },
      ];
      seedContracts(dbPath, cases);
      seedAmendments(dbPath, cases);
      for (const p of [derivePath, resolve(root, 'scripts/refresh-slice.sql')])
        readScript(dbPath, p);

      const flags = flagsByUnp(dbPath);
      expect(flags.get('UNP-STEP30')?.value_flag).toBe('annex_suspect');
      expect(flags.get('UNP-STEP30')?.amount_eur).toBe(100_000);
      expect(flags.get('UNP-CORRECTED')?.value_flag).toBe('ok');
      expect(flags.get('UNP-CORRECTED')?.amount_eur).toBe(50_000);
    });
  });

  it('refresh-slice: re-flags a served contract when the annex arrives in a LATER window', () => {
    // The production shape of this bug class: the contract clears one refresh window as 'ok', the
    // mis-keyed annex lands in the next. The reconciliation pass matches the contract through
    // raw_amendments alone, re-rolls current_value from the served amendments table, and its
    // re-flag guard must let the contract through to be re-classified - a guard still keyed to the
    // old >=100x rule would keep it 'ok' forever.
    const [, refreshScripts] = etlRuns[1]!;
    withEtlDb('two-window', (dbPath) => {
      const cases: Case[] = [
        {
          unp: 'UNP-LATE',
          steps: [{ before: SIGNING_BGN, after: SIGNING_BGN * 30, publishedAt: '2026-07-10' }],
        },
      ];
      // Window 1: the contract alone.
      seedContracts(dbPath, cases);
      for (const p of refreshScripts) readScript(dbPath, p);
      expect(flagsByUnp(dbPath).get('UNP-LATE')?.value_flag).toBe('ok');

      // Window 2: only the annex is in the transient staging.
      sqlite(dbPath, 'DELETE FROM raw_contracts; DELETE FROM raw_tenders;');
      seedAmendments(dbPath, cases);
      for (const p of refreshScripts) readScript(dbPath, p);

      const row = flagsByUnp(dbPath).get('UNP-LATE');
      expect(row?.value_flag).toBe('annex_suspect');
      expect(row?.amount_eur).toBe(100_000);
    });
  });
});
