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

  it('rejects a 3×+ self-join even with valid ONs (low-cardinality ~N³ DoW; review #80, follow-up)', () => {
    // Each ON has 2 distinct qualifiers so the anti-tautology check passes, but on a boolean column this
    // is a near-Cartesian scan an aggregate/ORDER BY hides past the LIMIT — caught by the self-join cap.
    const r = guardSelect(
      'SELECT COUNT(*) FROM contracts c1 JOIN contracts c2 ON c1.eu_funded = c2.eu_funded JOIN contracts c3 ON c2.eu_funded = c3.eu_funded',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/self-join/);
    // a legitimate 3-way join over DISTINCT tables is still accepted
    expect(
      guardSelect(
        'SELECT a.name, t.id, c.amount_eur FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id',
      ).ok,
    ).toBe(true);
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

  it('accepts the standard LIMIT n OFFSET m form and clamps only the count (review #80 L1)', () => {
    // The OFFSET form parses to the same value.length as the rejected comma form; distinguishing by
    // `seperator` lets this through. A within-bounds count is untouched; OFFSET must survive intact and
    // no second LIMIT may be appended (that would be a SQLite syntax error).
    const within = guardSelect('SELECT name FROM authorities LIMIT 100 OFFSET 20');
    expect(within.ok).toBe(true);
    if (within.ok) {
      expect(within.sql).toMatch(/LIMIT 100 OFFSET 20/i);
      expect((within.sql.match(/\blimit\b/gi) ?? []).length).toBe(1); // no double LIMIT
    }
    // An oversized count is clamped to the row cap while OFFSET is preserved.
    const oversized = guardSelect('SELECT name FROM authorities LIMIT 100000 OFFSET 20');
    expect(oversized.ok).toBe(true);
    if (oversized.ok) expect(oversized.sql).toMatch(/LIMIT 500 OFFSET 20/i);
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

  it('rejects a table-valued function nested in a sub-query or WHERE-IN (review #80, ydimitrof H1)', () => {
    // tableList() is blind to TVFs and the FROM source looks like a legit sub-query; the deep FROM walk
    // catches the TVF (and the same-class nested ON-less cross-join) at any depth.
    expect(
      guardSelect(
        "SELECT contract_id FROM (SELECT value AS contract_id FROM json_each('[1,2,3]')) x",
      ).ok,
    ).toBe(false);
    expect(
      guardSelect("SELECT id FROM contracts WHERE id IN (SELECT value FROM json_each('[1,2,3]'))")
        .ok,
    ).toBe(false);
    expect(
      guardSelect('SELECT x.n FROM (SELECT a.id AS n FROM contracts a JOIN bidders b) x').ok,
    ).toBe(false);
    // a legitimate nested sub-query over allowlisted tables still passes
    expect(
      guardSelect('SELECT x.id FROM (SELECT id FROM contracts WHERE amount_eur IS NOT NULL) x').ok,
    ).toBe(true);
  });

  it('allowlists a CTE declared inside a sub-query (nested WITH), but still catches a bad table there', () => {
    // inner_cte is a CTE, not a real table — must not be rejected as "table not allowed"
    expect(
      guardSelect(
        'SELECT x.id FROM (WITH inner_cte AS (SELECT id FROM contracts) SELECT id FROM inner_cte) x',
      ).ok,
    ).toBe(true);
    // a disallowed table inside the nested sub-query is still caught
    const bad = guardSelect(
      'SELECT x.name FROM (WITH t AS (SELECT name FROM sqlite_master) SELECT name FROM t) x',
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/table not allowed: sqlite_master/);
  });

  it('rejects CTE-name poisoning of the allowlist — an out-of-scope CTE cannot exempt a real table (review #80)', () => {
    // SQLite scopes CTEs lexically, so a throwaway CTE named like a disallowed table, declared inside an
    // UNRELATED sub-query, does NOT shadow the outer real reference. A global CTE-name set let these
    // enumerate the schema; the scoped walk rejects them.
    expect(
      guardSelect(
        'WITH dummy AS (WITH sqlite_master AS (SELECT 1 AS k) SELECT 1 AS k) SELECT name FROM sqlite_master',
      ).ok,
    ).toBe(false);
    expect(
      guardSelect(
        'WITH dummy AS (WITH fx_rates AS (SELECT 1 AS k) SELECT 1 AS k) SELECT a.name FROM authorities a JOIN fx_rates f ON 1 = 1',
      ).ok,
    ).toBe(false);
  });

  it('rejects duplicate output column names; aliasing resolves it (review #80)', () => {
    expect(
      guardSelect('SELECT t.id, c.id FROM contracts c JOIN tenders t ON t.id = c.tender_id').ok,
    ).toBe(false);
    expect(
      guardSelect(
        'SELECT t.id AS tid, c.id AS cid FROM contracts c JOIN tenders t ON t.id = c.tender_id',
      ).ok,
    ).toBe(true);
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

  it('rejects a recursive CTE even without the RECURSIVE keyword (DoW — review #80, C1)', () => {
    // SQLite does not require `RECURSIVE`; a self-referencing CTE loops unbounded feeding an aggregate.
    const r = guardSelect(
      'WITH r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT max(x) AS m FROM r',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/recursive/i);
    // a non-recursive CTE (body references only real tables) still passes
    expect(
      guardSelect('WITH t AS (SELECT spent_eur FROM authority_totals) SELECT * FROM t LIMIT 5').ok,
    ).toBe(true);
  });

  it('rejects a tautological / single-side JOIN ON as a cross-join (DoW — review #80, C2)', () => {
    expect(guardSelect('SELECT * FROM contracts c JOIN bidders b ON 1=1').ok).toBe(false);
    expect(guardSelect('SELECT * FROM contracts c JOIN bidders b ON 1 = 1').ok).toBe(false);
    // a single-side predicate (only references table c) is still a Cartesian product over b
    expect(guardSelect('SELECT * FROM contracts c JOIN bidders b ON c.id = c.tender_id').ok).toBe(
      false,
    );
    // a real connecting condition passes
    expect(guardSelect('SELECT * FROM contracts c JOIN bidders b ON c.bidder_id = b.id').ok).toBe(
      true,
    );
  });

  it('rejects a JOIN whose ON connects only via a sub-query qualifier (Cartesian bypass — review #80, ultra)', () => {
    // qualifiers harvested from a sub-query INSIDE the ON must not count as connecting the two tables
    expect(
      guardSelect(
        'SELECT c.id FROM contracts c JOIN bidders b ON c.bidder_id = (SELECT x.id FROM authorities x LIMIT 1)',
      ).ok,
    ).toBe(false);
    expect(
      guardSelect(
        'SELECT a.id FROM authorities a JOIN contracts b ON a.id = (SELECT max(d.id) FROM bidders d)',
      ).ok,
    ).toBe(false);
    // a genuinely connecting ON that ALSO carries a sub-query filter still passes
    expect(
      guardSelect(
        'SELECT c.id FROM contracts c JOIN bidders b ON c.bidder_id = b.id AND b.id IN (SELECT bidder_id FROM company_totals)',
      ).ok,
    ).toBe(true);
  });

  it('rejects a negative LIMIT (LIMIT -1 = unbounded in SQLite — review #80)', () => {
    const r = guardSelect('SELECT name FROM authorities LIMIT -1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/negative LIMIT/i);
  });

  it('rejects a non-integer LIMIT literal the regex cannot clamp (LIMIT 1e9 / 1.5 — review #80, ydimitrof)', () => {
    // The AST accepts `1e9` (type 'bigint') and `1.5`, but enforceLimit's `\d+` regex does not, so it
    // would emit `LIMIT 1e9 LIMIT 500` (a SQLite syntax error that only fails closed by accident).
    for (const sql of [
      'SELECT name FROM authorities LIMIT 1e9',
      'SELECT name FROM authorities LIMIT 1.5',
    ]) {
      const r = guardSelect(sql);
      expect(r.ok, sql).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/integer/i);
    }
    // a plain integer LIMIT (even a large one) is still accepted and clamped to the row cap
    const ok = guardSelect('SELECT name FROM authorities LIMIT 1000000');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.sql).toMatch(/LIMIT 500/);
  });
});
