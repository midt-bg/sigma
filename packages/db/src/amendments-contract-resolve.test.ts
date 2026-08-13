// Issue #306 — EOP annexes whose annex-side number is in a different namespace than the contract number
// (the annex carries an internal number like 148846; the contract carries the buyer's filing number like
// Д-226), so the (unp, contract_number) join drops them out of every annex→contract rollup. The resolver in
// derive-amendments.sql links them by the exact, currency-matched value_before → signing_value anchor
// (measured 99.99% precision on the real corpus), uniquely, with chain propagation, leaving ambiguous /
// no-match annexes honestly unlinked.
//
// Runs the REAL derive-amendments.sql against SQLite via the sqlite3 CLI, exactly as the ETL does — the
// value anchor, uniqueness gate, currency guard, and chain propagation are exercised as shipped.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const initSchema = resolve(root, 'packages/db/migrations/0000_init.sql');
const workStagingSchema = resolve(root, 'scripts/work-staging-schema.sql');
const deriveAmendments = resolve(root, 'scripts/derive-amendments.sql');

function sqlite(dbPath: string, sql: string): void {
  execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8', stdio: 'pipe' });
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

function readScriptCapture(dbPath: string, path: string): string {
  return execFileSync('sqlite3', [dbPath], {
    input: `PRAGMA foreign_keys=ON;\n.read ${path}\n`,
    encoding: 'utf8',
  });
}

// The numeric rows derive-amendments.sql prints; the #306 diagnostic is the 2-column row
// (annexes_value_linked | eop_annexes_still_unlinked).
function diagRows(out: string): number[][] {
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+(\|\d+)*$/.test(line))
    .map((line) => line.split('|').map(Number));
}

