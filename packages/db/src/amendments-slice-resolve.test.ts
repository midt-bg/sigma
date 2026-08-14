// Issue #306 (PR #308 review todorkolev "дневните обновявания") — the value-anchor resolver must also run on
// the daily/slice + Worker path, not only the full derive. `scripts/refresh-slice.sql` carries a corpus-safe
// resolver whose candidate contracts come from the served `contracts` table (the whole corpus) UNIONed with
// the current window's raw_contracts, so "unique on the procedure" is asked corpus-wide — closing the gap that
// kept the full-path resolver off the slice (windowed raw_contracts could only answer "unique in the window").
//
// These tests run the REAL refresh-slice.sql against SQLite via the sqlite3 CLI, exactly as the CLI slice path
// and the Worker compose it: a first window promotes a served corpus, then a later window brings a
// namespace-mismatched annex (its annex-side number is in a different namespace than the contract's filing
// number). The annex links by the exact value_before → signing_value anchor, keeps its provenance, and rolls
// onto the prior-window target — while a corpus-ambiguous annex that would look unique in the window stays
// honestly unlinked.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrations = [
  'packages/db/migrations/0000_init.sql',
  'packages/db/migrations/0001_flow_pairs_bidder_index.sql',
  'packages/db/migrations/0002_current_value_currency.sql',
  'packages/db/migrations/0003_related_persons_foundation.sql',
  // #305: refresh-slice.sql writes value_restated/value_treatment/value_suspect into served amendments.
  'packages/db/migrations/0006_amendment_restated.sql',
  'packages/db/migrations/0007_amendment_value_suspect.sql',
  'packages/db/migrations/0008_amendment_provenance.sql',
].map((p) => resolve(root, p));
const workStagingSchema = resolve(root, 'scripts/work-staging-schema.sql');
const refreshSlice = resolve(root, 'scripts/refresh-slice.sql');

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', [dbPath], {
    input: `PRAGMA foreign_keys=ON;\n.read ${path}\n`,
    stdio: 'pipe',
  });
}

function sqlite(dbPath: string, sql: string): void {
  execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8', stdio: 'pipe' });
}

function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}

// Fresh transient staging for a new window, exactly as import.mjs / the Worker do between refreshes.
function resetStaging(dbPath: string): void {
  const rows = sqliteJson<{ name: string }>(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'raw_%' ORDER BY name DESC",
  );
  for (const row of rows) sqlite(dbPath, `DROP TABLE IF EXISTS "${row.name}";`);
  readScript(dbPath, workStagingSchema);
}

