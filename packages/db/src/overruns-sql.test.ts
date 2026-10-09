/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { cpvDivision } from '@sigma/config';
import { SECTOR_KEY_SQL } from './queries/overruns';

// Integration test for the by-sector grouping key. The query layer's unit tests (queries/
// overruns.test.ts) use a fake D1 and so never evaluate SECTOR_KEY_SQL; this runs the REAL
// expression in a real SQLite (the sqlite3-CLI harness of migrations.test.ts / competition-sql.
// test.ts) and pins its contract against cpvDivision, the JS normalization both surfaces use:
//   1. equivalence — cpvDivision(SECTOR_KEY_SQL(code)) === cpvDivision(code) for every dirt
//      pattern the JS function is itself tested on (config's cpvDivision suite), so the SQL
//      grouping can never file a contract in a different division than the leaderboard;
//   2. boundedness — every cleanable code collapses to its bare two-digit division IN SQL, so the
//      result set stays division-sized (≤ ~100 rows) instead of one row per distinct 8-digit code.

function sqlite(sql: string): string {
  return execFileSync('sqlite3', [':memory:'], { input: sql, encoding: 'utf8' }).trim();
}

// The cpvDivision dirt corpus (see packages/config/src/index.test.ts) plus the fallback shapes:
// codes SECTOR_KEY_SQL cannot clean (stray letter) and the degenerate <2-digit/empty/NULL cases.
const SAMPLES: (string | null)[] = [
  '45233120-6', // clean full code with check digit
  '45', // bare division
  '15800000', // clean full code
  '4-5233110', // stray separator inside the prefix
  ' 45', // leading whitespace
  ' 45000000', // the leaderboard-vs-sector divergence case the fix pins
  '\t45000000', // leading tab
  '45.23', // dot separator
  '45/50', // slash separator
  'x45000000', // uncleanable → full-code fallback, folded by the JS re-key
  '4', // fewer than two digits
  '', // empty
  null, // NULL cpv_code
];

function sqlLiteral(v: string | null): string {
  return v === null ? 'NULL' : `'${v.replace(/'/g, "''").replace('\t', "' || char(9) || '")}'`;
}

describe('SECTOR_KEY_SQL (by-sector GROUP BY key)', () => {
  const values = SAMPLES.map((s) => `(${sqlLiteral(s)})`).join(', ');
  const out = sqlite(
    `CREATE TABLE t (cpv_code TEXT);
     INSERT INTO t (cpv_code) VALUES ${values};
     SELECT COALESCE(${SECTOR_KEY_SQL}, '<NULL>') FROM t;`,
  ).split('\n');

  it('agrees with cpvDivision on every dirt pattern (no cross-surface divergence)', () => {
    expect(out).toHaveLength(SAMPLES.length);
    for (const [i, code] of SAMPLES.entries()) {
      const key = out[i] === '<NULL>' ? null : out[i]!;
      expect(cpvDivision(key), `code ${JSON.stringify(code)}`).toBe(cpvDivision(code));
    }
  });

  it('collapses every cleanable code to its bare division in SQL (division-sized result set)', () => {
    for (const [i, code] of SAMPLES.entries()) {
      if (code === null) continue;
      const digits = code.replace(/[\s\-./]/g, '');
      if (/^\d\d/.test(digits)) {
        expect(out[i], `code ${JSON.stringify(code)}`).toBe(cpvDivision(code));
      }
    }
    // The one uncleanable sample stays a full-code fallback for the JS re-key — not silently
    // mis-truncated into a fake one-digit “division”.
    expect(out[SAMPLES.indexOf('x45000000')]).toBe('x45000000');
  });
});
