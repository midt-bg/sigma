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
// #305 Tier-2: served amendments gained value_restated/value_treatment (promote + refresh-slice write them).
const migration6Path = resolve(root, 'packages/db/migrations/0006_amendment_restated.sql');
// #305 residual: served amendments gained value_suspect (promote + refresh-slice write it).
const migration7Path = resolve(root, 'packages/db/migrations/0007_amendment_value_suspect.sql');
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
    readScript(dbPath, migration6Path);
    readScript(dbPath, migration7Path);
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

// #305 residual: seed raw_amendments including value_treatment + value_after_restated (the TS ingest
// output) so the served value_suspect / value_restated marks can be asserted end-to-end.
interface TreatedStep {
  before: number | null;
  after: number;
  publishedAt: string;
  treatment: string | null;
  restatedAfter: number | null;
}
interface TreatedCase {
  unp: string;
  signing: number;
  steps: TreatedStep[];
}

function seedTreatedContracts(dbPath: string, cases: TreatedCase[]): void {
  seedContracts(
    dbPath,
    cases.map((c) => ({ unp: c.unp, signing: c.signing, steps: [] })),
  );
}

function seedTreatedAmendments(dbPath: string, cases: TreatedCase[]): void {
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

interface ServedAmendment {
  unp: string;
  value_after: number | null;
  value_suspect: number | null;
  value_restated: number | null;
}
const servedByUnp = (dbPath: string): Map<string, ServedAmendment> => {
  const rows = sqliteJson<ServedAmendment>(
    dbPath,
    `SELECT unp, value_after, value_suspect, value_restated FROM amendments`,
  );
  const out = new Map<string, ServedAmendment>();
  for (const r of rows) out.set(r.unp, r);
  return out;
};

// (a) flag-only double: no основание signal (value_treatment NULL), before ≈ signing, value_after = 3×
// before. We can't bridge the true total → mark value_suspect = 1, keep value_restated = 0, and the
// served value_after stays the untrusted figure (the UI blanks it; the number is never rewritten).
const FLAG_ONLY: TreatedCase = {
  unp: 'UNP-FLAGONLY',
  signing: 100,
  steps: [
    { before: 100, after: 300, publishedAt: '2026-06-10', treatment: null, restatedAfter: null },
  ],
};
// (b) total_restated: text-treated → value_restated = 1, value_suspect = 0.
const RESTATED: TreatedCase = {
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
// (c) genuine_increment: text-confirmed real increase → both marks 0.
const GENUINE: TreatedCase = {
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

describe('#305 residual: per-amendment value_suspect marker on the served row', () => {
  for (const [label, scriptPaths] of etlRuns) {
    it(`${label}: a flag-only double is marked value_suspect=1, value_restated=0, value_after untouched`, () => {
      withEtlDb(label, (dbPath) => {
        seedTreatedContracts(dbPath, [FLAG_ONLY, RESTATED, GENUINE]);
        seedTreatedAmendments(dbPath, [FLAG_ONLY, RESTATED, GENUINE]);
        for (const p of scriptPaths) readScript(dbPath, p);

        const served = servedByUnp(dbPath);

        const flagOnly = served.get('UNP-FLAGONLY');
        expect(flagOnly?.value_suspect, 'flag-only double is marked suspect').toBe(1);
        expect(flagOnly?.value_restated, 'flag-only double is NOT restated').toBe(0);
        expect(flagOnly?.value_after, 'served value_after is never rewritten').toBe(300);

        const restated = served.get('UNP-RESTATED');
        expect(restated?.value_restated, 'total_restated row is marked restated').toBe(1);
        expect(restated?.value_suspect, 'a restated row is never also suspect').toBe(0);

        const genuine = served.get('UNP-GENUINE');
        expect(genuine?.value_suspect, 'genuine increment is not suspect').toBe(0);
        expect(genuine?.value_restated, 'genuine increment is not restated').toBe(0);
      });
    });
  }

  it('full-vs-slice parity: the flag-only double gets value_suspect=1 on both paths', () => {
    let full: ServedAmendment | undefined;
    withEtlDb('parity-full', (dbPath) => {
      seedTreatedContracts(dbPath, [FLAG_ONLY]);
      seedTreatedAmendments(dbPath, [FLAG_ONLY]);
      for (const p of [derivePath, normalizePath, promotePath, precomputePath])
        readScript(dbPath, p);
      full = servedByUnp(dbPath).get('UNP-FLAGONLY');
    });

    let slice: ServedAmendment | undefined;
    withEtlDb('parity-slice', (dbPath) => {
      seedTreatedContracts(dbPath, [FLAG_ONLY]);
      seedTreatedAmendments(dbPath, [FLAG_ONLY]);
      for (const p of [derivePath, refreshSlicePath, precomputePath]) readScript(dbPath, p);
      slice = servedByUnp(dbPath).get('UNP-FLAGONLY');
    });

    // Pin both paths to the concrete expected value — a cross-equality (full === slice) would also pass
    // on dual-undefined, so assert against the literal on each path instead.
    expect(full?.value_suspect).toBe(1);
    expect(slice?.value_suspect).toBe(1);
  });
});

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

// #305 multi-annex residual: the doubled step is NOT always the first annex. When a later annex reports
// a new TOTAL added to an already-grown value, its value_before is the prior CUMULATIVE total (a preceding
// annex's value_after), not signing. The relaxed anchor flags these too; the ≥2× single-step gate (ЗОП
// чл.116) keeps slow legitimate climbs — whose later steps never reach 2× — untouched.
describe('#305 annex_total_suspect multi-annex value double-count', () => {
  for (const [label, scriptPaths] of etlRuns) {
    it(`${label}: flags a later-in-chain double whose value_before ties to a prior annex total, not signing`, () => {
      withEtlDb(label, (dbPath) => {
        const cases: Case[] = [
          // Chain: 1M signed → annex1 +40% (1.4M, legal, not a double) → annex2 doubles the 1.4M total to
          // 2.8M. The driving annex's value_before (1.4M) equals the PRIOR annex's value_after, not signing
          // (1M), so the old signing-only anchor missed it. Must now flag and fall back to signing.
          {
            unp: 'UNP-MULTI-DOUBLE',
            signing: 1_000_000,
            steps: [
              { before: 1_000_000, after: 1_400_000, publishedAt: '2026-06-10' },
              { before: 1_400_000, after: 2_800_000, publishedAt: '2026-06-20' },
            ],
          },
          // Control: same shape but the later step is a legal +36% (1.4M → 1.9M), below 2×. The relaxed
          // anchor matches value_before to the prior total, but the ≥2× gate must keep this 'ok'.
          {
            unp: 'UNP-MULTI-OK',
            signing: 1_000_000,
            steps: [
              { before: 1_000_000, after: 1_400_000, publishedAt: '2026-06-10' },
              { before: 1_400_000, after: 1_900_000, publishedAt: '2026-06-20' },
            ],
          },
        ];
        seedContracts(dbPath, cases);
        seedAmendments(dbPath, cases);
        for (const p of scriptPaths) readScript(dbPath, p);

        const rows = rowsByUnp(dbPath);

        const multiDouble = rows.get('UNP-MULTI-DOUBLE');
        expect(multiDouble?.value_flag, 'later-in-chain double flagged').toBe(
          'annex_total_suspect',
        );
        expect(multiDouble?.amount_eur, 'amount_eur falls back to signing').toBe(
          Math.round(1_000_000 / 1.95583),
        );
        expect(multiDouble?.current_value_eur, 'current_value_eur suppressed').toBeNull();

        const multiOk = rows.get('UNP-MULTI-OK');
        expect(multiOk?.value_flag, 'legal <2x later step stays ok').toBe('ok');
        expect(multiOk?.amount_eur, 'ok row keeps current value').toBe(
          Math.round(1_900_000 / 1.95583),
        );
        expect(multiOk?.current_value_eur).toBe(Math.round(1_900_000 / 1.95583));
      });
    });
  }

  // The per-row value_suspect marker (served amendments) must also catch the later-in-chain double, so the
  // UI blanks that specific annex row — not just the contract-level flag.
  const MULTI_TREATED: TreatedCase = {
    unp: 'UNP-MULTI-SUSPECT',
    signing: 1_000_000,
    steps: [
      {
        before: 1_000_000,
        after: 1_400_000,
        publishedAt: '2026-06-10',
        treatment: null,
        restatedAfter: null,
      },
      {
        before: 1_400_000,
        after: 2_800_000,
        publishedAt: '2026-06-20',
        treatment: null,
        restatedAfter: null,
      },
    ],
  };

  for (const [label, scriptPaths] of etlRuns) {
    it(`${label}: marks value_suspect=1 on the later-in-chain doubled annex row, not the legal earlier one`, () => {
      withEtlDb(label, (dbPath) => {
        seedTreatedContracts(dbPath, [MULTI_TREATED]);
        seedTreatedAmendments(dbPath, [MULTI_TREATED]);
        for (const p of scriptPaths) readScript(dbPath, p);

        const served = sqliteJson<{ value_after: number; value_suspect: number }>(
          dbPath,
          `SELECT value_after, value_suspect FROM amendments
             WHERE unp = 'UNP-MULTI-SUSPECT' ORDER BY value_after`,
        );
        expect(served.length, 'both annex rows served').toBe(2);
        // The legal +40% step (1.4M) is not suspect; the doubled step (2.8M) is.
        const legal = served.find((r) => r.value_after === 1_400_000);
        const doubled = served.find((r) => r.value_after === 2_800_000);
        expect(legal?.value_suspect, 'legal earlier step not suspect').toBe(0);
        expect(doubled?.value_suspect, 'later-in-chain double marked suspect').toBe(1);
      });
    });
  }
});

// #305 NEW-HIGH-1 (multi-annex chain contamination): the double-count correction is per-row and does NOT
// propagate down a chain. A restated prior annex (doubled → corrected down) leaves a LATER annex still
// computed by the feed on the contaminated (raw, doubled) base. The later annex's own step ratio is
// legitimate (<2×) so the arithmetic gate misses it and the prior is text-treated (excluded) — yet
// current_value inherited the doubled total. The new branch flags it → signing fallback, on both paths.
describe('#305 NEW-HIGH-1 multi-annex chain contamination', () => {
  // annex1 doubled 1M→2.4M, text-restated to 1.4M; annex2 is a real +15% the feed computed on the RAW 2.4M
  // base (2.4M→2.76M). annex2's own ratio is 1.15× so the gate misses it; annex1 is treated so it is
  // excluded. Without the fix, current_value serves the contaminated 2.76M.
  const CONTAM: TreatedCase = {
    unp: 'UNP-CHAIN-CONTAM',
    signing: 1_000_000,
    steps: [
      {
        before: 1_000_000,
        after: 2_400_000,
        publishedAt: '2026-06-10',
        treatment: 'total_restated',
        restatedAfter: 1_400_000,
      },
      {
        before: 2_400_000,
        after: 2_760_000,
        publishedAt: '2026-06-20',
        treatment: null,
        restatedAfter: null,
      },
    ],
  };
  // Control: the same shape on an HONEST base — annex1 is a genuine +40% (no restatement), annex2 +15% on
  // the clean 1.4M base. No treated prior, so the contamination branch must NOT fire; stays 'ok'.
  const CLEAN: TreatedCase = {
    unp: 'UNP-CHAIN-CLEAN',
    signing: 1_000_000,
    steps: [
      {
        before: 1_000_000,
        after: 1_400_000,
        publishedAt: '2026-06-10',
        treatment: null,
        restatedAfter: null,
      },
      {
        before: 1_400_000,
        after: 1_610_000,
        publishedAt: '2026-06-20',
        treatment: null,
        restatedAfter: null,
      },
    ],
  };

  for (const [label, scriptPaths] of etlRuns) {
    it(`${label}: flags a later annex riding a restated prior's doubled base, and keeps a clean chain ok`, () => {
      withEtlDb(label, (dbPath) => {
        seedTreatedContracts(dbPath, [CONTAM, CLEAN]);
        seedTreatedAmendments(dbPath, [CONTAM, CLEAN]);
        for (const p of scriptPaths) readScript(dbPath, p);

        const rows = rowsByUnp(dbPath);

        const contam = rows.get('UNP-CHAIN-CONTAM');
        expect(contam?.value_flag, 'contaminated later annex flagged').toBe('annex_total_suspect');
        expect(contam?.amount_eur, 'falls back to signing, not the contaminated 2.76M').toBe(
          Math.round(1_000_000 / 1.95583),
        );
        expect(contam?.current_value_eur, 'contaminated current_value suppressed').toBeNull();

        const clean = rows.get('UNP-CHAIN-CLEAN');
        expect(clean?.value_flag, 'honest two-step growth stays ok').toBe('ok');
        expect(clean?.current_value_eur).toBe(Math.round(1_610_000 / 1.95583));
      });
    });
  }

  it('full-vs-slice parity: the contaminated chain gets the same flag on both paths', () => {
    let fullFlag: string | undefined;
    withEtlDb('parity-full', (dbPath) => {
      seedTreatedContracts(dbPath, [CONTAM]);
      seedTreatedAmendments(dbPath, [CONTAM]);
      for (const p of [derivePath, normalizePath, promotePath, precomputePath])
        readScript(dbPath, p);
      fullFlag = rowsByUnp(dbPath).get('UNP-CHAIN-CONTAM')?.value_flag;
    });

    let sliceFlag: string | undefined;
    withEtlDb('parity-slice', (dbPath) => {
      seedTreatedContracts(dbPath, [CONTAM]);
      seedTreatedAmendments(dbPath, [CONTAM]);
      for (const p of [derivePath, refreshSlicePath, precomputePath]) readScript(dbPath, p);
      sliceFlag = rowsByUnp(dbPath).get('UNP-CHAIN-CONTAM')?.value_flag;
    });

    expect(fullFlag).toBe('annex_total_suspect');
    expect(sliceFlag).toBe('annex_total_suspect');
  });
});

// #305 84818-class: an EXACT single-step 2× (value_after ≈ 2× value_before) is the ЗОП чл.116 defect
// signature even when value_before anchors to NEITHER signing NOR a prior annex total (an orphan base) —
// as in real contract 84818, whose annex reports 76.77M → 153.54M on a base unrelated to the contract's
// signing. The gate flags it → signing fallback (EXCLUDE), without ever rewriting the value.
describe('#305 84818-class orphan exact-double', () => {
  for (const [label, scriptPaths] of etlRuns) {
    it(`${label}: flags an exact 2× on an orphan base, but leaves a non-exact orphan jump ok`, () => {
      withEtlDb(label, (dbPath) => {
        const cases: Case[] = [
          // Orphan exact 2×: value_before 90 000 ties neither signing (195 583) nor any prior annex, and
          // value_after is exactly 2×. Flag → signing fallback (100 000 EUR), never the doubled 180 000.
          {
            unp: 'UNP-ORPHAN-EXACT',
            signing: 195_583,
            steps: [{ before: 90_000, after: 180_000, publishedAt: '2026-06-10' }],
          },
          // Control: an orphan jump that is NOT an exact 2× (1.5×) is ambiguous — with no anchor and no
          // exact-double signature it must stay ok (the relaxed rule is scoped to EXACT 2× only).
          {
            unp: 'UNP-ORPHAN-SMALL',
            signing: 195_583,
            steps: [{ before: 90_000, after: 135_000, publishedAt: '2026-06-10' }],
          },
        ];
        seedContracts(dbPath, cases);
        seedAmendments(dbPath, cases);
        for (const p of scriptPaths) readScript(dbPath, p);

        const rows = rowsByUnp(dbPath);

        const orphan = rows.get('UNP-ORPHAN-EXACT');
        expect(orphan?.value_flag, 'orphan exact 2× flagged').toBe('annex_total_suspect');
        expect(orphan?.amount_eur, 'falls back to signing, not the doubled 180k').toBe(
          Math.round(195_583 / 1.95583),
        );
        expect(orphan?.current_value_eur, 'doubled current suppressed').toBeNull();

        const small = rows.get('UNP-ORPHAN-SMALL');
        expect(small?.value_flag, 'non-exact orphan jump stays ok').toBe('ok');
        expect(small?.current_value_eur).toBe(Math.round(135_000 / 1.95583));
      });
    });
  }
});

// #305 NEW-HIGH-2 (reconciliation parity): the slice reconciliation reads the CUMULATIVE served
// `amendments`, whose value_after is RESTATED, while the full path anchors on RAW values. A restated prior
// annex used to flip the anchor's "prev not itself a double" test (restated 1.4M < 2×1.2M passes; the raw
// 2.4M would fail), flagging on the slice but not on the full rebuild. The `prev.value_restated = 0` guard
// restores parity: both paths reach the same verdict for a restated-prior + doubled-later chain.
describe('#305 NEW-HIGH-2 slice reconciliation parity', () => {
  // annex1 doubled 1.2M→2.4M, restated to 1.4M; annex2 grows the RESTATED 1.4M to 2.9M (a ≥2× step, but
  // deliberately NOT an exact 2× so the 84818-class rule doesn't fire and mask the guard under test). On the
  // full (raw) path annex2's value_before (1.4M) anchors to neither signing (1M) nor the raw prior total
  // (2.4M) → 'ok'. Pre-guard the slice reconciliation matched the restated 1.4M and flagged — the flip.
  // Post-guard (prev.value_restated = 0): 'ok', matching the full rebuild.
  const FLIP: TreatedCase = {
    unp: 'UNP-RECON-FLIP',
    signing: 1_000_000,
    steps: [
      {
        before: 1_200_000,
        after: 2_400_000,
        publishedAt: '2026-06-10',
        treatment: 'total_restated',
        restatedAfter: 1_400_000,
      },
      {
        before: 1_400_000,
        after: 2_900_000,
        publishedAt: '2026-06-20',
        treatment: null,
        restatedAfter: null,
      },
    ],
  };

  it('full and slice agree on a restated-prior + doubled-later chain (no flag flip)', () => {
    let fullFlag: string | undefined;
    withEtlDb('parity-full', (dbPath) => {
      seedTreatedContracts(dbPath, [FLIP]);
      seedTreatedAmendments(dbPath, [FLIP]);
      for (const p of [derivePath, normalizePath, promotePath, precomputePath])
        readScript(dbPath, p);
      fullFlag = rowsByUnp(dbPath).get('UNP-RECON-FLIP')?.value_flag;
    });

    let sliceFlag: string | undefined;
    withEtlDb('parity-slice', (dbPath) => {
      seedTreatedContracts(dbPath, [FLIP]);
      seedTreatedAmendments(dbPath, [FLIP]);
      for (const p of [derivePath, refreshSlicePath, precomputePath]) readScript(dbPath, p);
      sliceFlag = rowsByUnp(dbPath).get('UNP-RECON-FLIP')?.value_flag;
    });

    // The canonical full-rebuild verdict, matched by the slice (pre-guard the slice flipped to suspect).
    expect(sliceFlag).toBe(fullFlag);
  });
});
