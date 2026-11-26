// The CLI slice derive (`import.mjs --derive=slice`, the local refresh path) keeps the as-of date and the
// data generation with the served data exactly as the Worker does: the date moves in the `contracts` batch
// with the contract rows, the generation before the first and after the last batch that writes served rows,
// and nothing about either waits for — or depends on — the integrity gate.
//
// Drives the REAL scripts/import.mjs as a subprocess. `wrangler` is a stand-in that applies every --file to
// a node:sqlite database built from the real migrations and answers every --json --command from it, so the
// real refresh-slice.sql batches, load-nuts.sql, seed-state-owned.sql and the real integrity gate all run;
// it can refuse one batch file (a death in that batch) or tamper after one. `node` stands in for the child
// scripts: load-eop stages the bucket records through the real mapBaseRecord, load-fx does nothing (the
// fixture is in BGN).
//
// Run: node --test scripts/import-slice-freshness.test.mjs
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { refreshSliceStatementGroups, splitSqlStatements } from '../packages/ingest/src/refresh.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPT = resolve(HERE, 'import.mjs');

// The shebangs name the real interpreter: `#!/usr/bin/env node` would find the fake `node` on PATH.
const FAKE_WRANGLER = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const argv = process.argv.slice(2);
appendFileSync(process.env.SLICE_LOG, JSON.stringify(argv) + '\\n');
if (argv[1] === 'migrations') process.exit(0);
const db = new DatabaseSync(process.env.SLICE_DB);
const fi = argv.indexOf('--file');
if (fi !== -1) {
  const file = argv[fi + 1];
  const batch = basename(dirname(file)).startsWith('refresh-slice-') ? basename(file, '.sql') : null;
  if (batch && batch === process.env.SLICE_FAIL_AT) {
    process.stderr.write('D1_ERROR: out of memory: SQLITE_NOMEM\\n');
    process.exit(1);
  }
  db.exec(readFileSync(file, 'utf8'));
  if (batch && batch === process.env.SLICE_TAMPER_AFTER) db.exec(process.env.SLICE_TAMPER_SQL);
  process.exit(0);
}
const ci = argv.indexOf('--command');
if (ci !== -1) {
  process.stdout.write(JSON.stringify([{ results: db.prepare(argv[ci + 1]).all(), success: true }]));
}
process.exit(0);
`;

const FAKE_NODE = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const argv = process.argv.slice(2);
appendFileSync(process.env.SLICE_LOG, JSON.stringify(['node', ...argv]) + '\\n');
if (String(argv[0]).endsWith('load-eop.mjs')) {
  const { BASE_CONTRACT_COLS, mapBaseRecord } = await import(process.env.SLICE_BASE_TS);
  const { day, records } = JSON.parse(process.env.SLICE_BUCKET);
  const db = new DatabaseSync(process.env.SLICE_DB);
  const insert = db.prepare(
    'INSERT INTO raw_contracts (' + BASE_CONTRACT_COLS.join(', ') + ') VALUES (' +
      BASE_CONTRACT_COLS.map(() => '?').join(', ') + ')',
  );
  for (const record of records) {
    const row = mapBaseRecord('contracts', record, { day, fetchedAt: day + 'T06:00:00.000Z' });
    if (row) insert.run(...BASE_CONTRACT_COLS.map((c) => row[c] ?? null));
  }
}
process.exit(0);
`;

const contract = (over) => ({
  publicationDate: '2026-07-09',
  procedureType: 'open',
  typeOfContract: 'services',
  buyerName: 'Община Тест',
  buyerRegistryNumber: '123456789',
  buyerType: 'public',
  lotIdentifier: '1',
  contractCurrency: 'BGN',
  supplierRegisterNumber: '987654322',
  supplierName: 'ТЕСТ ГРУП ЕООД',
  supplierNationality: 'BG',
  offersCount: '2',
  ...over,
});
const FIRST = {
  day: '2026-07-09',
  records: [
    contract({
      noticeId: 'DOC-CLI-1',
      uniqueProcurementNumber: 'UNP-CLI-1',
      tenderId: 'TENDER-CLI-1',
      tenderName: 'First tender',
      contractNumber: 'CONTRACT-CLI-1',
      contractDate: '2026-07-08',
      contractValue: '1000',
      contractSubject: 'A first contract',
    }),
  ],
};
const NEXT = {
  day: '2026-07-12',
  records: [
    contract({
      noticeId: 'DOC-CLI-2',
      publicationDate: '2026-07-12',
      uniqueProcurementNumber: 'UNP-CLI-2',
      tenderId: 'TENDER-CLI-2',
      tenderName: 'Next tender',
      contractNumber: 'CONTRACT-CLI-2',
      contractDate: '2026-07-11',
      contractValue: '2000',
      contractSubject: 'A later contract',
    }),
  ],
};

