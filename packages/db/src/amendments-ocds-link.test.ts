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
  execFileSync('sqlite3', [dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
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

  it('recovers the smallest УНП deterministically when a tender.id maps to more than one', () => {
    // The domain is 1-to-1 (one procedure = one УНП), but the bridge's `ORDER BY unp LIMIT 1` is a
    // determinism guard: if a feed ever staged the same tender_id under two УНП, a re-run must never
    // flip the recovered key. Give T2 a second, lexicographically-larger УНП and assert the 55500
    // annex still bridges to UNP_ONLY ('00099-…' < 'ZZ-…'), not the arbitrary other row.
    sqlite(
      db,
      `INSERT INTO raw_tenders (source, fetched_at, tender_id, unp) VALUES
         ('eop:tenders:2026-03-05', '2026-03-05', 'T2', 'ZZ-9999-9999');`,
    );
    readScript(db, deriveAmendments);

    const bridged = sqliteJson<{ unp: string }>(
      db,
      "SELECT unp FROM raw_amendments WHERE source LIKE 'ocds:%' AND contract_number = '55500'",
    );
    expect(bridged).toEqual([{ unp: UNP_ONLY }]);
  });
});
