import { describe, expect, it } from 'vitest';
import { prefixIn } from './prefix-in';

describe('a prefix filter an index can serve', () => {
  it('turns a digit prefix into an indexed range with one bind', () => {
    expect(prefixIn('t.cpv_code', 2, ['45'])).toEqual({
      sql: "((t.cpv_code >= ? AND t.cpv_code < '46'))",
      params: ['45'],
    });
    expect(prefixIn('c.signed_at', 4, ['2024'])).toEqual({
      sql: "((c.signed_at >= ? AND c.signed_at < '2025'))",
      params: ['2024'],
    });
  });

  it('joins alternatives and closes prefixes ending in 9 at the next ASCII character', () => {
    expect(prefixIn('t.cpv_code', 2, ['09', '99'])).toEqual({
      sql: "((t.cpv_code >= ? AND t.cpv_code < '0:') OR (t.cpv_code >= ? AND t.cpv_code < '9:'))",
      params: ['09', '99'],
    });
  });

  it('binds nonnumeric or wrong-length values in the exact test even in a mixed filter', () => {
    const other = ['4', '450', "4'", '4*', '4\n', '４５'];
    expect(prefixIn('t.cpv_code', 2, ['45', ...other])).toEqual({
      sql: `((t.cpv_code >= ? AND t.cpv_code < '46') OR ${other.map(() => 'substr(t.cpv_code, 1, 2) = ?').join(' OR ')})`,
      params: ['45', ...other],
    });
  });
});
