/** True for the expected "table doesn't exist yet" error the daily ETL derive can leave behind
 * (before the first derive, or mid-rebuild since ship-domain drops+recreates contract_features). */
export function isMissingDerivedTableError(err: unknown): boolean {
  return /no such table/i.test(err instanceof Error ? err.message : String(err));
}
