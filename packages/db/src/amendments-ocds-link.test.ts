// Issue #286 — OCDS amendments must link to their contract via the recovered УНП, without
// double-counting the EOP annexes or letting an OCDS "before" value understate current_value.
//
// Runs the REAL scripts (derive-amendments.sql → promote-amendments.sql) against SQLite via the
// sqlite3 CLI, exactly as the ETL does, so the bridge + prefer-EOP dedup + value semantics are
// exercised as shipped — not a hand-copied mirror.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const initSchema = resolve(root, 'packages/db/migrations/0000_init.sql');
// #305 Tier-2: promote-amendments.sql writes value_restated/value_treatment to served amendments.
const migration6 = resolve(root, 'packages/db/migrations/0006_amendment_restated.sql');
const migration7 = resolve(root, 'packages/db/migrations/0007_amendment_value_suspect.sql');
const workStagingSchema = resolve(root, 'scripts/work-staging-schema.sql');
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
  // Enforce FK constraints (mirrors refresh-slice.test.ts) so the promotion is validated against the
  // served schema, not run with FK checks silently off.
  execFileSync('sqlite3', [dbPath], {
    input: `PRAGMA foreign_keys=ON;\n.read ${path}\n`,
    stdio: 'pipe',
  });
}

// Captures sqlite3 stdout (the SELECT results a `.read` prints) so a test can assert the diagnostic
// numbers the ETL emits, not just the table state.
function readScriptCapture(dbPath: string, path: string): string {
  return execFileSync('sqlite3', [dbPath], {
    input: `PRAGMA foreign_keys=ON;\n.read ${path}\n`,
    encoding: 'utf8',
  });
}

// The numeric rows derive-amendments.sql prints (its diagnostics + the final summary), split into integer
// arrays and identified by column count: 1 col = ocds_ambiguous_bridges, 2 = dropped/excess-over-eop,
// 4 = the run summary. sqlite3's default output separates columns by '|' and rows by newlines.
function diagRows(out: string): number[][] {
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+(\|\d+)*$/.test(line))
    .map((line) => line.split('|').map(Number));
}

// EOP УНП for the twin contract (90029), the OCDS-only contract (55500), and the OCDS-only contract
// whose procedure is contract-only — a "synthetic tender" absent from raw_tenders (77700).
const UNP_TWIN = '00044-2022-0146';
const UNP_ONLY = '00099-2022-0009';
const UNP_SYNTH = '00077-2022-0007';
// A fourth OCDS annex whose procedure bridges NOWHERE — its tender.id is in neither raw_tenders nor
// raw_contracts. On the live corpus ~3/4,800 OCDS amendments are like this (#286 links 4,797/4,800);
// they honestly keep the OCID in `unp` because they can't be keyed to a contract yet — NOT dropped.
const OCID_UNBRIDGED = 'ocds-e82gsb-666666';