// One EOP procedure header (a tender) so contract promotion has an authority + tender to attach to.
function seedTender(dbPath: string, unp: string, authorityEik: string): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_tenders
      (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
       cpv_code, cpv_description, contract_kind, estimated_value, currency, authority_name,
       authority_eik, authority_type, published_at)
     VALUES
      ('eop:tenders:2026-06-01', 2026, '2026-06-07T00:00:00Z', '${unp}', 'T-${unp}', 'open',
       'Subject ${unp}', '45000000', 'Construction', 'works', 5000, 'BGN', 'Authority ${unp}',
       '${authorityEik}', 'public', '2026-06-01');`,
  );
}

// An EOP base contract. `cnum` is the contract's filing number; `signing` its signing value.
function seedContract(
  dbPath: string,
  opts: { unp: string; cnum: string; signing: number; authorityEik: string; contractorEik: string },
): void {
  const { unp, cnum, signing, authorityEik, contractorEik } = opts;
  sqlite(
    dbPath,
    `INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
       published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
       cpv_description, contract_kind, estimated_value, procurement_currency, authority_name,
       authority_eik, authority_type, contract_number, contract_date, signing_value, currency,
       contract_subject, awarded_to_group, contractor_eik, contractor_name)
     VALUES
      ('eop:contracts:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', 0, 'DOC-${cnum}',
       '2026-06-01', '${unp}', 'T-${unp}', 'open', 'Subject ${unp}', '45000000', 'Construction',
       'works', 5000, 'BGN', 'Authority ${unp}', '${authorityEik}', 'public', '${cnum}',
       '2026-06-02', ${signing}, 'BGN', 'Contract ${cnum}', 0, '${contractorEik}', 'Bidder ${unp}');`,
  );
}

// A namespace-mismatched EOP annex: `annexCnum` is the annex-side internal number (matches no contract by
// number); it must link to a contract by the value_before anchor instead.
function seedAnnex(
  dbPath: string,
  opts: {
    unp: string;
    annexCnum: string;
    valueBefore: number;
    valueAfter: number;
    authorityEik: string;
    contractorEik: string;
  },
): void {
  const { unp, annexCnum, valueBefore, valueAfter, authorityEik, contractorEik } = opts;
  sqlite(
    dbPath,
    `INSERT INTO raw_amendments
      (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number, contract_number,
       contract_date, published_at, unp, authority_eik, authority_name, procurement_subject,
       contract_kind, value_before, value_after, value_delta, currency, contractor_eik, description)
     VALUES
      ('eop:annexes:2026-06-08', 2026, 'eop', '2026-06-08T00:00:00Z', '1', 'AMD-${annexCnum}',
       '${annexCnum}', '2026-06-02', '2026-06-09', '${unp}', '${authorityEik}', 'Authority ${unp}',
       'Subject ${unp}', 'works', ${valueBefore}, ${valueAfter}, ${valueAfter - valueBefore}, 'BGN',
       '${contractorEik}', 'Namespace-mismatched annex');`,
  );
}

let dir: string;
let db: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'amendments-slice-resolve-'));
  db = resolve(dir, 'work.sqlite');
  for (const m of migrations) readScript(db, m);
  readScript(db, workStagingSchema);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface AmendmentRow {
  contract_number: string;
  contract_number_raw: string | null;
  link_method: string | null;
}
interface ContractRow {
  contract_number: string;
  annex_count: number;
  current_value: number | null;
}

describe('refresh-slice #306 value-anchor resolver', () => {
  it('links a window annex to a prior-window served contract by the corpus value anchor', () => {
    // Window 1: the base contract, filing number Д-226, is served on its own.
    seedTender(db, 'UNP-NS', '123456786');
    seedContract(db, {
      unp: 'UNP-NS',
      cnum: 'Д-226',
      signing: 1000,
      authorityEik: '123456786',
      contractorEik: '987654308',
    });
    readScript(db, refreshSlice);

    // Window 2: only the annex arrives, carrying the internal number 148846 — matches no contract by number,
    // but its value_before (1000) is the served contract's signing_value.
    resetStaging(db);
    seedAnnex(db, {
      unp: 'UNP-NS',
      annexCnum: '148846',
      valueBefore: 1000,
      valueAfter: 1200,
      authorityEik: '123456786',
      contractorEik: '987654308',
    });
    readScript(db, refreshSlice);

    const amendments = sqliteJson<AmendmentRow>(
      db,
      "SELECT contract_number, contract_number_raw, link_method FROM amendments WHERE unp='UNP-NS'",
    );
    // Rewritten onto the target contract's filing number, with the annex-side number kept as provenance.
    expect(amendments).toEqual([
      { contract_number: 'Д-226', contract_number_raw: '148846', link_method: 'value_anchor' },
    ]);

    // The prior-window target was touched and re-rolled: the annex now counts and drives current_value.
    const contract = sqliteJson<ContractRow>(
      db,
      "SELECT contract_number, annex_count, current_value FROM contracts WHERE tender_id='t:UNP-NS'",
    );
    expect(contract).toEqual([{ contract_number: 'Д-226', annex_count: 1, current_value: 1200 }]);
  });

  it('leaves a corpus-ambiguous annex unlinked even when it is unique within the window', () => {
    // Window 1: two served contracts on the SAME procedure, both signing_value 1000 — the annex value cannot
    // pick between them across the corpus.
    seedTender(db, 'UNP-AMB', '123456786');
    seedContract(db, {
      unp: 'UNP-AMB',
      cnum: 'Д-1',
      signing: 1000,
      authorityEik: '123456786',
      contractorEik: '987654308',
    });
    seedContract(db, {
      unp: 'UNP-AMB',
      cnum: 'Д-2',
      signing: 1000,
      authorityEik: '123456786',
      contractorEik: '987654308',
    });
    readScript(db, refreshSlice);

    // Window 2: a THIRD matching contract Д-3 (1000) plus the mismatched annex. A windowed-only resolver would
    // see just Д-3 and mislink (n_match = 1); the corpus-aware resolver sees Д-1/Д-2/Д-3 and refuses.
    resetStaging(db);
    seedContract(db, {
      unp: 'UNP-AMB',
      cnum: 'Д-3',
      signing: 1000,
      authorityEik: '123456786',
      contractorEik: '987654308',
    });
    seedAnnex(db, {
      unp: 'UNP-AMB',
      annexCnum: '148846',
      valueBefore: 1000,
      valueAfter: 1200,
      authorityEik: '123456786',
      contractorEik: '987654308',
    });
    readScript(db, refreshSlice);

    // Unlinked: the annex keeps its raw annex-side number and no link_method.
    const amendments = sqliteJson<AmendmentRow>(
      db,
      "SELECT contract_number, contract_number_raw, link_method FROM amendments WHERE unp='UNP-AMB'",
    );
    expect(amendments).toEqual([
      { contract_number: '148846', contract_number_raw: null, link_method: null },
    ]);

    // None of the three candidate contracts absorbed the annex.
    const amended = sqliteJson<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM contracts WHERE tender_id='t:UNP-AMB' AND annex_count > 0",
    );
    expect(amended).toEqual([{ n: 0 }]);
  });

  it('keeps an annex on its zero-value contract it matches BY NUMBER (never value-links to a neighbour)', () => {
    // The full path excludes an annex whose (unp, contract_number) is a real contract, regardless of that
    // contract's value. The slice path must agree: Д-1 has signing_value 0, Д-2 has 5000; the annex is numbered
    // Д-1 with value_before 5000. It matches Д-1 by number, so it must stay on Д-1 — NOT get value-linked to Д-2
    // just because Д-1 fails the signing_value > 0 candidate filter (review todorkolev: the paths must agree).
    seedTender(db, 'UNP-ZERO', '123456786');
    seedContract(db, {
      unp: 'UNP-ZERO',
      cnum: 'Д-2',
      signing: 5000,
      authorityEik: '123456786',
      contractorEik: '987654308',
    });
    readScript(db, refreshSlice);

    // Window 2: the zero-value contract Д-1 arrives with the annex that carries its number.
    resetStaging(db);
    seedContract(db, {
      unp: 'UNP-ZERO',
      cnum: 'Д-1',
      signing: 0,
      authorityEik: '123456786',
      contractorEik: '987654308',
    });
    seedAnnex(db, {
      unp: 'UNP-ZERO',
      annexCnum: 'Д-1',
      valueBefore: 5000,
      valueAfter: 9000,
      authorityEik: '123456786',
      contractorEik: '987654308',
    });
    readScript(db, refreshSlice);

    // The annex stays on Д-1 by number — not rewritten to the value-neighbour Д-2.
    const amendments = sqliteJson<AmendmentRow>(
      db,
      "SELECT contract_number, contract_number_raw, link_method FROM amendments WHERE unp='UNP-ZERO'",
    );
    expect(amendments).toEqual([
      { contract_number: 'Д-1', contract_number_raw: null, link_method: null },
    ]);

    // Д-1 absorbs the annex; the value-neighbour Д-2 is untouched.
    const perContract = sqliteJson<{ contract_number: string; annex_count: number }>(
      db,
      "SELECT contract_number, annex_count FROM contracts WHERE tender_id='t:UNP-ZERO' ORDER BY contract_number",
    );
    expect(perContract).toEqual([
      { contract_number: 'Д-1', annex_count: 1 },
      { contract_number: 'Д-2', annex_count: 0 },
    ]);
  });
});
