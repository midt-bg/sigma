// Issue #306 — EOP annexes whose annex-side number is in a different namespace than the contract number
// (the annex carries an internal number like 148846; the contract carries the buyer's filing number like
// Д-226), so the (unp, contract_number) join drops them out of every annex→contract rollup. The resolver in
// scripts/resolve-amendment-contracts.sql links them by the exact, currency- and contractor-matched
// value_before → signing_value anchor (measured 99.99% precision on the real corpus), uniquely, with chain
// propagation, leaving ambiguous / no-match annexes honestly unlinked.
//
// The resolver is a SEPARATE script that runs BEFORE derive-amendments.sql on the full-derive path only
// (review todorkolev #1 blocker: running after the prefer-EOP dedup resurrects OCDS twins; review
// nikimilenkov HIGH 1: the slice path's windowed raw_contracts can't answer "unique on the procedure").
// These tests run the REAL scripts against SQLite via the sqlite3 CLI, exactly as runFullDerive composes
// them — resolver, then derive — so the value anchor, dedup, group rule, guards, and provenance are
// exercised as shipped.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const initSchema = resolve(root, 'packages/db/migrations/0000_init.sql');
// #305: promote-amendments.sql writes value_restated/value_treatment/value_suspect into served amendments.
const restatedMigration = resolve(root, 'packages/db/migrations/0006_amendment_restated.sql');
const valueSuspectMigration = resolve(
  root,
  'packages/db/migrations/0007_amendment_value_suspect.sql',
);
const provenanceMigration = resolve(root, 'packages/db/migrations/0008_amendment_provenance.sql');
const workStagingSchema = resolve(root, 'scripts/work-staging-schema.sql');
const resolveAmendments = resolve(root, 'scripts/resolve-amendment-contracts.sql');
const deriveAmendments = resolve(root, 'scripts/derive-amendments.sql');
const promoteAmendments = resolve(root, 'scripts/promote-amendments.sql');

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

// The full-derive composition: value resolver first (review todorkolev #1), then the derive rollup.
function runFullDerive(dbPath: string): void {
  readScript(dbPath, resolveAmendments);
  readScript(dbPath, deriveAmendments);
}

