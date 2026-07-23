import { describe, expect, it } from 'vitest';
import { AUTHORITY_FILTER_KEYS } from './authorities';
import { COMPANY_FILTER_KEYS } from './companies';
import { CONTRACT_FILTER_KEYS } from './contracts';
import {
  MAX_CURSOR_CHARS,
  decodeCursor,
  encodeCursor,
  filterSignature,
  keyset,
  pageCursors,
} from './keyset';

const FILTER_VALUE: Record<string, unknown> = {
  authority: '000695089',
  bidder: '103267194',
  bids: 'one',
  countBucket: '2-5',
  eu: 'eu',
  kinds: ['company'],
  procedureGroups: ['open'],
  q: 'rail',
  sectors: ['45'],
  types: ['municipality'],
  valueBucket: 'gt100m',
  years: ['2025'],
};

function singleFilter(key: string): Record<string, unknown> {
  return { [key]: FILTER_VALUE[key] };
}

describe('cursor encode/decode', () => {
  it('round-trips a [value, id] pair', () => {
    const c = encodeCursor('after', 50_840_000_000, 'eik:103267194');
    const d = decodeCursor(c);
    expect(d).toEqual({ dir: 'after', value: 50_840_000_000, id: 'eik:103267194' });
  });
  it('round-trips Cyrillic string values and UTF-8 ids', () => {
    const c = encodeCursor('before', 'доставка на услуги', 'auth:тест-123', 'abc123');
    const d = decodeCursor(c);
    expect(d).toEqual({
      dir: 'before',
      value: 'доставка на услуги',
      id: 'auth:тест-123',
      sortToken: 'abc123',
    });
  });
  it('rejects malformed cursors', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('garbage')).toBeNull();
    expect(decodeCursor('sideways:Zm9v')).toBeNull();
  });
  it('rejects oversized cursors before decoding them', () => {
    // A multi-KB ?cursor must be refused outright, not run through atob/JSON.parse.
    const huge = `after:${'A'.repeat(5000)}`;
    expect(decodeCursor(huge)).toBeNull();
  });
  it('ignores cursors bound to a different sort token', () => {
    const c = encodeCursor('after', 10, 'x', 'old-sort');
    expect(decodeCursor(c, 'new-sort')).toBeNull();
  });
  it('ignores tokenless cursors when a sort token is expected', () => {
    const c = encodeCursor('after', 10, 'x');
    expect(decodeCursor(c, 'new-sort')).toBeNull();
  });
  it('builds canonical filter signatures for set-valued params', () => {
    expect(filterSignature({ sectors: ['45', '30', '45'], eu: 'eu', empty: [] })).toBe(
      filterSignature({ eu: 'eu', sectors: ['30', '45'] }),
    );
  });
});

describe('route filter signatures', () => {
  it('declares the filter keys consumed by each route WHERE builder', () => {
    expect([...CONTRACT_FILTER_KEYS]).toEqual([
      'years',
      'sectors',
      'procedureGroups',
      'valueBucket',
      'eu',
      'authority',
      'bidder',
      'q',
      'bids',
    ]);
    expect([...COMPANY_FILTER_KEYS]).toEqual([
      'kinds',
      'countBucket',
      'sectors',
      'years',
      'eu',
      'q',
    ]);
    expect([...AUTHORITY_FILTER_KEYS]).toEqual(['types', 'sectors', 'years', 'eu', 'q']);
  });

  it.each([
    ['contracts', CONTRACT_FILTER_KEYS],
    ['companies', COMPANY_FILTER_KEYS],
    ['authorities', AUTHORITY_FILTER_KEYS],
  ])('binds every %s filter key into the cursor filter signature', (_route, keys) => {
    const empty = filterSignature({});
    for (const key of keys) {
      expect(filterSignature(singleFilter(key))).not.toBe(empty);
      expect(filterSignature(singleFilter(key))).toBe(filterSignature(singleFilter(key)));
    }
  });
});

