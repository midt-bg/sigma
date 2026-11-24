// `substr(col, 1, n) IN (…)` reads every row: SQLite cannot use an index through substr(). The same test
// written as ranges on the column itself — '45' ≤ col < '46' — is served by the column's index, so a
// sector or a year filter reads its own rows instead of the whole table.

const next = (value: string) =>
  value.slice(0, -1) + String.fromCharCode(value.charCodeAt(value.length - 1) + 1);

/**
 * Rows whose `col` begins with one of `values`, each `length` characters long. Digit prefixes use
 * indexed ranges. Other values keep the exact substr() test.
 */
export function prefixIn(
  col: string,
  length: number,
  values: readonly string[],
): { sql: string; params: string[] } {
  const tests: string[] = [];
  for (const value of values) {
    if (value.length === length && /^[0-9]+$/.test(value)) {
      // The upper bound contains only ASCII digits and possibly a final colon (after 9).
      // Using a text literal for it keeps each prefix to one bind under D1's 100-parameter limit.
      tests.push(`(${col} >= ? AND ${col} < '${next(value)}')`);
    } else {
      tests.push(`substr(${col}, 1, ${length}) = ?`);
    }
  }
  return { sql: `(${tests.join(' OR ')})`, params: [...values] };
}
