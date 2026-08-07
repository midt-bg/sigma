// Shared SQL helpers and fixture statements for the integration-test lane.
//
// `setup.ts` (per-test lazy bootstrap in each vitest worker) applies the D1 migrations and seeds
// the fixture rows from these constants. (A vitest `globalSetup` used to do the same on a proxy no
// test reads; it was removed as redundant in PR #177 review T-003. This module remains the single
// source of truth for the SQL helpers + fixture rows so they cannot drift.)
//
// Static `INSERT OR IGNORE` statements are safe to run in any order; the
// `buildContractsInsert(n)` builder interpolates only computed integers and
// ISO dates, so there is no SQL-injection surface.

/**
 * Split a DDL / seed SQL file into individual statements: strip `--` line comments, split on `;`,
 * and collapse runs of whitespace outside string literals.
 *
 * Comment stripping and whitespace collapsing are STRING-AWARE: a `--` inside a single/double-
 * quoted string literal (`'a--b'`) is NOT treated as a comment start, and significant whitespace
 * inside a string literal is preserved. Only the DDL the integration lane ships today is safe
 * under the simpler per-line variant, but a future migration or seed row containing `'a--b'` or
 * multi-space strings would be silently corrupted by it (PR #177 review T-004). This single-pass
 * char scanner tracks in-string state across all three operations so they cannot desynchronize.
 *
 * The scanner is intentionally minimal: it does NOT honour SQL block comments (`/* … *\/`,
 * absent from the migration files) or escaped quote doubling (`''`), neither of which appear in
 * the shipped DDL/fixture SQL. Add those only if a future migration needs them.
 */
export function stripSqlCommentsAndCollapse(raw: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let inString = false;
  let stringChar: string | null = null;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;

    // Inside a string literal: copy verbatim until the matching closing quote. Nothing inside is
    // treated as a comment, a statement separator, or collapsible whitespace.
    if (inString) {
      buf += ch;
      if (ch === stringChar) inString = false;
      continue;
    }

    // `--` line comment (only when NOT in a string): skip to end of line without copying.
    if (ch === '-' && raw[i + 1] === '-') {
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }

    // String literal start: enter string mode and copy the quote.
    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      buf += ch;
      continue;
    }

    // Statement separator (only when NOT in a string): flush the buffered statement.
    if (ch === ';') {
      const collapsed = collapseWhitespaceOutsideStrings(buf.trim());
      if (collapsed) statements.push(collapsed);
      buf = '';
      continue;
    }

    buf += ch;
  }

  const tail = collapseWhitespaceOutsideStrings(buf.trim());
  if (tail) statements.push(tail);
  return statements;
}

/**
 * Collapse runs of whitespace into a single space, but ONLY outside single/double-quoted string
 * literals. Significant whitespace inside a string (`'a   b'`) is preserved verbatim. Used to
 * normalise DDL indentation/newlines after comment stripping without corrupting string payloads.
 */
function collapseWhitespaceOutsideStrings(s: string): string {
  let out = '';
  let inString = false;
  let stringChar: string | null = null;
  let prevWasOutsideStringWhitespace = false;

  for (const ch of s) {
    if (inString) {
      out += ch;
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      out += ch;
      prevWasOutsideStringWhitespace = false;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (!prevWasOutsideStringWhitespace) {
        out += ' ';
        prevWasOutsideStringWhitespace = true;
      }
      continue;
    }
    out += ch;
    prevWasOutsideStringWhitespace = false;
  }
  return out.trim();
}

export function buildContractsInsert(n: number): string {
  const rows: string[] = [];
  for (let i = 1; i <= n; i++) {
    const amount = (n - i + 1) * 1000 + i;
    const m = ((i - 1) % 12) + 1;
    const y = 2020 + Math.floor((i - 1) / 12);
    const d = ((i - 1) % 28) + 1;
    const signedAt = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    rows.push(
      `('c:${i}', 't:FIX-1', 'eik:BG000000001', ${amount}, 'BGN', '${signedAt}', 'ok', 'ok', ${amount}, 0)`,
    );
  }
  return `INSERT OR IGNORE INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, date_flag, amount_eur, fx_converted) VALUES ${rows.join(', ')}`;
}

export const FIXTURE_AUTHORITIES =
  "INSERT OR IGNORE INTO authorities (id, name, bulstat, type) VALUES ('auth:BG000000000', 'Authority Test', 'BG000000000', 'Министерство')";
export const FIXTURE_BIDDERS =
  "INSERT OR IGNORE INTO bidders (id, name, bulstat, eik_normalized, eik_valid, is_consortium, kind) VALUES ('eik:BG000000001', 'Bidder Test', 'BG000000001', '0000000001', 1, 0, 'company')";
export const FIXTURE_TENDER =
  "INSERT OR IGNORE INTO tenders (id, source_id, title, authority_id, currency, procedure_type) VALUES ('t:FIX-1', 'FIX-1', 'Test tender', 'auth:BG000000000', 'BGN', 'открита')";
export const FIXTURE_HOME_TOTALS =
  "INSERT OR IGNORE INTO home_totals (id, contracts, value_eur, authorities, bidders, suspect, refreshed_at) VALUES (1, 30, 1000000.0, 1, 1, 0, datetime('now'))";
export const FIXTURE_DATA_FRESHNESS =
  "INSERT OR IGNORE INTO data_freshness (source, refreshed_at) VALUES ('admin', datetime('now'))";
// The sitemap routes for authorities/companies query the derived
// `authority_totals` / `company_totals` tables (not the base tables). Seed one
// row each so the per-type sitemaps have at least one entry to emit.
export const FIXTURE_AUTHORITY_TOTALS =
  "INSERT OR IGNORE INTO authority_totals (authority_id, name, spent_eur, contracts, suppliers, avg_eur, eu_eur, first_date, last_date) VALUES ('auth:BG000000000', 'Authority Test', 1000000.0, 30, 1, 33333.33, 0, '2020-01-01', '2022-12-28')";
export const FIXTURE_COMPANY_TOTALS =
  "INSERT OR IGNORE INTO company_totals (bidder_id, name, kind, won_eur, contracts, authorities, eu_eur, first_date, last_date) VALUES ('eik:BG000000001', 'Bidder Test', 'company', 1000000.0, 30, 1, 0, '2020-01-01', '2022-12-28')";

/** Canonical fixture seed order. Append `buildContractsInsert(N)` after this. */
export const FIXTURE_STATEMENTS: readonly string[] = [
  FIXTURE_AUTHORITIES,
  FIXTURE_BIDDERS,
  FIXTURE_TENDER,
  FIXTURE_HOME_TOTALS,
  FIXTURE_DATA_FRESHNESS,
  FIXTURE_AUTHORITY_TOTALS,
  FIXTURE_COMPANY_TOTALS,
];
