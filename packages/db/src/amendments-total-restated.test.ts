/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #305 Tier-2 text-based value correction. Some ЦАИС ЕОП annexes put the announced NEW TOTAL into the
// change field, so the feed's value_after is doubled. The основание-text heuristic (computed in TS
// ingest, packages/ingest/src/amendment-total.ts) classifies each annex and — because the correction is
// computed BEFORE the SQL runs — the raw row lands with value_treatment + value_after_restated already
// set. This suite simulates that ingest output and drives the REAL derive → normalize/refresh-slice →
// promote → precompute scripts in pipeline order on a real SQLite DB, asserting:
//   (a) a total_restated annex drives current_value + served value_after with the corrected total and is
//       NOT annex_total_suspect;
//   (b) a genuine_increment annex is not flagged and keeps its (larger, correct) value_after;
//   (c) an untreated doubled annex still gets the Tier-1 annex_total_suspect flag;
//   (d) full-vs-slice parity for the restated contract.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration1Path = resolve(root, 'packages/db/migrations/0001_flow_pairs_bidder_index.sql');
const migration2Path = resolve(root, 'packages/db/migrations/0002_current_value_currency.sql');
const migration3Path = resolve(root, 'packages/db/migrations/0003_related_persons_foundation.sql');
const migration6Path = resolve(root, 'packages/db/migrations/0006_amendment_restated.sql');
const migration7Path = resolve(root, 'packages/db/migrations/0007_amendment_value_suspect.sql');
// #306 provenance columns on served `amendments` — promote/refresh-slice write contract_number_raw + link_method.
const migration8Path = resolve(root, 'packages/db/migrations/0008_amendment_provenance.sql');
const stagingPath = resolve(root, 'scripts/work-staging-schema.sql');
const derivePath = resolve(root, 'scripts/derive-amendments.sql');
const normalizePath = resolve(root, 'scripts/normalize-raw.sql');
const promotePath = resolve(root, 'scripts/promote-amendments.sql');
const precomputePath = resolve(root, 'scripts/precompute.sql');
const refreshSlicePath = resolve(root, 'scripts/refresh-slice.sql');

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
  const dir = mkdtempSync(resolve(tmpdir(), `sigma-totalrestated-${label}-`));
  const dbPath = resolve(dir, 'test.sqlite');
  try {
    readScript(dbPath, schemaPath);
    readScript(dbPath, migration1Path);
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

const AUTH_EIK = '000695114';
const BIDDER_EIK = '831646048';

interface AmendmentStep {
  before: number | null;
  after: number;
  publishedAt: string;
  treatment: string | null;
  restatedAfter: number | null;
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

// Seed raw_amendments with value_treatment + value_after_restated already populated — simulating the TS
// ingest output (base.ts runs the amendment-total.ts heuristic before staging).
function seedAmendments(dbPath: string, cases: Case[]): void {
  const rows = cases
    .flatMap((c) =>
      c.steps.map(
        (s, i) =>
          `('eop:annexes:${c.unp}', '2026-06-01T00:00:00Z', 'A-${c.unp}-${i + 1}', '${c.unp}', 'C-${c.unp}', '${s.publishedAt}', ${s.before ?? 'NULL'}, ${s.after}, 'BGN', ${s.treatment === null ? 'NULL' : `'${s.treatment}'`}, ${s.restatedAfter ?? 'NULL'})`,
      ),
    )
    .join(',\n');
  if (!rows) return;
  sqlite(
    dbPath,
    `INSERT INTO raw_amendments
       (source, fetched_at, document_number, unp, contract_number, published_at,
        value_before, value_after, currency, value_treatment, value_after_restated)
     VALUES ${rows};`,
  );
}

interface ContractRow {
  id: string;
  value_flag: string;
  current_value: number | null;
}

const contractsByUnp = (dbPath: string): Map<string, ContractRow> => {
  const rows = sqliteJson<ContractRow>(
    dbPath,
    `SELECT id, value_flag, current_value FROM contracts`,
  );
  const out = new Map<string, ContractRow>();
  for (const r of rows) out.set(r.id.split(':')[2]!, r);
  return out;
};

interface AmendmentRow {
  unp: string;
  value_after: number | null;
  value_delta: number | null;
  value_restated: number | null;
}

const amendmentsByUnp = (dbPath: string): Map<string, AmendmentRow> => {
  const rows = sqliteJson<AmendmentRow>(
    dbPath,
    `SELECT unp, value_after, value_delta, value_restated FROM amendments`,
  );
  const out = new Map<string, AmendmentRow>();
  for (const r of rows) out.set(r.unp, r);
  return out;
};

// (a) total_restated: doubled value_after (981240) but the основание text announced the true total
// (539240). Ingest set value_after_restated=539240, value_treatment='total_restated'.
const RESTATED: Case = {
  unp: 'UNP-RESTATED',
  signing: 442_000,
  steps: [
    {
      before: 442_000,
      after: 981_240,
      publishedAt: '2026-06-10',
      treatment: 'total_restated',
      restatedAfter: 539_240,
    },
  ],
};

// (b) genuine_increment: value_after (60226.85) is a real ≥2× increase already applied; the text confirmed
// it, so ingest set value_treatment='genuine_increment' with restatedAfter NULL. Must NOT be flagged.
const GENUINE: Case = {
  unp: 'UNP-GENUINE',
  signing: 10_226.85,
  steps: [
    {
      before: 10_226.85,
      after: 60_226.85,
      publishedAt: '2026-06-10',
      treatment: 'genuine_increment',
      restatedAfter: null,
    },
  ],
};

// (c) untreated doubled annex: no text signal, before ≈ signing, same currency → Tier-1 unchanged.
const UNTREATED: Case = {
  unp: 'UNP-DOUBLE',
  signing: 77_000_000,
  steps: [
    {
      before: 77_000_000,
      after: 154_000_000,
      publishedAt: '2026-06-10',
      treatment: null,
      restatedAfter: null,
    },
  ],
};

describe('#305 Tier-2 text-based amendment value correction', () => {
  for (const [label, scriptPaths] of etlRuns) {
    it(`${label}: a total_restated annex drives the corrected total and is not flagged`, () => {
      withEtlDb(label, (dbPath) => {
        seedContracts(dbPath, [RESTATED]);
        seedAmendments(dbPath, [RESTATED]);
        for (const p of scriptPaths) readScript(dbPath, p);

        const contract = contractsByUnp(dbPath).get('UNP-RESTATED');
        expect(contract?.value_flag, 'restated annex is not arithmetic-flagged').toBe('ok');
        expect(
          contract?.current_value,
          'current_value is the corrected total, NOT the doubled value',
        ).toBe(539_240);

        const amendment = amendmentsByUnp(dbPath).get('UNP-RESTATED');
        expect(amendment?.value_after, 'served value_after is the corrected total').toBe(539_240);
        expect(amendment?.value_delta, 'served delta is self-consistent (after − before)').toBe(
          539_240 - 442_000,
        );
        expect(amendment?.value_restated, 'served row is marked restated').toBe(1);
      });
    });

    it(`${label}: a genuine_increment annex is not flagged and keeps its value_after`, () => {
      withEtlDb(label, (dbPath) => {
        seedContracts(dbPath, [GENUINE]);
        seedAmendments(dbPath, [GENUINE]);
        for (const p of scriptPaths) readScript(dbPath, p);

        const contract = contractsByUnp(dbPath).get('UNP-GENUINE');
        expect(contract?.value_flag, 'confirmed-genuine increment is not flagged').not.toBe(
          'annex_total_suspect',
        );
        expect(contract?.current_value, 'current_value keeps the genuine increase').toBe(60_226.85);

        const amendment = amendmentsByUnp(dbPath).get('UNP-GENUINE');
        expect(amendment?.value_after, 'served value_after unchanged').toBe(60_226.85);
        expect(amendment?.value_restated, 'genuine increment is not marked restated').toBe(0);
      });
    });

    it(`${label}: an untreated doubled annex still gets the Tier-1 annex_total_suspect flag`, () => {
      withEtlDb(label, (dbPath) => {
        seedContracts(dbPath, [UNTREATED]);
        seedAmendments(dbPath, [UNTREATED]);
        for (const p of scriptPaths) readScript(dbPath, p);

        const contract = contractsByUnp(dbPath).get('UNP-DOUBLE');
        expect(contract?.value_flag, 'untreated double is still flagged').toBe(
          'annex_total_suspect',
        );

        const amendment = amendmentsByUnp(dbPath).get('UNP-DOUBLE');
        expect(amendment?.value_restated, 'untreated double is not marked restated').toBe(0);
      });
    });
  }

  it('full-vs-slice parity: the total_restated contract resolves identically on both paths', () => {
    let full: ContractRow | undefined;
    withEtlDb('parity-full', (dbPath) => {
      seedContracts(dbPath, [RESTATED]);
      seedAmendments(dbPath, [RESTATED]);
      for (const p of [derivePath, normalizePath, promotePath, precomputePath])
        readScript(dbPath, p);
      full = contractsByUnp(dbPath).get('UNP-RESTATED');
    });

    let slice: ContractRow | undefined;
    withEtlDb('parity-slice', (dbPath) => {
      seedContracts(dbPath, [RESTATED]);
      seedAmendments(dbPath, [RESTATED]);
      for (const p of [derivePath, refreshSlicePath, precomputePath]) readScript(dbPath, p);
      slice = contractsByUnp(dbPath).get('UNP-RESTATED');
    });

    // Pin both paths to the concrete expected values — a cross-equality (full === slice) would also
    // pass on dual-undefined, so assert against the literal on each path instead.
    expect(full?.value_flag).toBe('ok');
    expect(slice?.value_flag).toBe('ok');
    expect(full?.current_value).toBe(539_240);
    expect(slice?.current_value).toBe(539_240);
  });
});
