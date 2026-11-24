// The page query of a leaderboard (companies, authorities).
//
// Over the rollup table it is an indexed read, and the total is a second, cheap query. Over a scoped
// aggregation — a sector, year or funding cross-cut built from the contracts themselves — the aggregation
// is the whole cost, and running it once for the page and once more for the total doubled the time the
// database was held. There the aggregation is materialised once and the page carries the total with it,
// as a `total` column on every row.
import { NAME_KEY, withNameKey } from './name-sort';

export function pageSql(o: {
  cols: string;
  sortCol: string;
  /** The rollup table, or the scoped aggregation as a derived table. */
  from: string;
  scoped: boolean;
  /** Entity-level WHERE, without the keyword; may be empty. */
  where: string;
  ks: { whereSql: string; orderSql: string };
}): string {
  const named = (from: string) => (o.sortCol === NAME_KEY ? withNameKey(from) : from);
  const select = `SELECT ${o.cols}, ${o.sortCol} AS sort_value`;
  if (!o.scoped) {
    const conds = [o.where, o.ks.whereSql].filter(Boolean).join(' AND ');
    return `${select} FROM ${named(o.from)}${conds ? ' WHERE ' + conds : ''} ${o.ks.orderSql} LIMIT ?`;
  }
  const within = o.ks.whereSql ? ' WHERE ' + o.ks.whereSql : '';
  return `WITH scoped AS MATERIALIZED (SELECT * FROM ${o.from}${o.where ? ' WHERE ' + o.where : ''})
${select}, (SELECT COUNT(*) FROM scoped) AS total FROM ${named('scoped')}${within} ${o.ks.orderSql} LIMIT ?`;
}
