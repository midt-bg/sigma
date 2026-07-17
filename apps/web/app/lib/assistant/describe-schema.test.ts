import { describe, expect, it } from 'vitest';
import {
  CANONICAL_QUERIES,
  cpvReference,
  DATA_TRAPS,
  describeSchema,
  TABLES,
} from './describe-schema';

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
    expect(DATA_TRAPS.length).toBe(17);
    expect(new Set(DATA_TRAPS).size).toBe(DATA_TRAPS.length);
    for (const trap of DATA_TRAPS) expect(trap.trim().length).toBeGreaterThan(20);
  });

  it('steers display away from raw entity-id columns — Q17/Q46 leak guard', () => {
    // The model showed `auth:…`/`eik:…` ids as visible cells. A trap must forbid id columns as display and
    // point at the name + link.idCol mechanism instead (the deterministic backstop lives in report-schema).
    const joined = DATA_TRAPS.join('\n');
    expect(joined).toMatch(/НИКОГА не ги показвай като видима колона/);
    expect(joined).toContain('link.idCol');
    expect(joined).toMatch(/`a\.name`.*възложител/);
  });

  it('bounds recency/relative-date queries with an upper signed_at cap — Q19 future-date guard', () => {
    // „последната седмица" leaked a 2029 row (no upper bound). A trap must cap the top end at date('now').
    const joined = DATA_TRAPS.join('\n');
    expect(joined).toMatch(/последн(ата седмица|ите N дни)/);
    expect(joined).toContain("c.signed_at <= date('now')");
    expect(joined).toContain("c.signed_at >= date('now','-7 days')");
  });

  it('CPV reference maps the health theme to divisions 33 and 85 (not 38) — Q24 guard', () => {
    const ref = cpvReference();
    // The curated health group must resolve to 33 (medical/pharma) + 85 (health services), so the model
    // stops mapping „здравеопазване" to 38 (lab/optical) or 31 (electrical).
    expect(ref).toMatch(/Здравеопазване[^\n]*→ раздели[^\n]*33/);
    expect(ref).toMatch(/Здравеопазване[^\n]*85/);
    expect(ref).toContain(
      '33 — Медицинско оборудване, фармацевтични продукти и продукти за лични грижи',
    );
    // and it ships inside the assembled dictionary the model actually reads
    expect(describeSchema()).toContain('Речник на CPV раздели');
  });

  it('documents authority region as a NAME, not a NUTS3 code — Q41 guard', () => {
    const totals = TABLES.find((t) => t.name === 'authority_totals');
    expect(totals?.columns).toMatch(/region \(ИМЕ/);
    expect(totals?.columns).toContain('НЕ е NUTS3 код');
    // an „извън София" example exists and excludes by NAME, never by code
    const outsideSofia = CANONICAL_QUERIES.find((q) => q.intent.includes('ИЗВЪН София'));
    expect(outsideSofia?.sql).toContain("NOT IN ('София (столица)', 'София')");
    expect(outsideSofia?.sql).not.toContain('BG411');
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

  it('parties dictionary lists only real columns — no phantom `role` (nedda review guard)', () => {
    // Physical columns of `parties` (packages/db/migrations/0000_init.sql). The dictionary must not
    // advertise a column the table lacks: the model would emit `SELECT role`, which passes all three SQL
    // guards and then errors at D1 with "no such column: role".
    const realColumns = new Set([
      'party_key',
      'eik',
      'source',
      'ocid',
      'party_id',
      'name',
      'street_address',
      'locality',
      'region_nuts',
      'contact_email',
      'contact_phone',
    ]);
    const parties = TABLES.find((t) => t.name === 'parties');
    expect(parties).toBeDefined();
    const advertised = parties!.columns
      .split(',')
      .map((tok) => tok.trim().match(/^[a-z_]+/)?.[0])
      .filter((c): c is string => Boolean(c));
    expect(advertised.length).toBeGreaterThan(0);
    expect(advertised).not.toContain('role');
    for (const col of advertised) {
      expect(
        realColumns.has(col),
        `parties dictionary advertises non-existent column \`${col}\``,
      ).toBe(true);
    }
  });
});
