import { describe, expect, it } from 'vitest';
import { guardSelect } from './sql-ast-guard';
import { assertReadOnlySelect } from './sql-guard';
import { CANONICAL_QUERIES } from './describe-schema';

describe('guardSelect', () => {
  it('accepts every canonical query and bounds it with a LIMIT', () => {
    for (const q of CANONICAL_QUERIES) {
      // Feed it through the structural guard first, exactly as run_sql composes the two layers.
      const structural = assertReadOnlySelect(q.sql);
      expect(structural.ok, q.intent).toBe(true);
      if (structural.ok) {
        const r = guardSelect(structural.sql);
        expect(r.ok, q.intent).toBe(true);
        if (r.ok) expect(r.sql, q.intent).toMatch(/\blimit\b/i);
      }
    }
  });

  it('accepts a WITH…SELECT over allowlisted tables (CTE name is not a real table)', () => {
    const sql =
      'WITH top AS (SELECT authority_id, spent_eur FROM authority_totals ORDER BY spent_eur DESC LIMIT 10) ' +
      'SELECT a.name, top.spent_eur FROM top JOIN authorities a ON a.id = top.authority_id';
    expect(guardSelect(sql).ok).toBe(true);
  });

  it('rejects write statements and stacked statements', () => {
    expect(guardSelect('UPDATE contracts SET amount_eur = 0').ok).toBe(false);
    expect(guardSelect('SELECT 1; DROP TABLE contracts').ok).toBe(false);
  });

  it('fails closed on anything it cannot parse', () => {
    const r = guardSelect('SELECT FROM WHERE )(');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not be parsed/);
  });

  it('rejects a non-allowlisted table (sqlite_master enumeration)', () => {
    const r = guardSelect('SELECT name, sql FROM sqlite_master');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/table not allowed: sqlite_master/);
  });

  it('rejects comma cross-joins (Cartesian product a LIMIT cannot bound)', () => {
    const r = guardSelect('SELECT COUNT(*) FROM contracts a, contracts b, contracts c');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cross-join/);
  });

  it('rejects WITH RECURSIVE (unbounded recursion)', () => {
    const r = guardSelect(
      'WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT x FROM r',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/recursive/);
  });

  it('injects an outer LIMIT and is not fooled by a string-literal LIMIT', () => {
    const r = guardSelect("SELECT 'LIMIT 1' AS note FROM contracts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/LIMIT 500$/);
  });

  it('does not treat a sub-query LIMIT as the outer bound', () => {
    const r = guardSelect(
      'SELECT id FROM contracts WHERE id IN (SELECT id FROM contracts LIMIT 1)',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/LIMIT 500$/); // an outer LIMIT is still appended
  });

  it('clamps an oversized outer LIMIT to the row cap', () => {
    const r = guardSelect('SELECT name FROM authorities LIMIT 100000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/LIMIT 500/);
  });

  it('rejects LIMIT offset, count form (fools the regex-based enforceLimit — review #80 L1)', () => {
    const r = guardSelect('SELECT name FROM authorities LIMIT 5, 10000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/LIMIT offset, count/);
  });

  it('rejects table-valued functions in FROM (pragma_/json_each schema-enum + amplification, review #80)', () => {
    // tableList() returns [] for the function form, so the table allowlist never sees these — fail closed.
    for (const sql of [
      "SELECT * FROM pragma_table_info('contracts')",
      "SELECT * FROM json_each('[1,2,3]')",
      "SELECT c.id FROM contracts c JOIN json_each('[1,2]') ON 1 = 1",
    ]) {
      expect(guardSelect(sql).ok, sql).toBe(false);
    }
  });

  it('rejects an explicit JOIN / CROSS JOIN with no ON/USING (Cartesian product, review #80)', () => {
    expect(guardSelect('SELECT * FROM contracts JOIN bidders').ok).toBe(false);
    expect(guardSelect('SELECT * FROM contracts CROSS JOIN bidders').ok).toBe(false);
    // a JOIN that DOES carry a condition is accepted
    expect(guardSelect('SELECT * FROM contracts c JOIN bidders b ON b.id = c.bidder_id').ok).toBe(
      true,
    );
  });

  it('still allowlists tables referenced inside a sub-query in FROM', () => {
    expect(guardSelect('SELECT x.id FROM (SELECT id FROM contracts) x').ok).toBe(true);
    const bad = guardSelect('SELECT x.name FROM (SELECT name FROM sqlite_master) x');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/table not allowed: sqlite_master/);
  });

  it('blocks schema enumeration through the other arm of a UNION', () => {
    const r = guardSelect('SELECT name FROM authorities UNION SELECT sql FROM sqlite_master');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/table not allowed: sqlite_master/);
  });

  it('clamps a compound (UNION) outer LIMIT without emitting a double LIMIT (review #80)', () => {
    const r = guardSelect(
      'SELECT id FROM contracts UNION ALL SELECT id FROM authority_totals LIMIT 100000',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sql).toMatch(/LIMIT 500\b/);
      expect(r.sql).not.toMatch(/LIMIT\s+\d+\s+LIMIT/i); // not `… LIMIT 100000 LIMIT 500` (SQLite syntax error)
    }
  });
});
