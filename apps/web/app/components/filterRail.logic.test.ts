import { describe, expect, it } from 'vitest';
import {
  categorySelectionState,
  filterFormKey,
  preservedParamInputs,
  shouldPruneField,
} from './filterRail.logic';

describe('categorySelectionState', () => {
  it('reports none selected when the intersection is empty', () => {
    const state = categorySelectionState(['a', 'b', 'c'], []);
    expect(state.selectedCount).toBe(0);
    expect(state.someSelected).toBe(false);
    expect(state.allSelected).toBe(false);
  });

  it('reports a partial (indeterminate) selection', () => {
    const state = categorySelectionState(['a', 'b', 'c'], ['b']);
    expect(state.selectedCount).toBe(1);
    expect(state.someSelected).toBe(true);
    expect(state.allSelected).toBe(false);
  });

  it('reports all selected when every option is present', () => {
    const state = categorySelectionState(['a', 'b'], ['a', 'b']);
    expect(state.selectedCount).toBe(2);
    expect(state.someSelected).toBe(true);
    expect(state.allSelected).toBe(true);
  });

  it('ignores selected values outside the category', () => {
    const state = categorySelectionState(['a', 'b'], ['a', 'x', 'y']);
    expect(state.selectedCount).toBe(1);
    expect(state.allSelected).toBe(false);
    expect(state.someSelected).toBe(true);
  });

  it('is never allSelected for an empty category', () => {
    const state = categorySelectionState([], ['a']);
    expect(state.selectedCount).toBe(0);
    expect(state.allSelected).toBe(false);
    expect(state.someSelected).toBe(false);
  });

  it('accepts a Set as the selected collection', () => {
    const state = categorySelectionState(['a', 'b'], new Set(['a', 'b']));
    expect(state.allSelected).toBe(true);
  });
});

describe('preservedParamInputs', () => {
  const groupKeys = ['sector', 'procedure', 'year', 'value', 'eu'];

  it('returns nothing when the URL holds only form-owned params', () => {
    const sp = new URLSearchParams('sort=value-desc&sector=45&year=2026&cursor=after:x&page=3');
    expect(preservedParamInputs(sp, groupKeys)).toEqual([]);
  });

  it('preserves the search param `q` so a filter submit cannot erase it (regression #181)', () => {
    const sp = new URLSearchParams('q=път&sector=45&sort=value-desc');
    expect(preservedParamInputs(sp, groupKeys)).toEqual([{ key: 'q', value: 'път' }]);
  });

  it('preserves `bids` so the single-offer view survives a filter submit (regression #181)', () => {
    const sp = new URLSearchParams('bids=1&year=2026&sort=date-desc');
    expect(preservedParamInputs(sp, groupKeys)).toEqual([{ key: 'bids', value: '1' }]);
  });

  it('preserves the authority/bidder scope params', () => {
    const sp = new URLSearchParams('authority=abc&bidder=xyz&sector=45');
    expect(preservedParamInputs(sp, groupKeys)).toEqual([
      { key: 'authority', value: 'abc' },
      { key: 'bidder', value: 'xyz' },
    ]);
  });

  it('never re-emits a group key, sort, cursor or page', () => {
    const sp = new URLSearchParams('sector=45&sort=value-desc&cursor=after:x&page=2&q=x');
    expect(preservedParamInputs(sp, groupKeys)).toEqual([{ key: 'q', value: 'x' }]);
  });

  it('preserves repeated values of a carried param', () => {
    const sp = new URLSearchParams('bidder=a&bidder=b');
    expect(preservedParamInputs(sp, groupKeys)).toEqual([
      { key: 'bidder', value: 'a' },
      { key: 'bidder', value: 'b' },
    ]);
  });
});

describe('shouldPruneField', () => {
  const groupKeys = new Set(['value', 'eu', 'year']);

  it('prunes an empty „Всички" radio (a group-key control)', () => {
    expect(shouldPruneField({ name: 'value', value: '' }, groupKeys)).toBe(true);
    expect(shouldPruneField({ name: 'eu', value: '' }, groupKeys)).toBe(true);
  });

  it('keeps a group control that carries a value', () => {
    expect(shouldPruneField({ name: 'year', value: '2026' }, groupKeys)).toBe(false);
  });

  it('never prunes a non-group field, even when empty (hidden sort / preserved q)', () => {
    expect(shouldPruneField({ name: 'sort', value: '' }, groupKeys)).toBe(false);
    expect(shouldPruneField({ name: 'q', value: '' }, groupKeys)).toBe(false);
  });

  it('never prunes an unnamed control (the submit button)', () => {
    expect(shouldPruneField({ name: '', value: '' }, groupKeys)).toBe(false);
  });
});

describe('filterFormKey', () => {
  it('changes when a filter param changes (so the form remounts and re-reads defaultChecked)', () => {
    expect(filterFormKey(new URLSearchParams('year=2026'))).not.toBe(
      filterFormKey(new URLSearchParams('year=2025')),
    );
  });

  it('is stable across pagination so paging preserves open groups and focus', () => {
    expect(filterFormKey(new URLSearchParams('year=2026&cursor=after:x&page=2'))).toBe(
      filterFormKey(new URLSearchParams('year=2026')),
    );
  });

  it('is stable across re-sorting (sort is a view option, not a filter)', () => {
    expect(filterFormKey(new URLSearchParams('year=2026&sort=date-desc'))).toBe(
      filterFormKey(new URLSearchParams('year=2026')),
    );
  });
});