// The as_of expression of the full build, read out of scripts/precompute.sql rather than restated: what a
// rebuild of the slot would write for the rows it serves.
const PRECOMPUTE_AS_OF = (() => {
  const insert = splitSqlStatements(
    readFileSync(resolve(ROOT, 'scripts/precompute.sql'), 'utf8'),
  ).find((s) => /^INSERT INTO home_totals\b/.test(s));
  const [, columns, select] = insert.match(
    /^INSERT INTO home_totals \(([^)]*)\)\s*SELECT\s+([\s\S]*)$/,
  );
  const items = [];
  let depth = 0;
  let current = '';
  for (const ch of select) {
    if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    current += ch;
  }
  items.push(current.trim());
  return items[
    columns
      .split(',')
      .map((c) => c.trim())
      .indexOf('as_of')
  ];
})();

const STAMP = '2026-07-10 00:31:00';

function binaries(dir) {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'package.json'), '{"type":"module"}');
  for (const [name, source] of [
    ['wrangler', FAKE_WRANGLER],
    ['node', FAKE_NODE],
  ]) {
    writeFileSync(join(binDir, name), source);
    chmodSync(join(binDir, name), 0o755);
  }
  return binDir;
}

function runImport(dir, dbFile, bucket, env = {}) {
  const res = spawnSync(
    process.execPath,
    [SCRIPT, `--from=${bucket.day}`, `--to=${bucket.day}`, '--derive=slice'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        SIGMA_D1_NAME: 'sigma-test-local',
        SLICE_DB: dbFile,
        SLICE_LOG: join(dir, 'calls.log'),
        SLICE_BASE_TS: resolve(ROOT, 'packages/ingest/src/base.ts'),
        SLICE_BUCKET: JSON.stringify(bucket),
        ...env,
      },
    },
  );
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const servedSql = `SELECT as_of AS asOf, refreshed_at AS generation, (SELECT COUNT(*) FROM contracts) AS contracts,
    (SELECT ${PRECOMPUTE_AS_OF}) AS rebuilt
  FROM home_totals WHERE id = 1`;

// One complete CLI slice derive over the real migrations, made once and copied for every test: a served
// slot showing 2026-07-08, with its generation pinned to STAMP (datetime('now') does not move inside one
// second, so a later write is visible only against an earlier instant).
let seeded;
function seed() {
  if (seeded) return seeded;
  const dir = mkdtempSync(join(tmpdir(), 'slice-freshness-seed-'));
  binaries(dir);
  const dbFile = join(dir, 'served.sqlite');
  const db = new DatabaseSync(dbFile);
  const migrations = resolve(ROOT, 'packages/db/migrations');
  for (const file of readdirSync(migrations).sort()) {
    if (file.endsWith('.sql')) db.exec(readFileSync(join(migrations, file), 'utf8'));
  }
  const first = runImport(dir, dbFile, FIRST);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /integrity gate passed/);
  db.exec(`UPDATE home_totals SET refreshed_at = '${STAMP}' WHERE id = 1`);
  assert.deepEqual(
    { ...db.prepare(servedSql).get() },
    { asOf: '2026-07-08', generation: STAMP, contracts: 1, rebuilt: '2026-07-08' },
  );
  db.close();
  seeded = { dir, dbFile };
  return seeded;
}

