import { describe, expect, it } from 'vitest';
import { prefixIn } from './prefix-in';

describe('a prefix filter an index can serve', () => {
  it('turns a value of digits into the range of everything that begins with it', () => {
    expect(prefixIn('t.cpv_code', 2, ['45'])).toEqual({
      sql: '((t.cpv_code >= ? AND t.cpv_code < ?))',
      params: ['45', '46'],
    });
    // The character after „9" closes the last range of a digit.
    expect(prefixIn('t.cpv_code', 2, ['09', '99']).params).toEqual(['09', '0:', '99', '9:']);
    expect(prefixIn('c.signed_at', 4, ['2024']).params).toEqual(['2024', '2025']);
  });

  it('joins several values as alternatives', () => {
    expect(prefixIn('t.cpv_code', 2, ['45', '72']).sql).toBe(
      '((t.cpv_code >= ? AND t.cpv_code < ?) OR (t.cpv_code >= ? AND t.cpv_code < ?))',
    );
  });

  it('keeps the exact test for a value that is not digits of the asked length', () => {
    expect(prefixIn('t.cpv_code', 2, ['4', 'ab', '450'])).toEqual({
      sql: '(substr(t.cpv_code, 1, 2) = ? OR substr(t.cpv_code, 1, 2) = ? OR substr(t.cpv_code, 1, 2) = ?)',
      params: ['4', 'ab', '450'],
    });
  });
});
