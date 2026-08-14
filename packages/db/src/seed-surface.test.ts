/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPANY_SQL, LEADERBOARD_SQL, OFFICIAL_SQL } from './queries/related-persons';

// The dev seed exists for ONE reason: `/conflicts` renders an empty surface without it, so the whole
// feature is unverifiable in a browser. That makes the seed a promise about the read gate, and a promise
// nothing checked — it was written against SURFACED_OWNERSHIP as it stood, then #279 added the evidence
// seal requirement to that same predicate and the fixture silently stopped surfacing. A fresh dev DB
// rendered empty, which is exactly the state the seed was created to prevent.
//
// So: run the REAL migrations, the REAL seed.sql, and the REAL exported queries. Any future change to
// the publishing gate that the seed does not keep up with now fails here rather than in someone's
// browser, days later, as „the local app looks broken".

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrations = [
  'packages/db/migrations/0000_init.sql',
  'packages/db/migrations/0003_related_persons_foundation.sql',
  'packages/db/migrations/0009_interest_link_evidence.sql',
].map((m) => resolve(root, m));
const seed = resolve(root, 'scripts/seed.sql');

function seededDb<T>(fn: (dbPath: string) => T): T {
  const dir = mkdtempSync(resolve(tmpdir(), 'sigma-seed-'));
  const dbPath = resolve(dir, 'seed.sqlite');
  try {
    for (const file of [...migrations, seed])
      execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${file}\n`, stdio: 'pipe' });
    return fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function rows(dbPath: string, sql: string): Record<string, string | number | null>[] {
  const out = execFileSync('sqlite3', ['-json', dbPath], { input: sql, encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}
function lit(sql: string, ...vals: (string | number)[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = vals[i++];
    return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  });
}

describe('scripts/seed.sql produces a surface a developer can actually see', () => {
  it('the leaderboard is NOT empty — the seed survives every gate in SURFACED_OWNERSHIP', () => {
    seededDb((dbPath) => {
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      expect(board.length).toBeGreaterThan(0);
      // Both published outcomes the seed is built around: the official's own stake and a relative's.
      expect(board.map((r) => r.relation).sort()).toEqual(['owns', 'related']);
    });
  });

  it('every surfaced seed link carries a real publishing seal, not a coincidence', () => {
    seededDb((dbPath) => {
      for (const r of rows(dbPath, lit(LEADERBOARD_SQL, 100)))
        expect(['document', 'confirmed']).toContain(r.evidence_kind);
    });
  });

  it('the held joint-stock link stays off the surface — the seed keeps its negative case', () => {
    // ГАМА ИНВЕСТ АД is seeded as a withheld link precisely so a change to the publishing rule shows up
    // as a before/after rather than as an empty page either way. If it ever surfaces, the materiality
    // bar (ADR-0022) or the seal gate has quietly stopped working.
    seededDb((dbPath) => {
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      expect(board.some((r) => String(r.company).includes('ГАМА ИНВЕСТ'))).toBe(false);
      expect(rows(dbPath, lit(COMPANY_SQL, '204556676'))).toHaveLength(0);
    });
  });

  it('the official and company pages render too — not just the leaderboard', () => {
    seededDb((dbPath) => {
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      const own = board.find((r) => r.relation === 'owns')!;
      expect(rows(dbPath, lit(OFFICIAL_SQL, String(own.person_id))).length).toBeGreaterThan(0);
      expect(rows(dbPath, lit(COMPANY_SQL, String(own.eik))).length).toBeGreaterThan(0);
    });
  });

  it('re-running the seed is idempotent — INSERT OR IGNORE, no duplicated links', () => {
    seededDb((dbPath) => {
      const before = rows(dbPath, lit(LEADERBOARD_SQL, 100)).length;
      execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${seed}\n`, stdio: 'pipe' });
      expect(rows(dbPath, lit(LEADERBOARD_SQL, 100))).toHaveLength(before);
    });
  });
});
