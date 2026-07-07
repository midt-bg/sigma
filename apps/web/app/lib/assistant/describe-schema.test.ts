import { describe, expect, it } from 'vitest';
import { CANONICAL_QUERIES, DATA_TRAPS, TABLES } from './describe-schema';

// The data dictionary is the RAG grounding corpus (rag.ts embeds these chunks; ADR-0008). Drift between
// the canonical queries and the documented tables silently poisons that grounding — the model adapts a
// query joining a table the dictionary never described. These are referential-integrity guards, not
// prose checks: they fail the moment a table is renamed/removed without updating the example queries.

const tableNames = new Set(TABLES.map((t) => t.name));

// Base tables referenced after FROM/JOIN, and CTE names defined via `WITH x AS (` / `, y AS (`.
const referencedTables = (sql: string): string[] =>
  [...sql.matchAll(/(?:FROM|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]);
const cteNames = (sql: string): Set<string> =>
  new Set([...sql.matchAll(/(?:WITH|,)\s+([a-z_]+)\s+AS\s*\(/gi)].map((m) => m[1]));

describe('describe-schema data dictionary', () => {
  it('table names are unique and fully described', () => {
    expect(tableNames.size).toBe(TABLES.length);
    for (const t of TABLES) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.grain.trim().length).toBeGreaterThan(0);
      expect(t.columns.trim().length).toBeGreaterThan(0);
    }
  });

  it('data traps are non-empty, distinct imperative rules', () => {
    // Exact count (not a floor) so an accidental deletion trips the test too (review #52).
    expect(DATA_TRAPS.length).toBe(14);
    expect(new Set(DATA_TRAPS).size).toBe(DATA_TRAPS.length);
    for (const trap of DATA_TRAPS) expect(trap.trim().length).toBeGreaterThan(20);
  });

  it('every canonical query joins only documented tables (or its own CTEs)', () => {
    expect(CANONICAL_QUERIES.length).toBeGreaterThan(0);
    for (const { intent, sql } of CANONICAL_QUERIES) {
      expect(intent.trim().length).toBeGreaterThan(0);
      expect(sql.trim().endsWith(';')).toBe(true);

      const ctes = cteNames(sql);
      const refs = referencedTables(sql);
      expect(refs.length).toBeGreaterThan(0); // a real query touches at least one table
      for (const ref of refs) {
        expect(
          tableNames.has(ref) || ctes.has(ref),
          `canonical query "${intent}" references unknown table \`${ref}\``,
        ).toBe(true);
      }
    }
  });
});
