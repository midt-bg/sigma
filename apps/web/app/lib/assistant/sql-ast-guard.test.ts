import { describe, expect, it } from 'vitest';
import { assertReadOnlyAst } from './sql-ast-guard';
import { assertReadOnlySelect } from './sql-guard';
import { CANONICAL_QUERIES } from './describe-schema';

describe('assertReadOnlyAst', () => {
  it('accepts every canonical query (real model SQL must survive the guard)', () => {
    for (const q of CANONICAL_QUERIES) {
      // Feed it through the structural guard first, exactly as run_sql composes the two layers.
      const structural = assertReadOnlySelect(q.sql);
      expect(structural.ok, q.intent).toBe(true);
      if (structural.ok) expect(assertReadOnlyAst(structural.sql).ok, q.intent).toBe(true);
    }
  });

  it('accepts a WITH…SELECT (CTE)', () => {
    const sql =
      'WITH top AS (SELECT authority_id, spent_eur FROM authority_totals ORDER BY spent_eur DESC LIMIT 10) ' +
      'SELECT a.name, top.spent_eur FROM top JOIN authorities a ON a.id = top.authority_id';
    expect(assertReadOnlyAst(sql).ok).toBe(true);
  });

  it('rejects write statements (parses to a non-select type)', () => {
    for (const sql of [
      'UPDATE contracts SET amount_eur = 0',
      'DELETE FROM contracts',
      'INSERT INTO contracts (id) VALUES (1)',
    ]) {
      const r = assertReadOnlyAst(sql);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/only SELECT/);
    }
  });

  it('rejects stacked statements (a SELECT followed by a DROP)', () => {
    const r = assertReadOnlyAst('SELECT 1; DROP TABLE contracts');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/single statement/);
  });

  it('fails closed on anything it cannot parse', () => {
    const r = assertReadOnlyAst('SELECT FROM WHERE )(');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not be parsed/);
  });
});
