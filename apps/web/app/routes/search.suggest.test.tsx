import { describe, expect, it, vi } from 'vitest';
import type { SearchGroup, SearchResults } from '@sigma/api-contract';

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));
vi.mock('@sigma/db', () => ({ search: searchMock }));

import { loader, trimGroup } from './search.suggest';

function hit(id: string) {
  return {
    kind: 'contract',
    ref: id,
    title: id,
    subtitle: '',
  } as unknown as SearchGroup['hits'][number];
}

function group(kind: string, n: number): SearchGroup {
  return { kind, hits: Array.from({ length: n }, (_, i) => hit(`${kind}-${i}`)) } as SearchGroup;
}

describe('trimGroup', () => {
  it('returns the group unchanged when at or under the per-group cap', () => {
    const g = group('company', 4);
    expect(trimGroup(g)).toBe(g); // same reference — no copy
  });

  it('caps a group to the first SUGGEST_PER_GROUP hits', () => {
    const trimmed = trimGroup(group('company', 9));
    expect(trimmed.hits).toHaveLength(4);
    expect(trimmed.hits.map((h) => h.ref)).toEqual([
      'company-0',
      'company-1',
      'company-2',
      'company-3',
    ]);
  });
});

describe('loader', () => {
  function ctx() {
    return { cloudflare: { env: { DB: {} as D1Database } } } as never;
  }

  it('runs the ranked FTS query, trims every group, and sets the JSON + short-cache headers', async () => {
    const results: SearchResults = {
      query: 'ео',
      groups: [group('company', 6), group('authority', 2)],
    } as SearchResults;
    searchMock.mockResolvedValueOnce(results);

    const res = await loader({
      request: new Request('https://x/search/suggest?q=ео'),
      context: ctx(),
    } as never);

    expect(searchMock).toHaveBeenCalledWith(expect.anything(), 'ео');
    const payload = res.data as SearchResults;
    expect(payload.groups[0]!.hits).toHaveLength(4); // trimmed
    expect(payload.groups[1]!.hits).toHaveLength(2); // untouched
    expect(res.init?.headers).toMatchObject({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=86400',
    });
  });

  it('defaults the query to an empty string when q is absent', async () => {
    searchMock.mockResolvedValueOnce({ query: '', groups: [] } as SearchResults);
    await loader({ request: new Request('https://x/search/suggest'), context: ctx() } as never);
    expect(searchMock).toHaveBeenCalledWith(expect.anything(), '');
  });
});