let dir: string;
let db: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'amendments-ocds-'));
  db = resolve(dir, 'work.sqlite');
  readScript(db, initSchema); // served `amendments` + `contracts`
  readScript(db, migration6); // #305 Tier-2 value_restated/value_treatment on served amendments
  readScript(db, migration7); // #305 residual value_suspect on served amendments
  readScript(db, workStagingSchema); // raw_* staging

  // Two EOP procedures: T1 (contract 90029) already has an EOP annex; T2 (contract 55500) has NONE.
  sqlite(
    db,
    `INSERT INTO raw_tenders (source, fetched_at, tender_id, unp) VALUES
       ('eop:tenders:2026-03-05', '2026-03-05', 'T1', '${UNP_TWIN}'),
       ('eop:tenders:2026-03-05', '2026-03-05', 'T2', '${UNP_ONLY}');
     INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency, tender_ext_id) VALUES
       ('eop:contracts:2026-03-05', '2026-03-05', '${UNP_TWIN}', '90029', 21602081.98, 'EUR', 'T1'),
       ('eop:contracts:2026-03-05', '2026-03-05', '${UNP_ONLY}', '55500', 500000, 'EUR', 'T2'),
       -- 77700's procedure is contract-only: it has NO raw_tenders row, so the bridge must fall back
       -- to raw_contracts.tender_ext_id (T3) to recover the УНП.
       ('eop:contracts:2026-03-05', '2026-03-05', '${UNP_SYNTH}', '77700', 300000, 'EUR', 'T3');
     -- EOP annex for 90029 carries the correct after-value (27.4M).
     INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
       ('eop:annexes:2026-03-05', '2026-03-05', '${UNP_TWIN}', '90029', '2026-03-05', 'E1', 21602081.98, 27435415.31, 'EUR');
     -- OCDS twin of the 90029 annex: unp is the OCID, value is the pre-amendment number stored as value_before.
     INSERT INTO raw_amendments (source, fetched_at, unp, tender_ext_id, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
       ('ocds:2026-03-05', '2026-03-05', 'ocds-e82gsb-245534', 'T1', '90029', '2026-03-05', 'O1', 21602081.98, NULL, 'EUR');
     -- OCDS-only annex for 55500: exists in NO EOP feed. This is the row #286 wants to make visible.
     INSERT INTO raw_amendments (source, fetched_at, unp, tender_ext_id, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
       ('ocds:2026-04-01', '2026-04-01', 'ocds-e82gsb-999999', 'T2', '55500', '2026-04-01', 'O2', 480000, NULL, 'EUR');
     -- OCDS-only annex for 77700 (contract-only procedure) — bridges via the raw_contracts fallback.
     INSERT INTO raw_amendments (source, fetched_at, unp, tender_ext_id, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
       ('ocds:2026-04-01', '2026-04-01', 'ocds-e82gsb-777777', 'T3', '77700', '2026-04-01', 'O3', 300000, NULL, 'EUR');
     -- OCDS annex whose tender.id (T_MISSING) is in NEITHER raw_tenders nor raw_contracts — unbridgeable.
     INSERT INTO raw_amendments (source, fetched_at, unp, tender_ext_id, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
       ('ocds:2026-04-01', '2026-04-01', '${OCID_UNBRIDGED}', 'T_MISSING', '66600', '2026-04-01', 'O4', 300000, NULL, 'EUR');`,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('OCDS amendment → contract linkage (issue #286)', () => {
  it('bridges the УНП, drops EOP twins, and never understates current_value', () => {
    readScript(db, deriveAmendments);

    // Bridge: every *bridgeable* OCDS amendment now carries the real УНП. The one unbridgeable procedure
    // (tender.id in neither raw_tenders nor raw_contracts) honestly keeps its OCID — it is NOT dropped.
    const stillOcid = sqliteJson<{ contract_number: string; unp: string }>(
      db,
      "SELECT contract_number, unp FROM raw_amendments WHERE source LIKE 'ocds:%' AND unp LIKE 'ocds-%'",
    );
    expect(stillOcid).toEqual([{ contract_number: '66600', unp: OCID_UNBRIDGED }]);

    // Prefer-EOP dedup: the 90029 OCDS twin is gone; the OCDS-only rows survive with their УНП —
    // 55500 bridged via raw_tenders, 77700 via the raw_contracts synthetic-tender fallback, and 66600
    // stays on its OCID (unbridgeable, but surfaced rather than silently deleted).
    const ocds = sqliteJson<{ contract_number: string; unp: string }>(
      db,
      "SELECT contract_number, unp FROM raw_amendments WHERE source LIKE 'ocds:%' ORDER BY contract_number",
    );
    expect(ocds).toEqual([
      { contract_number: '55500', unp: UNP_ONLY },
      { contract_number: '66600', unp: OCID_UNBRIDGED },
      { contract_number: '77700', unp: UNP_SYNTH },
    ]);

    // The value trap: 90029 rolls up the EOP after-value (27.4M), never the stale OCDS 21.6M.
    const twin = sqliteJson<{ annex_count: number; current_value: number | null }>(
      db,
      "SELECT annex_count, current_value FROM raw_contracts WHERE contract_number = '90029'",
    );
    expect(twin[0]?.annex_count).toBe(1);
    expect(twin[0]?.current_value).toBe(27435415.31);

    // OCDS-only annex is now visible on its contract (annex_count = 1); current_value stays NULL because
    // OCDS cannot know the after-value (honest — no fabricated figure).
    const only = sqliteJson<{ annex_count: number; current_value: number | null }>(
      db,
      "SELECT annex_count, current_value FROM raw_contracts WHERE contract_number = '55500'",
    );
    expect(only[0]?.annex_count).toBe(1);
    expect(only[0]?.current_value).toBeNull();
  });

  it('promotes served amendments, keeping only the unbridgeable OCID as the honest residual', () => {
    readScript(db, deriveAmendments);
    readScript(db, promoteAmendments);

    // The issue's mass symptom is gone (4,800 → the handful with no bridge). The one procedure that
    // bridges nowhere is promoted with its OCID still in unp — surfaced honestly, not silently dropped
    // and not fabricated onto a contract. promote-amendments.sql intentionally promotes every staged row.
    const dead = sqliteJson<{ contract_number: string; unp: string }>(
      db,
      "SELECT contract_number, unp FROM amendments WHERE unp LIKE 'ocds-%'",
    );
    expect(dead).toEqual([{ contract_number: '66600', unp: OCID_UNBRIDGED }]);

    // The served rows: one EOP annex (90029), two bridged OCDS-only annexes (55500, 77700) keyed by real
    // УНП, and the unbridgeable OCDS residual (66600) still on its OCID.
    const served = sqliteJson<{ contract_number: string; unp: string; source: string }>(
      db,
      "SELECT contract_number, unp, CASE WHEN source LIKE 'ocds:%' THEN 'ocds' ELSE 'eop' END AS source FROM amendments ORDER BY contract_number",
    );
    expect(served).toEqual([
      { contract_number: '55500', unp: UNP_ONLY, source: 'ocds' },
      { contract_number: '66600', unp: OCID_UNBRIDGED, source: 'ocds' },
      { contract_number: '77700', unp: UNP_SYNTH, source: 'ocds' },
      { contract_number: '90029', unp: UNP_TWIN, source: 'eop' },
    ]);
  });

  it('refuses to bridge (keeps the OCID) when a tender.id resolves to more than one УНП', () => {
    // The domain is 1-to-1 (one procedure = one УНП). Give T2 a SECOND distinct УНП in raw_tenders. Rather
    // than pick one arbitrarily (which would mis-attribute every annex of the losing procedure), the bridge
    // must REFUSE: 55500's annex keeps its OCID as an honest residual, and the ocds_ambiguous_bridges
    // diagnostic reports exactly one refusal (review nikimilenkov LOW 1).
    sqlite(
      db,
      `INSERT INTO raw_tenders (source, fetched_at, tender_id, unp) VALUES
         ('eop:tenders:2026-03-05', '2026-03-05', 'T2', 'ZZ-9999-9999');`,
    );
    const out = readScriptCapture(db, deriveAmendments);

    const row = sqliteJson<{ unp: string }>(
      db,
      "SELECT unp FROM raw_amendments WHERE source LIKE 'ocds:%' AND contract_number = '55500'",
    );
    expect(row).toEqual([{ unp: 'ocds-e82gsb-999999' }]);

    // The single-column diagnostic row reports the one ambiguous refusal.
    expect(diagRows(out).find((r) => r.length === 1)).toEqual([1]);
  });

  it('recovers the УНП from raw_tenders in preference to raw_contracts (COALESCE order)', () => {
    // One tender_ext_id (TP) resolves to DIFFERENT УНП in the two tables. The bridge tries raw_tenders
    // first, so it must recover UNP-FROM-TENDERS — swapping the two COALESCE arms would fail this (#286).
    sqlite(
      db,
      `INSERT INTO raw_tenders (source, fetched_at, tender_id, unp) VALUES
         ('eop:tenders:2026-03-05', '2026-03-05', 'TP', 'UNP-FROM-TENDERS');
       INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, signing_value, currency, tender_ext_id) VALUES
         ('eop:contracts:2026-03-05', '2026-03-05', 'UNP-FROM-CONTRACTS', 'PREC-1', 100, 'EUR', 'TP');
       INSERT INTO raw_amendments (source, fetched_at, unp, tender_ext_id, contract_number, published_at, document_number, value_before, value_after, currency) VALUES
         ('ocds:2026-04-01', '2026-04-01', 'ocds-e82gsb-tp', 'TP', 'PREC-1', '2026-04-01', 'OP', 100, NULL, 'EUR');`,
    );
    readScript(db, deriveAmendments);

    expect(
      sqliteJson<{ unp: string }>(
        db,
        "SELECT unp FROM raw_amendments WHERE contract_number = 'PREC-1'",
      ),
    ).toEqual([{ unp: 'UNP-FROM-TENDERS' }]);
  });

  it('emits the residual diagnostics (dropped / excess-over-eop / ambiguous) for monitoring', () => {
    // The base fixture has exactly one twin (90029: one OCDS annex vs one EOP annex) → dropped = 1,
    // excess-over-eop = 0; and no ambiguous procedures → 0. These are the numbers the PR promises are
    // "surfaced, not hidden" — pin them so a wrong CASE branch, or moving a diagnostic SELECT below the
    // DELETE (which would zero the dropped/excess counts), fails CI (review nikimilenkov MEDIUM 4).
    const out = readScriptCapture(db, deriveAmendments);
    const rows = diagRows(out);
    expect(rows.find((r) => r.length === 2)).toEqual([1, 0]); // dropped, excess-over-eop
    expect(rows.find((r) => r.length === 1)).toEqual([0]); // ocds_ambiguous_bridges
  });
});
