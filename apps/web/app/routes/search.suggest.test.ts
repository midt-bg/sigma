import { describe, expect, it } from 'vitest';
import { trimGroup } from './search.suggest';
import type { SearchGroup } from '@sigma/api-contract';

function makeGroup(count: number): SearchGroup {
  return {
    kind: 'authority',
    label: 'Институции',
    total: count,
    moreHref: null,
    hits: Array.from({ length: count }, (_, i) => ({
      kind: 'authority' as const,
      slug: `slug-${i}`,
      title: `Institution ${i}`,
      href: `/authorities/slug-${i}`,
      subtitle: null,
      ident: null,
      amountEur: null,
      amountLabel: '',
    })),
  };
}

describe('trimGroup', () => {
  it('returns the group unchanged when hits are within the limit', () => {
    const group = makeGroup(3);
    expect(trimGroup(group)).toBe(group);
  });

  it('returns the group unchanged when hits are exactly at the limit', () => {
    const group = makeGroup(4);
    expect(trimGroup(group)).toBe(group);
  });

  it('trims hits to 4 when the group exceeds the limit', () => {
    const group = makeGroup(7);
    const trimmed = trimGroup(group);
    expect(trimmed.hits).toHaveLength(4);
  });

  it('returns a new object instead of mutating the original', () => {
    const group = makeGroup(6);
    const trimmed = trimGroup(group);
    expect(trimmed).not.toBe(group);
    expect(group.hits).toHaveLength(6);
  });

  it('preserves the first hits in order', () => {
    const group = makeGroup(6);
    const trimmed = trimGroup(group);
    expect(trimmed.hits[0].slug).toBe('slug-0');
    expect(trimmed.hits[3].slug).toBe('slug-3');
  });
});