describe('keyset clause', () => {
  it('orders desc with no cursor', () => {
    const k = keyset({ sortCol: 'won_eur', idCol: 'bidder_id', dir: 'desc' });
    expect(k.whereSql).toBe('');
    expect(k.orderSql).toBe('ORDER BY won_eur DESC, bidder_id DESC');
    expect(k.reverse).toBe(false);
  });
  it('builds a forward (after) predicate keeping the natural direction', () => {
    const firstPage = keyset({ sortCol: 'won_eur', idCol: 'bidder_id', dir: 'desc' });
    const cursor = encodeCursor('after', 1000, 'x', firstPage.cursorToken);
    const k = keyset({ sortCol: 'won_eur', idCol: 'bidder_id', dir: 'desc', cursor });
    expect(k.whereSql).toContain('won_eur < ?');
    expect(k.orderSql).toContain('DESC');
    expect(k.params).toEqual([1000, 1000, 'x']);
    expect(k.reverse).toBe(false);
  });
  it('accepts cursors minted under the same filter signature', () => {
    const signature = filterSignature({ sectors: ['30', '45'], eu: 'eu' });
    const firstPage = keyset({
      sortCol: 'won_eur',
      idCol: 'bidder_id',
      dir: 'desc',
      filterSignature: signature,
    });
    const cursor = encodeCursor('after', 1000, 'x', firstPage.cursorToken);
    const k = keyset({
      sortCol: 'won_eur',
      idCol: 'bidder_id',
      dir: 'desc',
      cursor,
      filterSignature: filterSignature({ eu: 'eu', sectors: ['45', '30'] }),
    });

    expect(k.cursor).toMatchObject({ dir: 'after', value: 1000, id: 'x' });
    expect(k.params).toEqual([1000, 1000, 'x']);
  });
  it('rejects cursors replayed under a different filter signature', () => {
    const oldPage = keyset({
      sortCol: 'won_eur',
      idCol: 'bidder_id',
      dir: 'desc',
      filterSignature: filterSignature({ sectors: ['30'] }),
    });
    const cursor = encodeCursor('after', 1000, 'x', oldPage.cursorToken);
    const k = keyset({
      sortCol: 'won_eur',
      idCol: 'bidder_id',
      dir: 'desc',
      cursor,
      filterSignature: filterSignature({ sectors: ['45'] }),
    });

    expect(k.cursor).toBeNull();
    expect(k.whereSql).toBe('');
    expect(k.params).toEqual([]);
  });
  it('inverts direction for a backward (before) cursor and flags reverse', () => {
    const firstPage = keyset({ sortCol: 'won_eur', idCol: 'bidder_id', dir: 'desc' });
    const cursor = encodeCursor('before', 1000, 'x', firstPage.cursorToken);
    const k = keyset({ sortCol: 'won_eur', idCol: 'bidder_id', dir: 'desc', cursor });
    expect(k.whereSql).toContain('won_eur > ?');
    expect(k.orderSql).toBe('ORDER BY won_eur ASC, bidder_id ASC');
    expect(k.reverse).toBe(true);
  });
  it('rejects an unsafe sort direction (guards a non-TS/hostile caller)', () => {
    expect(() =>
      keyset({ sortCol: 'won_eur', idCol: 'bidder_id', dir: 'sideways' as 'asc' }),
    ).toThrow(/Unsafe keyset dir/);
  });
  it('inverts an ascending sort for a backward (before) cursor', () => {
    // dir='asc' + before ⇒ effectiveDir flips to desc: the `opts.dir === 'desc' ? 'asc' : 'desc'`
    // else-branch. Walks backward through an ascending list.
    const firstPage = keyset({ sortCol: 'won_eur', idCol: 'bidder_id', dir: 'asc' });
    const cursor = encodeCursor('before', 1000, 'x', firstPage.cursorToken);
    const k = keyset({ sortCol: 'won_eur', idCol: 'bidder_id', dir: 'asc', cursor });
    expect(k.whereSql).toContain('won_eur < ?');
    expect(k.orderSql).toBe('ORDER BY won_eur DESC, bidder_id DESC');
    expect(k.reverse).toBe(true);
  });
  it('rejects unsafe sort fragments unless explicitly allowlisted', () => {
    expect(() =>
      keyset({ sortCol: 'won_eur; DROP TABLE contracts', idCol: 'bidder_id', dir: 'desc' }),
    ).toThrow(/Unsafe keyset sortCol/);
    expect(
      keyset({
        sortCol: 'COALESCE(c.amount_eur, -1)',
        idCol: 'c.id',
        dir: 'desc',
        allowedSortCols: ['COALESCE(c.amount_eur, -1)'],
      }).orderSql,
    ).toBe('ORDER BY COALESCE(c.amount_eur, -1) DESC, c.id DESC');
  });
});

