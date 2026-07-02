import { describe, expect, it } from 'vitest';
import { assertDefaultFilters } from './assert-default-filters';
import { applyDefaultFilters } from '../../../workers/assistant/default-filters';
import { CANONICAL_QUERIES } from './describe-schema';

// A real canonical query that joins contracts + tenders and already carries `amount_eur IS NOT NULL`
// (the HHI concentration example). We append the synthetic-tender predicate to exercise the
// "both filters present" path, since no canonical query bundles both by hand.
const HHI = CANONICAL_QUERIES.find((q) => q.intent.startsWith('Концентрация'))!.sql;
const HHI_WITH_BOTH = HHI.replace(
  'WHERE c.amount_eur IS NOT NULL',
  "WHERE c.amount_eur IS NOT NULL AND t.procedure_type != 'неизвестна'",
);

describe('assertDefaultFilters', () => {
  it('rejects a base-contracts query missing both default filters', () => {
    const r = assertDefaultFilters('SELECT SUM(amount_eur) FROM contracts c');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/amount_eur/);
      expect(r.reason).toMatch(/procedure_type/);
      // fragment: lowercase start, no trailing period
      expect(r.reason[0]).toBe(r.reason[0].toLowerCase());
      expect(r.reason.endsWith('.')).toBe(false);
    }
  });

  it('accepts a base-contracts query carrying both default filters and returns the standard callout', () => {
    expect(HHI_WITH_BOTH).toContain('JOIN tenders t');
    expect(HHI_WITH_BOTH).toContain('c.amount_eur IS NOT NULL');
    expect(HHI_WITH_BOTH).toContain("t.procedure_type != 'неизвестна'");

    const r = assertDefaultFilters(HHI_WITH_BOTH);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.callout).toEqual(applyDefaultFilters().callout);
      expect(r.callout.length).toBeGreaterThan(0);
    }
  });

  it('bypasses a rollup-only query (no base contracts table) with an empty callout', () => {
    const r = assertDefaultFilters(
      "SELECT spent_eur FROM authority_totals WHERE authority_id = '1'",
    );
    expect(r).toEqual({ ok: true, callout: [] });
  });

  it('rejects a query that has amount_eur but is missing the procedure_type filter', () => {
    const r = assertDefaultFilters(
      'SELECT SUM(c.amount_eur) FROM contracts c JOIN tenders t ON t.id = c.tender_id WHERE c.amount_eur IS NOT NULL',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/procedure_type/);
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
      expect(r.reason).toMatch(/procedure_type/);
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
      expect(r.reason).toMatch(/procedure_type/);
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
      expect(r.reason).toMatch(/procedure_type/);
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
});