// The numeric rows the resolver prints; the #306 diagnostic is its only 2-column row
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
  readScript(db, restatedMigration);
  readScript(db, valueSuspectMigration);
  readScript(db, provenanceMigration);
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
    runFullDerive(db);

    // The annex's contract_number is rewritten to the real filing number → it now links.
    expect(
      sqliteJson<{ contract_number: string; contract_number_raw: string; link_method: string }>(
        db,
        "SELECT contract_number, contract_number_raw, link_method FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([
      {
        contract_number: 'ОП-3-016/03.02.2021г.',
        contract_number_raw: '11725',
        link_method: 'value_anchor',
      },
    ]);
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
    runFullDerive(db);

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
    runFullDerive(db);

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

  it('propagates the target to a VALUE-LESS chain member so the chain does not break (review MEDIUM 2)', () => {
    // A1 carries value_before = signing (unique anchor → 388-2020); A2 is an administrative annex with NO
    // value_before (a term/scope change). A2 shares the annex number 2886, so it must INHERIT 388-2020 —
    // else the chain breaks and annex_count under-counts.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00011-2020-0002','387-2020',64000,'BGN'),
         ('eop:contracts:2026-03-05','2026-03-05','00011-2020-0002','388-2020',56000,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00011-2020-0002','2886','2026-03-05','A1',56000,55552.5,'BGN'),
         ('eop:annexes:2026-03-05','2026-03-06','00011-2020-0002','2886','2026-03-06','A2',NULL,NULL,'BGN');`,
    );
    runFullDerive(db);

    expect(
      sqliteJson<{ document_number: string; contract_number: string; link_method: string | null }>(
        db,
        'SELECT document_number, contract_number, link_method FROM raw_amendments ORDER BY document_number',
      ),
    ).toEqual([
      { document_number: 'A1', contract_number: '388-2020', link_method: 'value_anchor' },
      { document_number: 'A2', contract_number: '388-2020', link_method: 'value_anchor' },
    ]);
    expect(
      sqliteJson<{ annex_count: number }>(
        db,
        "SELECT annex_count FROM raw_contracts WHERE contract_number='388-2020'",
      ),
    ).toEqual([{ annex_count: 2 }]);
  });

  it('does NOT attach an ambiguous chain member to the group target (review todorkolev #2)', () => {
    // Procedure: C-1 @ 500, C-2 @ 500, C-3 @ 1000. Annex 999: A1 value_before 1000 → C-3 (unique anchor);
    // A2 value_before 500 → matches C-1 AND C-2 (ambiguous). A2 must stay unlinked — it carries its own
    // contradicting evidence — and must NOT corrupt C-3's current_value.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00050-2020-0001','C-1',500,'BGN'),
         ('eop:contracts:2026-03-05','2026-03-05','00050-2020-0001','C-2',500,'BGN'),
         ('eop:contracts:2026-03-05','2026-03-05','00050-2020-0001','C-3',1000,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00050-2020-0001','999','2026-03-05','A1',1000,900,'BGN'),
         ('eop:annexes:2026-03-05','2026-03-06','00050-2020-0001','999','2026-03-06','A2',500,450,'BGN');`,
    );
    runFullDerive(db);

    expect(
      sqliteJson<{ document_number: string; contract_number: string }>(
        db,
        'SELECT document_number, contract_number FROM raw_amendments ORDER BY document_number',
      ),
    ).toEqual([
      { document_number: 'A1', contract_number: 'C-3' }, // unique anchor linked
      { document_number: 'A2', contract_number: '999' }, // ambiguous → stays unlinked
    ]);
    // C-3 keeps A1 only; current_value is A1's after-value (900), NOT the ambiguous A2's 450.
    expect(
      sqliteJson<{ annex_count: number; current_value: number }>(
        db,
        "SELECT annex_count, current_value FROM raw_contracts WHERE contract_number='C-3'",
      ),
    ).toEqual([{ annex_count: 1, current_value: 900 }]);
  });

  it('links each annex of a lot-base group to its OWN lot by its own unique match (real 00026 shape)', () => {
    // The annex-side number is a LOT-BASE shared across two lots (real corpus: 20РП-У50А015 → …-Л01 @
    // 22569.98 AND …-Л03 @ 28557.50). Each annex exactly-uniquely matches its OWN lot, so BOTH link — the
    // "disagreement" between siblings is benign and must NOT void the individually-trustworthy direct hits.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00026-2020-0027','20РП-У50А015-Л01',22569.98,'BGN'),
         ('eop:contracts:2026-03-05','2026-03-05','00026-2020-0027','20РП-У50А015-Л03',28557.5,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00026-2020-0027','20РП-У50А015','2026-03-05','A1',22569.98,22000,'BGN'),
         ('eop:annexes:2026-03-05','2026-03-06','00026-2020-0027','20РП-У50А015','2026-03-06','A2',28557.5,28000,'BGN');`,
    );
    runFullDerive(db);

    expect(
      sqliteJson<{ document_number: string; contract_number: string }>(
        db,
        "SELECT document_number, contract_number FROM raw_amendments WHERE unp='00026-2020-0027' ORDER BY document_number",
      ),
    ).toEqual([
      { document_number: 'A1', contract_number: '20РП-У50А015-Л01' },
      { document_number: 'A2', contract_number: '20РП-У50А015-Л03' },
    ]);
    expect(
      sqliteJson<{ contract_number: string; annex_count: number }>(
        db,
        "SELECT contract_number, annex_count FROM raw_contracts WHERE unp='00026-2020-0027' ORDER BY contract_number",
      ),
    ).toEqual([
      { contract_number: '20РП-У50А015-Л01', annex_count: 1 },
      { contract_number: '20РП-У50А015-Л03', annex_count: 1 },
    ]);
  });

  it('withholds PROPAGATION when the group disagrees, but keeps the direct hits (review MEDIUM 1, revised)', () => {
    // Two direct hits disagree (lot-base spread), plus a value-less admin annex A3 sharing the number. The
    // two direct hits still link to their own lots; A3 has no agreed target to inherit → stays unlinked.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00060-2020-0001','D-1',100,'BGN'),
         ('eop:contracts:2026-03-05','2026-03-05','00060-2020-0001','D-2',200,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00060-2020-0001','777','2026-03-05','A1',100,90,'BGN'),
         ('eop:annexes:2026-03-05','2026-03-06','00060-2020-0001','777','2026-03-06','A2',200,180,'BGN'),
         ('eop:annexes:2026-03-05','2026-03-07','00060-2020-0001','777','2026-03-07','A3',NULL,NULL,'BGN');`,
    );
    runFullDerive(db);

    expect(
      sqliteJson<{ document_number: string; contract_number: string }>(
        db,
        "SELECT document_number, contract_number FROM raw_amendments WHERE unp='00060-2020-0001' ORDER BY document_number",
      ),
    ).toEqual([
      { document_number: 'A1', contract_number: 'D-1' }, // own unique match stands
      { document_number: 'A2', contract_number: 'D-2' }, // own unique match stands
      { document_number: 'A3', contract_number: '777' }, // no agreed target → no propagation
    ]);
    expect(
      sqliteJson<{ contract_number: string; annex_count: number }>(
        db,
        "SELECT contract_number, annex_count FROM raw_contracts WHERE unp='00060-2020-0001' ORDER BY contract_number",
      ),
    ).toEqual([
      { contract_number: 'D-1', annex_count: 1 },
      { contract_number: 'D-2', annex_count: 1 },
    ]);
  });

  it('counts cumulative-staging duplicates of one contract as a SINGLE candidate (review HIGH 2)', () => {
    // The same logical contract is staged from TWO daily EOP buckets (raw_contracts is cumulative). Without
    // deduping candidates, the lone annex would see n_match = 2 and be refused; the resolver must collapse
    // the duplicate to one candidate and link.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00070-2020-0001','FILING-7',12345,'BGN'),
         ('eop:contracts:2026-03-06','2026-03-06','00070-2020-0001','FILING-7',12345,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-06','2026-03-06','00070-2020-0001','88001','2026-03-06','A1',12345,12000,'BGN');`,
    );
    runFullDerive(db);

    expect(
      sqliteJson<{ contract_number: string }>(
        db,
        "SELECT contract_number FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number: 'FILING-7' }]);
  });

  it('applies an EIK guard — a value match onto a different contractor is refused (review MEDIUM 5)', () => {
    // Same unp, value, currency, but the annex is contractor 222222222 and the only value-matching contract
    // is contractor 111111111 → the row's own EIK contradicts the target → no link.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency, contractor_eik) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00080-2020-0001','FILING-8',9000,'BGN','111111111');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency, contractor_eik) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00080-2020-0001','44001','2026-03-05','A1',9000,8500,'BGN','222222222');`,
    );
    runFullDerive(db);

    expect(
      sqliteJson<{ contract_number: string }>(
        db,
        "SELECT contract_number FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number: '44001' }]); // unchanged → EIK guard held
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
    runFullDerive(db);

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
    runFullDerive(db);

    expect(
      sqliteJson<{ contract_number: string }>(
        db,
        "SELECT contract_number FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number: '24035' }]); // unchanged
  });

  it('holds the exact-cent tolerance — a value 3 BGN off does NOT match (pins the 0.005 constant)', () => {
    // signing 5000, value_before 5003 → 3.00 apart: far under a naive "within 5" band but far over the
    // 0.5-стотинка exact gate. Must stay unlinked; this is the whole basis of the 99.99% precision claim.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00087-2020-0001','FILING-87',5000,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00087-2020-0001','47001','2026-03-05','A1',5003,4800,'BGN');`,
    );
    runFullDerive(db);

    expect(
      sqliteJson<{ contract_number: string }>(
        db,
        "SELECT contract_number FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number: '47001' }]); // unchanged → 3 BGN is not an exact-cent match
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
    runFullDerive(db);

    expect(
      sqliteJson<{ contract_number: string }>(
        db,
        "SELECT contract_number FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number: '9001' }]); // unchanged → currency guard held
  });

  it('does not match blank-currency against blank-currency (review LOW 1)', () => {
    // Both sides carry no explicit currency. Under so tight a gate the resolver must NOT silently agree via
    // a 'BGN' default — an explicit currency is required on both sides.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00085-2020-0001','FILING-85',7500,'');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00085-2020-0001','45001','2026-03-05','A1',7500,7000,'');`,
    );
    runFullDerive(db);

    expect(
      sqliteJson<{ contract_number: string }>(
        db,
        "SELECT contract_number FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number: '45001' }]); // unchanged → no blank-vs-blank match
  });

  it('does NOT resurrect an OCDS twin: resolver runs before the prefer-EOP dedup (review todorkolev #1 blocker)', () => {
    // Contract Д-226 already has an OCDS annex on it. An EOP annex carries the unlinked internal number
    // 148846 and value_before = signing (5000). Because the resolver runs BEFORE the #286 prefer-EOP DELETE,
    // the EOP annex is moved onto Д-226 first, the OCDS twin is then dropped, and annex_count = 1. If the
    // order were reversed the twin would survive and annex_count would be 2 (the twin-dedup #303 gate would
    // then hard-fail the whole derive).
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00090-2020-0001','Д-226',5000,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('ocds:annexes:2026-03-05','2026-03-05','00090-2020-0001','Д-226','2026-03-05','ocds-e82gsb-1',5000,NULL,'BGN'),
         ('eop:annexes:2026-03-05','2026-03-05','00090-2020-0001','148846','2026-03-05','148846-1',5000,4500,'BGN');`,
    );
    runFullDerive(db);

    // Exactly one annex survives on Д-226 (the EOP one), and it drives current_value.
    expect(
      sqliteJson<{ annex_count: number; current_value: number }>(
        db,
        "SELECT annex_count, current_value FROM raw_contracts WHERE contract_number='Д-226'",
      ),
    ).toEqual([{ annex_count: 1, current_value: 4500 }]);
    // No twin duplication: exactly one row lands on Д-226 for this procedure.
    expect(
      sqliteJson<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM raw_amendments WHERE unp='00090-2020-0001' AND contract_number='Д-226'",
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('is GATED to the resolver script: derive-amendments.sql alone does not resolve (review HIGH 1)', () => {
    // The slice path runs derive-amendments.sql WITHOUT the resolver. Running derive alone must leave a
    // resolvable annex untouched — proving the link is gated to the full-derive-only resolver script.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00095-2020-0001','FILING-95',5800,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00095-2020-0001','11725','2026-03-05','A1',5800,5600,'BGN');`,
    );
    readScript(db, deriveAmendments); // derive ONLY — no resolver

    expect(
      sqliteJson<{ contract_number: string; link_method: string | null }>(
        db,
        "SELECT contract_number, link_method FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number: '11725', link_method: null }]); // untouched
  });

  it('is idempotent: a second full derive links nothing new and keeps annex_count stable', () => {
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00096-2020-0001','FILING-96',5800,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00096-2020-0001','11725','2026-03-05','A1',5800,5600,'BGN');`,
    );
    runFullDerive(db);
    const secondPass = readScriptCapture(db, resolveAmendments);
    readScript(db, deriveAmendments);

    // Second pass over already-resolved staging: the row now links by number so grp is empty and no new
    // rewrite happens. The diagnostic still reports the one value-linked row (link_method persists) and 0
    // still unlinked — i.e. nothing new linked, nothing left over.
    const twoCol = diagRows(secondPass).filter((r) => r.length === 2);
    expect(twoCol[twoCol.length - 1]).toEqual([1, 0]);
    // contract_number stays resolved; annex_count stable at 1; provenance preserved.
    expect(
      sqliteJson<{ annex_count: number }>(
        db,
        "SELECT annex_count FROM raw_contracts WHERE contract_number='FILING-96'",
      ),
    ).toEqual([{ annex_count: 1 }]);
    expect(
      sqliteJson<{ contract_number_raw: string; link_method: string }>(
        db,
        "SELECT contract_number_raw, link_method FROM raw_amendments WHERE document_number='A1'",
      ),
    ).toEqual([{ contract_number_raw: '11725', link_method: 'value_anchor' }]);
  });

  it('carries provenance through promote into the served amendments table (review MEDIUM 4)', () => {
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00097-2020-0001','FILING-97',5800,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00097-2020-0001','11725','2026-03-05','A1',5800,5600,'BGN');`,
    );
    runFullDerive(db);
    readScript(db, promoteAmendments);

    // The served row is enumerable as value-linked, and the original annex number survives as provenance.
    expect(
      sqliteJson<{ contract_number: string; contract_number_raw: string; link_method: string }>(
        db,
        "SELECT contract_number, contract_number_raw, link_method FROM amendments WHERE unp='00097-2020-0001'",
      ),
    ).toEqual([
      { contract_number: 'FILING-97', contract_number_raw: '11725', link_method: 'value_anchor' },
    ]);
    // The audit count nikimilenkov asked for is a plain query on the served side.
    expect(
      sqliteJson<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM amendments WHERE link_method='value_anchor'",
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('a resolved annex does not collide with a native annex sharing document_number on the target (review MEDIUM 3)', () => {
    // Contract FILING-98 already has a native annex whose document_number is 'DOC-1'. An unlinked annex 55501
    // resolves to FILING-98 and ALSO has document_number 'DOC-1'. Keying the resolved row on its original
    // annex number keeps both rows distinct — the real annex is not silently dropped by the dedup.
    sqlite(
      db,
      `INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency) VALUES
         ('eop:contracts:2026-03-05','2026-03-05','00098-2020-0001','FILING-98',5000,'BGN');
       INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('eop:annexes:2026-03-05','2026-03-05','00098-2020-0001','FILING-98','2026-03-04','DOC-1',6000,5500,'BGN'),
         ('eop:annexes:2026-03-05','2026-03-05','00098-2020-0001','55501','2026-03-05','DOC-1',5000,4500,'BGN');`,
    );
    runFullDerive(db);

    // Both annexes survive on FILING-98 (the native one and the value-linked one).
    expect(
      sqliteJson<{ annex_count: number }>(
        db,
        "SELECT annex_count FROM raw_contracts WHERE contract_number='FILING-98'",
      ),
    ).toEqual([{ annex_count: 2 }]);
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
    const out = readScriptCapture(db, resolveAmendments);
    readScript(db, deriveAmendments);

    // A1 got resolved; A2 (already linked by number) is untouched and keeps NULL provenance.
    expect(
      sqliteJson<{ document_number: string; contract_number: string; link_method: string | null }>(
        db,
        'SELECT document_number, contract_number, link_method FROM raw_amendments ORDER BY document_number',
      ),
    ).toEqual([
      { document_number: 'A1', contract_number: 'Д-100', link_method: 'value_anchor' },
      { document_number: 'A2', contract_number: 'Д-200', link_method: null },
    ]);
    // Diagnostic: exactly 1 value-linked, 0 still unlinked. The resolver's only 2-column row.
    const twoCol = diagRows(out).filter((r) => r.length === 2);
    expect(twoCol[twoCol.length - 1]).toEqual([1, 0]);
  });
});