let dir: string;
let db: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'amendments-resolve-'));
  db = resolve(dir, 'work.sqlite');
  readScript(db, initSchema);
  readScript(db, workStagingSchema);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('#306 amendment→contract value-anchor resolver', () => {
  it('links a single-contract procedure whose annex number differs (00017 shape) by exact value', () => {
    // UNP with ONE contract "ОП-3-016/…" signing 5800; annex carries internal number 11725, value_before
    // 5800 (exact). The number join fails; the value anchor links it.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00017-2020-0041','ОП-3-016/03.02.2021г.',5800,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, value_delta, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00017-2020-0041','11725','2026-03-05','A1',5800,5800,0,'BGN');`,
    );
    readScript(db, deriveAmendments);

    // The annex's contract_number is rewritten to the real filing number → it now links.
    expect(
      sqliteJson<{ contract_number: string }>(
        db,
        "SELECT contract_number FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number: 'ОП-3-016/03.02.2021г.' }]);
    // The contract picks up the annex in its rollup.
    expect(
      sqliteJson<{ annex_count: number }>(
        db,
        "SELECT annex_count FROM raw_contracts WHERE contract_number='ОП-3-016/03.02.2021г.'",
      ),
    ).toEqual([{ annex_count: 1 }]);
  });

  it('disambiguates a multi-contract (multi-lot) procedure by value (00011 shape)', () => {
    // Two contracts on one procedure: 387-2020 (signing 64000) and 388-2020 (signing 56000). An unlinked
    // annex carries internal number 2886, value_before 56000 → must link to 388-2020, NEVER 387-2020.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00011-2020-0002','387-2020',64000,'BGN'),
         ('eop:contracts:2026-03-05','2026-03-05','00011-2020-0002','388-2020',56000,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, value_delta, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00011-2020-0002','2886','2026-03-05','A1',56000,55552.5,NULL,'BGN');`,
    );
    readScript(db, deriveAmendments);

    expect(
      sqliteJson<{ contract_number: string }>(
        db,
        "SELECT contract_number FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number: '388-2020' }]);
    expect(
      sqliteJson<{ contract_number: string; annex_count: number }>(
        db,
        "SELECT contract_number, annex_count FROM raw_contracts WHERE unp='00011-2020-0002' ORDER BY contract_number",
      ),
    ).toEqual([
      { contract_number: '387-2020', annex_count: 0 },
      { contract_number: '388-2020', annex_count: 1 },
    ]);
  });

  it('propagates the resolved target across a chain sharing the annex number, so current_value is the last step', () => {
    // Three annexes share internal number 2886; only the FIRST carries value_before = signing (56000), the
    // later two carry the running cumulative. All must attach to 388-2020, and current_value must be the
    // LAST step's value_after (53580.21), not the first.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00011-2020-0002','387-2020',64000,'BGN'),
         ('eop:contracts:2026-03-05','2026-03-05','00011-2020-0002','388-2020',56000,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00011-2020-0002','2886','2026-03-05','A1',56000,55552.5,'BGN'),
         ('eop:annexes:2026-03-05','2026-03-06','00011-2020-0002','2886','2026-03-06','A2',55552.5,55306.05,'BGN'),
         ('eop:annexes:2026-03-05','2026-03-07','00011-2020-0002','2886','2026-03-07','A3',55306.05,53580.21,'BGN');`,
    );
    readScript(db, deriveAmendments);

    // All three annexes now carry the resolved contract_number.
    expect(
      sqliteJson<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM raw_amendments WHERE unp='00011-2020-0002' AND contract_number='388-2020'",
      ),
    ).toEqual([{ n: 3 }]);
    // annex_count = 3, current_value = the latest step's after-value.
    expect(
      sqliteJson<{ annex_count: number; current_value: number }>(
        db,
        "SELECT annex_count, current_value FROM raw_contracts WHERE contract_number='388-2020'",
      ),
    ).toEqual([{ annex_count: 3, current_value: 53580.21 }]);
  });

  it('leaves a value-AMBIGUOUS annex unlinked (two contracts share the signing value)', () => {
    // Both contracts on the procedure have signing 5000; the annex value_before 5000 matches BOTH — the
    // resolver must refuse (an honest gap beats a coin-flip).
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00099-2020-0001','LOT-A',5000,'BGN'),
         ('eop:contracts:2026-03-05','2026-03-05','00099-2020-0001','LOT-B',5000,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00099-2020-0001','7777','2026-03-05','A1',5000,4800,'BGN');`,
    );
    readScript(db, deriveAmendments);

    expect(
      sqliteJson<{ contract_number: string }>(
        db,
        "SELECT contract_number FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number: '7777' }]); // unchanged → stays unlinked
    expect(
      sqliteJson<{ total: number }>(
        db,
        "SELECT COALESCE(SUM(annex_count),0) AS total FROM raw_contracts WHERE unp='00099-2020-0001'",
      ),
    ).toEqual([{ total: 0 }]);
  });

  it('leaves a NO-MATCH annex unlinked (value_before matches no contract on the procedure)', () => {
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00099-2020-0002','30',700000,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00099-2020-0002','24035','2026-03-05','A1',123456,120000,'BGN');`,
    );
    readScript(db, deriveAmendments);

    expect(
      sqliteJson<{ contract_number: string }>(
        db,
        "SELECT contract_number FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number: '24035' }]); // unchanged
  });

  it('applies a currency guard — a BGN-valued annex does not match a same-number EUR contract', () => {
    // signing_value numerically equals value_before but the currencies differ → not a real value match.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00207-2020-0171','FILING-1',66820,'EUR');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00207-2020-0171','9001','2026-03-05','A1',66820,66000,'BGN');`,
    );
    readScript(db, deriveAmendments);

    expect(
      sqliteJson<{ contract_number: string }>(
        db,
        "SELECT contract_number FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number: '9001' }]); // unchanged → currency guard held
  });

  it('never touches an annex that already links by contract_number, and emits the #306 diagnostic', () => {
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00001-2020-0001','Д-100',5000,'BGN'),   -- annex links by value (unlinked number)
         ('eop:contracts:2026-03-05','2026-03-05','00002-2020-0001','Д-200',9000,'BGN');   -- annex already links by number
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00001-2020-0001','55501','2026-03-05','A1',5000,4500,'BGN'),
         ('eop:annexes:2026-03-05','2026-03-05','00002-2020-0001','Д-200','2026-03-05','A2',9000,8000,'BGN');`,
    );
    const out = readScriptCapture(db, deriveAmendments);

    // A1 got resolved; A2 (already linked by number) is untouched.
    expect(
      sqliteJson<{ document_number: string; contract_number: string }>(
        db,
        'SELECT document_number, contract_number FROM raw_amendments ORDER BY document_number',
      ),
    ).toEqual([
      { document_number: 'A1', contract_number: 'Д-100' },
      { document_number: 'A2', contract_number: 'Д-200' },
    ]);
    // Diagnostic: exactly 1 value-linked, 0 still unlinked. The #306 row is the LAST 2-column row —
    // the #286 dropped/excess-over-eop diagnostic is also 2 columns and prints earlier.
    const twoCol = diagRows(out).filter((r) => r.length === 2);
    expect(twoCol[twoCol.length - 1]).toEqual([1, 0]);
  });
});
