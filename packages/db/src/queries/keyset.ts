// Keyset pagination — O(1) at any depth, unlike OFFSET (the contracts list is ~12.7k pages). A
// cursor pins the last/first row's (sortValue, id); the next page is `WHERE (sortValue, id) <≷ (?, ?)`.
// Forward ('after') and backward ('before') are symmetric: 'before' flips the comparison + order and
// the caller reverses the rows. The absolute page number is carried in the URL for display only —
// deep random page-jumps are intentionally not offered (they would force OFFSET).

export type SortDir = 'asc' | 'desc';

export interface DecodedCursor {
  dir: 'after' | 'before';
  value: string | number;
  id: string;
  sortToken?: string;
}

export function encodeCursor(
  dir: 'after' | 'before',
  value: string | number,
  id: string,
  sortToken?: string,
): string {
  const tuple = sortToken ? [value, id, sortToken] : [value, id];
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(tuple))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${dir}:${payload}`;
}

export function decodeCursor(
  cursor: string | null | undefined,
  expectedSortToken?: string,
): DecodedCursor | null {
  if (!cursor) return null;
  const i = cursor.indexOf(':');
  if (i < 0) return null;
  const dir = cursor.slice(0, i);
  if (dir !== 'after' && dir !== 'before') return null;
  try {
    const json = decodeURIComponent(
      escape(
        atob(
          cursor
            .slice(i + 1)
            .replace(/-/g, '+')
            .replace(/_/g, '/'),
        ),
      ),
    );
    const [value, id, sortToken] = JSON.parse(json) as [string | number, string, string?];
    if ((typeof value !== 'string' && typeof value !== 'number') || typeof id !== 'string')
      return null;
    if (sortToken != null && typeof sortToken !== 'string') return null;
    if (expectedSortToken && sortToken !== expectedSortToken) return null;
    return { dir, value, id, sortToken };
  } catch {
    return null;
  }
}

export interface KeysetClause {
  whereSql: string; // '' when no cursor; otherwise a parenthesised predicate (no leading AND)
  params: unknown[];
  orderSql: string; // 'ORDER BY <col> <dir>, <idCol> <dir>'
  reverse: boolean; // true → caller must reverse the fetched rows ('before' paging)
  cursor: DecodedCursor | null; // null when absent, malformed, or bound to a different sort
  cursorToken: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function assertSafeColumn(name: string, kind: 'sortCol' | 'idCol', allowlist?: readonly string[]) {
  if (IDENTIFIER.test(name)) return;
  if (allowlist?.includes(name)) return;
  throw new Error(`Unsafe keyset ${kind}: ${name}`);
}

function assertSortDir(dir: string): asserts dir is SortDir {
  if (dir !== 'asc' && dir !== 'desc') throw new Error(`Unsafe keyset dir: ${dir}`);
}

function sortToken(sortCol: string, idCol: string, dir: SortDir): string {
  let h = 5381;
  const input = `${sortCol}\u001f${idCol}\u001f${dir}`;
  for (let i = 0; i < input.length; i += 1) h = ((h << 5) + h) ^ input.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/**
 * Build the keyset WHERE/ORDER for a sort column + id tiebreak. `dir` is the *natural* display
 * direction (desc for money/counts, asc for names). A 'before' cursor inverts both so the caller can
 * fetch the preceding page, then reverse the rows back into display order.
 */
export function keyset(opts: {
  sortCol: string;
  idCol: string;
  dir: SortDir;
  cursor?: string | null;
  allowedSortCols?: readonly string[];
  allowedIdCols?: readonly string[];
}): KeysetClause {
  assertSortDir(opts.dir);
  assertSafeColumn(opts.sortCol, 'sortCol', opts.allowedSortCols);
  assertSafeColumn(opts.idCol, 'idCol', opts.allowedIdCols);
  const token = sortToken(opts.sortCol, opts.idCol, opts.dir);
  const decoded = decodeCursor(opts.cursor, token);
  // 'before' walks against the natural direction.
  const effectiveDir: SortDir =
    decoded?.dir === 'before' ? (opts.dir === 'desc' ? 'asc' : 'desc') : opts.dir;
  const sqlDir = effectiveDir.toUpperCase();
  const cmp = effectiveDir === 'desc' ? '<' : '>';
  const orderSql = `ORDER BY ${opts.sortCol} ${sqlDir}, ${opts.idCol} ${sqlDir}`;
  if (!decoded)
    return { whereSql: '', params: [], orderSql, reverse: false, cursor: null, cursorToken: token };
  const whereSql = `(${opts.sortCol} ${cmp} ? OR (${opts.sortCol} = ? AND ${opts.idCol} ${cmp} ?))`;
  return {
    whereSql,
    params: [decoded.value, decoded.value, decoded.id],
    orderSql,
    reverse: decoded.dir === 'before',
    cursor: decoded,
    cursorToken: token,
  };
}

/** Given the fetched page (already trimmed to pageSize, in display order) decide the Prev/Next cursors. */
export function pageCursors(opts: {
  rows: { sortValue: string | number; id: string }[];
  hasMore: boolean; // an extra row was fetched beyond pageSize on the leading edge
  incomingCursor: string | null | undefined;
  cursor?: DecodedCursor | null;
  sortToken?: string;
}): { nextCursor: string | null; prevCursor: string | null } {
  const { rows, hasMore, incomingCursor, sortToken } = opts;
  const decoded = opts.cursor !== undefined ? opts.cursor : decodeCursor(incomingCursor, sortToken);
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (decoded?.dir === 'before') {
    return {
      prevCursor:
        hasMore && first ? encodeCursor('before', first.sortValue, first.id, sortToken) : null,
      nextCursor: last ? encodeCursor('after', last.sortValue, last.id, sortToken) : null,
    };
  }
  // On the first page (no cursor) there is no Prev. Otherwise Prev anchors before the first row.
  const prevCursor =
    decoded && first ? encodeCursor('before', first.sortValue, first.id, sortToken) : null;
  const nextCursor =
    hasMore && last ? encodeCursor('after', last.sortValue, last.id, sortToken) : null;
  return { nextCursor, prevCursor };
}
