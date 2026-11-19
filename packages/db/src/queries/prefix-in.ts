// `substr(col, 1, n) IN (…)` reads every row: SQLite cannot use an index through substr(). The same test
// written as ranges on the column itself — '45' ≤ col < '46' — is served by the column's index, so a
// sector or a year filter reads its own rows instead of the whole table.

const next = (value: string) =>
  value.slice(0, -1) + String.fromCharCode(value.charCodeAt(value.length - 1) + 1);

/**
 * Rows whose `col` begins with one of `values`, each `length` characters long. A value of digits becomes
 * a range; anything else keeps the substr() form, so an odd value from a URL matches exactly what it
 * matched before.
 */
export function prefixIn(
  col: string,
  length: number,
  values: readonly string[],
): { sql: string; params: string[] } {
  const digits = new RegExp(`^\\d{${length}}$`);
  const tests: string[] = [];
  const params: string[] = [];
  for (const value of values) {
    if (digits.test(value)) {
      tests.push(`(${col} >= ? AND ${col} < ?)`);
      params.push(value, next(value));
    } else {
      tests.push(`substr(${col}, 1, ${length}) = ?`);
      params.push(value);
    }
  }
  return { sql: `(${tests.join(' OR ')})`, params };
}
