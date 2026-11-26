import { describe, expect, it, vi } from 'vitest';
import { fakeD1 } from '@sigma/test-support';
import type { SearchGroup, SearchResults } from '@sigma/api-contract';

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));
// The route now wraps the env in getDb() before calling search (#225, the read-only D1 chokepoint for
// #199); stub it as a pass-through so search still receives a non-null handle and the call-args
// assertions hold.
// The refusal check (lib/retry.ts) keeps the real D1 overload predicate.
vi.mock('@sigma/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sigma/db')>()),
  search: searchMock,
  getDb: (env: unknown) => env,
}));

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
    // search() is mocked, so the binding is only ever passed along, never queried — a route-less
    // double turns any real query into a failure instead of a silent empty answer.
    return { cloudflare: { env: { DB: fakeD1([]).db } } } as never;
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

  it('answers an empty, unstored, degraded list when D1 refuses the read', async () => {
    // getDb's retrying wrapper turns D1's back-pressure into a 503 Response; the raw error counts too.
    for (const refusal of [
      new Response('D1 is overloaded', { status: 503 }),
      new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'),
    ]) {
      searchMock.mockRejectedValueOnce(refusal);
      const res = await loader({
        request: new Request('https://x/search/suggest?q=%20тест%20'),
        context: ctx(),
      } as never);
      expect(res.data).toEqual({ query: 'тест', groups: [], empty: true });
      expect(res.init?.status ?? 200).toBe(200);
      expect(res.init?.headers).toMatchObject({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Sigma-Degraded': 'suggest',
      });
    }
  });

  it('still fails on any other error', async () => {
    searchMock.mockRejectedValueOnce(new Error('D1_ERROR: no such table: search_index'));
    await expect(
      loader({ request: new Request('https://x/search/suggest?q=тест'), context: ctx() } as never),
    ).rejects.toThrow('no such table');
  });

  it('defaults the query to an empty string when q is absent', async () => {
    searchMock.mockResolvedValueOnce({ query: '', groups: [] } as SearchResults);
    await loader({ request: new Request('https://x/search/suggest'), context: ctx() } as never);
    expect(searchMock).toHaveBeenCalledWith(expect.anything(), '');
  });
});
