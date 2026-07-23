// Shared SQL helpers and fixture statements for the integration-test lane.
//
// Both `setup.ts` (per-test lazy bootstrap) and `global-setup.ts` (vitest
// `globalSetup`, runs once per process) need to apply the same D1 migrations
// and seed the same fixture rows. The two files used to inline ~60 lines of
// duplicated SQL helpers + constants; keeping them in lockstep was a manual
// chore and a drift hazard. This module owns the shared definition.
//
// Static `INSERT OR IGNORE` statements are safe to run in any order; the
// `buildContractsInsert(n)` builder interpolates only computed integers and
// ISO dates, so there is no SQL-injection surface.

export function stripSqlCommentsAndCollapse(raw: string): string[] {
  const stripped = raw
    .split('\n')
    .map((l) => {
      const idx = l.indexOf('--');
      return idx === -1 ? l : l.slice(0, idx).trimEnd();
    })
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const statements: string[] = [];
  let buf = '';
  let inString = false;
  let stringChar: string | null = null;
  for (const ch of stripped) {
    if (inString) {
      buf += ch;
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
    }
    if (ch === ';') {
      const t = buf.trim();
      if (t) statements.push(t.replace(/\s+/g, ' ').trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) statements.push(buf.trim().replace(/\s+/g, ' '));
  return statements;
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
