// „D1_ERROR: no such table: contract_features: SQLITE_ERROR" → capture the table name and test
// membership, same convention as related-persons.ts's MISSING_TABLE.
const MISSING_TABLE = /no such table:\s*(?:main\.)?"?([a-z_]+)"?/i;

/** True for the expected "table doesn't exist yet" error the daily ETL derive can leave behind
 * (before the first derive, or mid-rebuild since ship-domain drops+recreates contract_features).
 * Scoped to the specific derived table name so an unrelated missing-table failure (e.g. from a
 * future JOIN) surfaces instead of being swallowed as "not derived yet". */
export function isMissingDerivedTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const m = MISSING_TABLE.exec(message);
  return m != null && m[1]!.toLowerCase() === 'contract_features';
}
