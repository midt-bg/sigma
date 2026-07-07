import { describe, expect, it } from 'vitest';
import { assertDefaultFilters } from './assert-default-filters';
import { applyDefaultFilters } from '../../../workers/assistant/default-filters';
import { CANONICAL_QUERIES } from './describe-schema';

// The HHI concentration canonical query — joins contracts + tenders and carries both mandatory
// default filters (amount_eur IS NOT NULL AND c.is_synthetic != 1).
const HHI = CANONICAL_QUERIES.find((q) => q.intent.startsWith('Концентрация'))!.sql;

describe('assertDefaultFilters', () => {
  it('rejects a base-contracts query missing both default filters', () => {
    const r = assertDefaultFilters('SELECT SUM(amount_eur) FROM contracts c');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/amount_eur/);
      expect(r.reason).toMatch(/is_synthetic/);
      // fragment: lowercase start, no trailing period
      expect(r.reason[0]).toBe(r.reason[0].toLowerCase());
      expect(r.reason.endsWith('.')).toBe(false);
    }
  });

  it('accepts a base-contracts query carrying both default filters and returns the standard callout', () => {
    expect(HHI).toContain('JOIN tenders t');
    expect(HHI).toContain('c.amount_eur IS NOT NULL');
    expect(HHI).toContain('c.is_synthetic != 1');

    const r = assertDefaultFilters(HHI);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.callout).toEqual(applyDefaultFilters().callout);
      // Exactly the three default callouts: null-amount, synthetic-exclusion, signed_at date field.
      expect(r.callout.length).toBe(3);
    }
  });

  it('bypasses a rollup-only query (no base contracts table) with an empty callout', () => {
    const r = assertDefaultFilters(
      "SELECT spent_eur FROM authority_totals WHERE authority_id = '1'",
    );
    expect(r).toEqual({ ok: true, callout: [] });
  });

  it('rejects a query that has amount_eur but is missing the synthetic-exclusion filter', () => {
    const r = assertDefaultFilters(
      'SELECT SUM(c.amount_eur) FROM contracts c JOIN tenders t ON t.id = c.tender_id WHERE c.amount_eur IS NOT NULL',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/is_synthetic/);
      expect(r.reason).not.toMatch(/amount_eur/);
    }
  });

  it('rejects a query that has procedure_type but is missing the amount_eur filter', () => {
    const r = assertDefaultFilters(
      "SELECT * FROM contracts c JOIN tenders t ON t.id = c.tender_id WHERE t.procedure_type != 'неизвестна'",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/amount_eur/);
      expect(r.reason).not.toMatch(/procedure_type/);
    }
  });

  it('accepts the bound-parameter form of the synthetic-tender predicate', () => {
    const r = assertDefaultFilters(
      'SELECT SUM(c.amount_eur) FROM contracts c JOIN tenders t ON t.id = c.tender_id ' +
        'WHERE c.amount_eur IS NOT NULL AND t.procedure_type != ?',
    );
    expect(r.ok).toBe(true);
  });

  it('treats empty / whitespace input as a non-contracts query and bypasses it', () => {
    expect(assertDefaultFilters('')).toEqual({ ok: true, callout: [] });
    expect(assertDefaultFilters('   \n\t ')).toEqual({ ok: true, callout: [] });
  });

  it('detects the base table robustly across casing and extra whitespace', () => {
    const r = assertDefaultFilters('SELECT SUM(amount_eur)\nFROM   Contracts   c');
    expect(r.ok).toBe(false); // detected as base-contracts, filters missing
  });

  it('tolerates extra whitespace inside the required predicates', () => {
    const r = assertDefaultFilters(
      'SELECT SUM(c.amount_eur) FROM contracts c JOIN tenders t ON t.id = c.tender_id ' +
        "WHERE c.amount_eur   IS   NOT   NULL AND t.procedure_type !=  'неизвестна'",
    );
    expect(r.ok).toBe(true);
  });

  it('accepts the NOT IN form of the synthetic-tender predicate', () => {
    const r = assertDefaultFilters(
      'SELECT SUM(c.amount_eur) FROM contracts c JOIN tenders t ON t.id = c.tender_id ' +
        "WHERE c.amount_eur IS NOT NULL AND t.procedure_type NOT IN ('неизвестна')",
    );
    expect(r.ok).toBe(true);
  });

  // review #12 blocker — the predicates must be ENFORCED (top-level WHERE conjuncts), not merely present
  // as text. Each of these reads the NULL-amount / synthetic rows the gate exists to exclude.

  it('rejects predicates placed in the projection instead of the WHERE', () => {
    const r = assertDefaultFilters(
      "SELECT COUNT(*), (amount_eur IS NOT NULL) AS a, (procedure_type != 'неизвестна') AS b FROM contracts",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/amount_eur/);
      expect(r.reason).toMatch(/is_synthetic/);
    }
  });

  it('rejects predicates hidden behind an OR (not an enforced conjunct)', () => {
    const r = assertDefaultFilters(
      'SELECT COUNT(*) FROM contracts c JOIN tenders t ON t.id = c.tender_id ' +
        "WHERE t.authority_id = 5 OR (c.amount_eur IS NOT NULL AND t.procedure_type != 'неизвестна')",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/amount_eur/);
      expect(r.reason).toMatch(/is_synthetic/);
    }
  });

  it('rejects a base-contracts scope whose own WHERE lacks the filters (filtered only in an outer scope)', () => {
    const r = assertDefaultFilters(
      'SELECT * FROM (SELECT c.amount_eur AS amount_eur, t.procedure_type AS procedure_type ' +
        'FROM contracts c JOIN tenders t ON t.id = c.tender_id) x ' +
        "WHERE x.amount_eur IS NOT NULL AND x.procedure_type != 'неизвестна'",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/amount_eur/);
      expect(r.reason).toMatch(/is_synthetic/);
    }
  });

  it('does not treat the filter text inside a string literal as a real filter', () => {
    // A rollup-only read whose projection embeds the predicate text — the old regex matched it; the AST
    // gate sees no base-contracts table, so it bypasses (no false "filters applied" callout).
    const r = assertDefaultFilters(
      "SELECT 'from contracts where amount_eur is not null' AS note FROM authority_totals",
    );
    expect(r).toEqual({ ok: true, callout: [] });
  });

  // Conditional signed_at-window guard: a series that BUCKETS by signed_at must bracket the date range,
  // else stray out-of-coverage rows (2016, 2029) leak into their own period buckets.
  const DEFAULTS = "c.amount_eur IS NOT NULL AND t.procedure_type != 'неизвестна'";
  const JOIN = 'FROM contracts c JOIN tenders t ON t.id = c.tender_id';

  it('rejects an UNBOUNDED year rollup (buckets by signed_at, no date range)', () => {
    const r = assertDefaultFilters(
      `SELECT substr(c.signed_at, 1, 4) AS year, SUM(c.amount_eur) AS total_eur ${JOIN} ` +
        `WHERE ${DEFAULTS} AND c.signed_at IS NOT NULL GROUP BY year`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/времеви обхват/);
  });

  it('rejects a bucketed series bounded only by the GLOB well-formedness check (not a date range)', () => {
    const r = assertDefaultFilters(
      `SELECT substr(c.signed_at, 1, 7) AS period, SUM(c.amount_eur) AS s ${JOIN} ` +
        `WHERE ${DEFAULTS} AND substr(c.signed_at, 1, 4) GLOB '[0-9][0-9][0-9][0-9]' GROUP BY period`,
    );
    expect(r.ok).toBe(false);
  });

  it('accepts a year rollup bracketed by a raw signed_at range', () => {
    const r = assertDefaultFilters(
      `SELECT substr(c.signed_at, 1, 4) AS year, SUM(c.amount_eur) AS total_eur ${JOIN} ` +
        `WHERE ${DEFAULTS} AND c.signed_at >= '2020-01-01' AND c.signed_at <= date('now') GROUP BY year`,
    );
    expect(r.ok).toBe(true);
  });

  it('accepts a bucketed series pinned to a fixed year via substr equality', () => {
    const r = assertDefaultFilters(
      `SELECT substr(c.signed_at, 1, 4) AS year, COUNT(*) AS n ${JOIN} ` +
        `WHERE ${DEFAULTS} AND substr(c.signed_at, 1, 4) = '2023' GROUP BY year`,
    );
    expect(r.ok).toBe(true);
  });

  it('accepts a month series bounded by a period filter (>= … AND < …)', () => {
    const r = assertDefaultFilters(
      `SELECT substr(c.signed_at, 1, 7) AS period, SUM(c.amount_eur) AS s ${JOIN} ` +
        `WHERE ${DEFAULTS} AND c.signed_at >= '2026-01-01' AND c.signed_at < '2026-07-03' GROUP BY period`,
    );
    expect(r.ok).toBe(true);
  });

  it('does NOT require a date window for a non-temporal aggregate (signed_at not bucketed)', () => {
    const r = assertDefaultFilters(`SELECT SUM(c.amount_eur) AS s ${JOIN} WHERE ${DEFAULTS}`);
    expect(r.ok).toBe(true);
  });
});

// Referential-integrity guard: every CANONICAL_QUERIES entry that reads base `contracts` must already
// carry both mandatory default filters. This catches regressions where a canonical example is edited
// without keeping its WHERE clause in sync with assertDefaultFilters.
describe('CANONICAL_QUERIES — base-contracts entries carry default filters', () => {
  const contractsQueries = CANONICAL_QUERIES.filter((q) => /\bFROM\s+contracts\b/i.test(q.sql));

  it('has at least one base-contracts canonical query to guard against an empty filter', () => {
    expect(contractsQueries.length).toBeGreaterThan(0);
  });

  it.each(contractsQueries.map((q) => [q.intent, q.sql] as [string, string]))(
    '%s',
    (_intent, sql) => {
      const result = assertDefaultFilters(sql);
      expect(result.ok).toBe(true);
    },
  );
});
