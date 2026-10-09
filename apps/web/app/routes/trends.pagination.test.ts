import { describe, expect, it } from 'vitest';
import { CONTRACT_CARD_LIMIT, paginateContracts } from './trends';

// Regression for the off-by-one: "показани първите 24" must appear only when there really is a
// 25th row hidden, never when exactly 24 rows exist untruncated.
describe('paginateContracts', () => {
  it('does not flag truncation when exactly pageSize rows are returned', () => {
    const rows = Array.from({ length: CONTRACT_CARD_LIMIT }, (_, i) => i);

    const { items, truncated } = paginateContracts(rows, CONTRACT_CARD_LIMIT);

    expect(truncated).toBe(false);
    expect(items).toHaveLength(CONTRACT_CARD_LIMIT);
    expect(items).toEqual(rows);
  });

  it('flags truncation and slices to pageSize when pageSize + 1 rows are returned', () => {
    const rows = Array.from({ length: CONTRACT_CARD_LIMIT + 1 }, (_, i) => i);

    const { items, truncated } = paginateContracts(rows, CONTRACT_CARD_LIMIT);

    expect(truncated).toBe(true);
    expect(items).toHaveLength(CONTRACT_CARD_LIMIT);
    expect(items).toEqual(rows.slice(0, CONTRACT_CARD_LIMIT));
  });

  it('never flags truncation when fewer than pageSize rows exist', () => {
    const rows = [1, 2, 3];

    const { items, truncated } = paginateContracts(rows, CONTRACT_CARD_LIMIT);

    expect(truncated).toBe(false);
    expect(items).toEqual(rows);
  });
});