/** A copy of the seeded slot, and the CLI to run the next import against it. */
function afterFirstImport() {
  const dir = mkdtempSync(join(tmpdir(), 'slice-freshness-'));
  binaries(dir);
  const dbFile = join(dir, 'served.sqlite');
  copyFileSync(seed().dbFile, dbFile);
  const db = new DatabaseSync(dbFile);
  return {
    runImport: (bucket, env) => runImport(dir, dbFile, bucket, env),
    served: () => db.prepare(servedSql).get(),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

after(() => {
  if (seeded) rmSync(seeded.dir, { recursive: true, force: true });
});

test('the CLI derive writes the date with the expression the full build writes', () => {
  const slice = refreshSliceStatementGroups(
    readFileSync(resolve(ROOT, 'scripts/refresh-slice.sql'), 'utf8'),
  ).find((g) => g.name === 'contracts');
  assert.ok(
    slice.statements.includes(`UPDATE home_totals SET as_of = ${PRECOMPUTE_AS_OF} WHERE id = 1`),
    'the `contracts` batch must write home_totals.as_of with the full build expression',
  );
});

// Each test has its own database and temp files, and each import is a few seconds of subprocesses.
describe('the CLI slice derive', { concurrency: true }, () => {
  test('CLI: a slice that dies before any served row changes moves neither the date nor the generation', () => {
    const h = afterFirstImport();
    try {
      const r = h.runImport(NEXT, { SLICE_FAIL_AT: 'setup' });
      assert.notEqual(r.status, 0);
      assert.deepEqual(
        { ...h.served() },
        {
          asOf: '2026-07-08',
          generation: STAMP,
          contracts: 1,
          rebuilt: '2026-07-08',
        },
      );
    } finally {
      h.cleanup();
    }
  });

  test('CLI: a slice that dies right before `contracts` keeps the previous date, never NULL, and moves the generation', () => {
    const h = afterFirstImport();
    try {
      const r = h.runImport(NEXT, { SLICE_FAIL_AT: 'contracts' });
      assert.notEqual(r.status, 0);
      const after = h.served();
      assert.equal(after.asOf, '2026-07-08');
      assert.equal(after.asOf, after.rebuilt);
      assert.equal(after.contracts, 1);
      assert.ok(after.generation > STAMP, `generation ${after.generation} must have moved`);
    } finally {
      h.cleanup();
    }
  });

  for (const batch of ['amendments', 'cleanup']) {
    test(`CLI: a slice that dies at ${batch} serves the new contract under its date`, () => {
      const h = afterFirstImport();
      try {
        const r = h.runImport(NEXT, { SLICE_FAIL_AT: batch });
        assert.notEqual(r.status, 0);
        const after = h.served();
        assert.equal(after.asOf, '2026-07-11');
        assert.equal(after.asOf, after.rebuilt);
        assert.equal(after.contracts, 2);
        assert.ok(after.generation > STAMP, `generation ${after.generation} must have moved`);
      } finally {
        h.cleanup();
      }
    });
  }

  test('CLI: a gate violation stops the import, and the date and the generation still describe what is served', () => {
    const h = afterFirstImport();
    try {
      const r = h.runImport(NEXT, {
        SLICE_TAMPER_AFTER: 'cleanup',
        SLICE_TAMPER_SQL: 'UPDATE home_totals SET value_eur = value_eur + 1000 WHERE id = 1',
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /rollup-reconciliation/);
      const after = h.served();
      assert.equal(after.asOf, '2026-07-11');
      assert.equal(after.asOf, after.rebuilt);
      assert.ok(after.generation > STAMP);
    } finally {
      h.cleanup();
    }
  });

  test('CLI: a complete slice moves the date with the new contract and the generation after its last batch', () => {
    const h = afterFirstImport();
    try {
      // A page rendered right after `globals` carries this generation; the batches after it still change
      // what that page shows, so the finished slice must move the generation past it.
      const AFTER_GLOBALS = '2026-07-13 00:31:00';
      const r = h.runImport(NEXT, {
        SLICE_TAMPER_AFTER: 'globals',
        SLICE_TAMPER_SQL: `UPDATE home_totals SET refreshed_at = '${AFTER_GLOBALS}' WHERE id = 1`,
      });
      assert.equal(r.status, 0, r.stderr);
      const after = h.served();
      assert.equal(after.asOf, '2026-07-11');
      assert.equal(after.asOf, after.rebuilt);
      assert.equal(after.contracts, 2);
      assert.ok(after.generation > AFTER_GLOBALS, `generation ${after.generation} must have moved`);
    } finally {
      h.cleanup();
    }
  });
});