describe('pageCursors', () => {
  const rows = [
    { sortValue: 900, id: 'a' },
    { sortValue: 800, id: 'b' },
  ];
  it('first page: no prev, next when more', () => {
    const { prevCursor, nextCursor } = pageCursors({ rows, hasMore: true, incomingCursor: null });
    expect(prevCursor).toBeNull();
    expect(decodeCursor(nextCursor)).toMatchObject({ dir: 'after', value: 800, id: 'b' });
  });
  it('later page: prev anchors before the first row, no next on last page', () => {
    const incoming = encodeCursor('after', 1000, 'z');
    const { prevCursor, nextCursor } = pageCursors({
      rows,
      hasMore: false,
      incomingCursor: incoming,
    });
    expect(decodeCursor(prevCursor)).toMatchObject({ dir: 'before', value: 900, id: 'a' });
    expect(nextCursor).toBeNull();
  });
  it('before page with no rows: both cursors null (empty prev-page)', () => {
    // Walking backward off the top: the query returns zero rows, so there is neither a first nor a
    // last row → the `last ? … : null` and `hasMore && first ? … : null` else-branches both yield null.
    const incoming = encodeCursor('before', 700, 'c');
    const { prevCursor, nextCursor } = pageCursors({
      rows: [],
      hasMore: false,
      incomingCursor: incoming,
    });
    expect(prevCursor).toBeNull();
    expect(nextCursor).toBeNull();
  });
  it('before page: next always returns toward the page we came from, prev only when more', () => {
    const incoming = encodeCursor('before', 700, 'c');
    const noMore = pageCursors({
      rows,
      hasMore: false,
      incomingCursor: incoming,
    });
    expect(noMore.prevCursor).toBeNull();
    expect(decodeCursor(noMore.nextCursor)).toMatchObject({ dir: 'after', value: 800, id: 'b' });

    const more = pageCursors({
      rows,
      hasMore: true,
      incomingCursor: incoming,
    });
    expect(decodeCursor(more.prevCursor)).toMatchObject({ dir: 'before', value: 900, id: 'a' });
    expect(decodeCursor(more.nextCursor)).toMatchObject({ dir: 'after', value: 800, id: 'b' });
  });
});

describe('decodeCursor — malformed and hostile input', () => {
  const enc = (tuple: unknown) =>
    'after:' +
    btoa(unescape(encodeURIComponent(JSON.stringify(tuple))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  it('rejects an oversized cursor before running the decode pipeline', () => {
    // A raw run of 'A's is not decodable, so it would be rejected by the try/catch even without the
    // length guard. Use a payload that WOULD decode to a valid tuple: only the length guard can reject
    // it, so this actually exercises line 39 rather than the JSON.parse catch.
    const oversizedButValid = enc([1, 'x'.repeat(600)]); // > MAX_CURSOR_CHARS once base64-expanded
    expect(oversizedButValid.length).toBeGreaterThan(MAX_CURSOR_CHARS);
    expect(decodeCursor(oversizedButValid)).toBeNull();
    // A valid cursor just under the limit must still decode — the guard rejects only the oversized.
    const underLimit = enc([1, 'y'.repeat(300)]);
    expect(underLimit.length).toBeLessThanOrEqual(MAX_CURSOR_CHARS);
    expect(decodeCursor(underLimit)).toMatchObject({ dir: 'after', value: 1 });
  });
  it('rejects a payload that is not valid JSON (decode pipeline throws)', () => {
    expect(decodeCursor('after:' + btoa('not json').replace(/=+$/, ''))).toBeNull();
  });
  it('rejects a non-string/number sort value or a non-string id', () => {
    expect(decodeCursor(enc([{}, 'id']))).toBeNull();
    expect(decodeCursor(enc(['v', 123]))).toBeNull();
  });
  it('rejects a non-string sortToken', () => {
    expect(decodeCursor(enc(['v', 'id', 123]))).toBeNull();
  });
  it('rejects a cursor whose sortToken does not match the expected one', () => {
    const c = encodeCursor('after', 'v', 'id', 'tokA');
    expect(decodeCursor(c, 'tokB')).toBeNull();
    expect(decodeCursor(c, 'tokA')).toMatchObject({ sortToken: 'tokA' });
  });
});
