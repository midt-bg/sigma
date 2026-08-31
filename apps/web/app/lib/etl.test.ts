import { describe, expect, it } from 'vitest';
import { isMissingDerivedTableError } from './etl';

describe('isMissingDerivedTableError', () => {
  it('matches the real D1 "no such table" error shape for contract_features', () => {
    expect(
      isMissingDerivedTableError(
        new Error('D1_ERROR: no such table: contract_features: SQLITE_ERROR'),
      ),
    ).toBe(true);
  });

  it('matches when the table name is schema-qualified', () => {
    expect(isMissingDerivedTableError(new Error('no such table: main.contract_features'))).toBe(
      true,
    );
  });

  it('does not match a missing-table error for an unrelated table', () => {
    expect(isMissingDerivedTableError(new Error('D1_ERROR: no such table: some_other_table'))).toBe(
      false,
    );
  });

  it('does not match a non-Error thrown value that happens to mention the phrase', () => {
    expect(isMissingDerivedTableError('unrelated failure')).toBe(false);
  });
});
