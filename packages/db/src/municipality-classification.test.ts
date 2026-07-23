/// <reference types="node" />
// Regression test for issue #19: authority `type_group = 'община'` is decided by ЕИК against the
// canonical 265-municipality registry (scripts/seed-municipalities.sql), not by a name heuristic.
// Cases mirror what the old heuristic got wrong on the real EOP feed:
//   - район administration (13-digit branch ЕИК) — was over-counted, must NOT be 'община'
//   - "Кмет на община X" name variant — was missed, IS the municipality by ЕИК → 'община'
//   - общинско предприятие with "община" in the name but a non-municipal ЕИК — must NOT be 'община'
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const workStagingSchemaPath = resolve(root, 'scripts/work-staging-schema.sql');
const seedMunicipalitiesPath = resolve(root, 'scripts/seed-municipalities.sql');
const normalizePath = resolve(root, 'scripts/normalize-raw.sql');

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

// One raw_contracts row per authority — enough columns for normalize-raw to build the authority and
// derive its type_group. Each row needs a unique unp / document_number / contract_number.
function contractRow(seq: number, eik: string, name: string): string {
  const v = (s: string) => `'${s.replaceAll("'", "''")}'`;
  return `('eop:contracts:2024-05-01', 2024, 'eop', '2024-05-07T00:00:00Z', 0, 'DOC-${seq}',
    '2024-05-01', 'UNP-${seq}', 'TENDER-${seq}', 'open', 'Subject ${seq}', '45000000',
    'Construction', 'works', 2000, 'BGN', 'basis', 'lowest', ${v(name)}, ${v(eik)},
    'public', 'activity', 'notice', NULL, 'CONTRACT-${seq}', '2024-05-02', 1000, 'BGN',
    'Contract ${seq}', 0, '987654${String(seq).padStart(3, '0')}', 'Bidder ${seq}', 'BG', 'small', 0, 3, 1, 0, 0, 30)`;
}

const CASES = [
  { eik: '000696327', name: 'СТОЛИЧНА ОБЩИНА', expect: 'община', why: 'canonical municipality' },
  {
    eik: '000615118',
    name: 'Кмет на община Смолян',
    expect: 'община',
    why: 'name variant, municipal ЕИК',
  },
  {
    eik: '0004715040031',
    name: 'ОБЩИНА ПЛОВДИВ - РАЙОН "ЦЕНТРАЛЕН"',
    expect: 'друго',
    why: 'район branch ЕИК',
  },
  {
    eik: '111111111',
    name: 'ОБЩИНСКО ПРЕДПРИЯТИЕ "ЧИСТОТА"',
    expect: 'друго',
    why: 'municipal enterprise',
  },
  { eik: '222222222', name: 'МБАЛ Тест', expect: 'болница', why: 'other bucket still works' },
];

function seedAuthorities(dbPath: string): void {
  const values = CASES.map((c, i) => contractRow(i + 1, c.eik, c.name)).join(',\n');
  execFileSync('sqlite3', [dbPath], {
    input: `PRAGMA foreign_keys=ON;
INSERT INTO raw_contracts
  (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
   published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
   cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
   award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
   lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
   awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
   eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
VALUES
${values};
`,
    stdio: 'pipe',
  });
}

function typeGroupByEik(dbPath: string): Map<string, string | null> {
  const rows = sqliteJson<{ bulstat: string; type_group: string | null }>(
    dbPath,
    'SELECT bulstat, type_group FROM authorities',
  );
  return new Map(rows.map((r) => [r.bulstat, r.type_group]));
}

describe('issue #19 — ЕИК-based "община" classification', () => {
  it('classifies by canonical municipality ЕИК, not by name', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-muni-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, schemaPath);
      readScript(dbPath, workStagingSchemaPath);
      seedAuthorities(dbPath);
      readScript(dbPath, seedMunicipalitiesPath);
      readScript(dbPath, normalizePath);

      const got = typeGroupByEik(dbPath);
      for (const c of CASES) {
        expect(got.get(c.eik), `${c.name} (${c.why})`).toBe(c.expect);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the seed loads exactly 265 municipalities across 28 regions', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-muni-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, schemaPath);
      readScript(dbPath, seedMunicipalitiesPath);
      const count = sqliteJson<{ n: number }>(dbPath, 'SELECT COUNT(*) n FROM municipality_eik')[0]
        ?.n;
      const regions = sqliteJson<{ r: number }>(
        dbPath,
        'SELECT COUNT(DISTINCT region) r FROM municipality_eik',
      )[0]?.r;
      const malformed = sqliteJson<{ bad: number }>(
        dbPath,
        "SELECT COUNT(*) bad FROM municipality_eik WHERE eik NOT GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'",
      )[0]?.bad;
      expect(count).toBe(265);
      expect(regions).toBe(28);
      expect(malformed).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without the seed, normalize-raw still runs (defensive CREATE) and nothing is "община"', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-muni-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, schemaPath);
      readScript(dbPath, workStagingSchemaPath);
      seedAuthorities(dbPath);
      readScript(dbPath, normalizePath); // seed-municipalities NOT loaded → empty table

      const got = typeGroupByEik(dbPath);
      expect(got.get('000696327')).not.toBe('община'); // empty registry → no match
      expect(got.get('222222222')).toBe('болница'); // name buckets unaffected
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
