// Contracts — the atomic record. The list reads the base `contracts` table (filtered/sorted, keyset
// page of 15); its headline comes from contract_rollup where the filters allow; facet counts are grouped
// or read from facet_counts; CSV is streamed.

import type { ContractListItem, EntityKind, FacetCount, Page } from '@sigma/api-contract';
import { CPV_SECTORS, PROCEDURE_GROUPS, procedureGroup } from '@sigma/config';
import { cleanName, entityName } from '@sigma/shared';
import { csvResponse } from './csv';
import { assertCovers } from './filter-guard';
import { FRAMEWORK_AGREEMENT } from './framework';
import {
  authoritySlug,
  bareContractId,
  bidderIdFromSlug,
  companySlug,
  contractSlug,
} from './identity';
import { filterSignature, keyset, pageCursors } from './keyset';
import { lookup } from './lookup';
import { searchMatchQuery } from './search';

export type ContractSort = 'value-desc' | 'value-asc' | 'date-desc' | 'date-asc';

export interface ContractListParams {
  sort?: ContractSort;
  years?: string[];
  sectors?: string[];
  procedureGroups?: string[];
  valueBucket?: string | null;
  eu?: 'eu' | 'national' | null;
  authority?: string | null; // authority ЕИК (slug)
  bidder?: string | null; // bidder slug
  q?: string | null;
  bids?: 'one' | null;
  cursor?: string | null;
  pageSize?: number;
}

export const CONTRACT_FILTER_KEYS = [
  'years',
  'sectors',
  'procedureGroups',
  'valueBucket',
  'eu',
  'authority',
  'bidder',
  'q',
  'bids',
] as const satisfies readonly (keyof ContractListParams)[];

// Compile-time completeness guard (issue #138 bug class) — see filter-guard.ts. If this line
// errors, add the new filter key to CONTRACT_FILTER_KEYS.
assertCovers<ContractListParams, typeof CONTRACT_FILTER_KEYS>();

// SYNC: each expr is backed by a matching expression index so a keyset page walks it instead of
// full-scanning + temp-B-tree-sorting the whole table (D1 bills rows scanned). The COALESCE sentinels
// must stay byte-identical to the indexes: value → idx_contracts_value_desc/asc (migrations/0000),
// date → idx_contracts_signed_desc/asc (migrations/0005). Changing a default here without the index
// silently drops the index — list-sort-indexes.test.ts asserts the EXPLAIN plan to catch that.
// Scope: the index-walk guarantee covers the UNFILTERED sort paths; with an active filter the planner
// may prefer the filter's index and temp-sort the (much smaller) filtered set — acceptable by design.
const SORTS: Record<ContractSort, { expr: string; dir: 'asc' | 'desc' }> = lookup({
  'value-desc': { expr: 'COALESCE(c.amount_eur, -1)', dir: 'desc' },
  'value-asc': { expr: 'COALESCE(c.amount_eur, 1e18)', dir: 'asc' },
  'date-desc': { expr: "COALESCE(c.signed_at, '')", dir: 'desc' },
  'date-asc': { expr: "COALESCE(c.signed_at, '9999-99')", dir: 'asc' },
});

// Collapse an untrusted ?sort value to a known key (default otherwise). The query layer already
// falls back internally, but callers must normalize before the value reaches a cache key (edge or
// the CSV R2 object key) — an unvalidated sort would mint unbounded distinct keys for identical
// content. `value in SORTS` is null-prototype-safe (see lookup()).
export function normalizeContractSort(value: string | null | undefined): ContractSort {
  return value != null && value in SORTS ? (value as ContractSort) : 'value-desc';
}

// A real signed_at year is YYYY at the head of the date; everything else (null, empty, malformed)
// lands in the "unknown" bucket, whose facet value/filter token is this sentinel (a non-empty string
// so it survives the URL round-trip — getMulti drops falsy tokens).
const YEAR_KNOWN = "substr(c.signed_at, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'";
const YEAR_UNKNOWN = 'unknown';

const VALUE_BUCKETS: Record<string, [number, number | null]> = lookup({
  lt100k: [0, 100_000],
  '100k-1m': [100_000, 1_000_000],
  '1m-10m': [1_000_000, 10_000_000],
  '10m-100m': [10_000_000, 100_000_000],
  gt100m: [100_000_000, null],
});

const qs = (n: number) => Array.from({ length: n }, () => '?').join(', ');

interface ContractRow {
  id: string;
  subject: string;
  unp: string;
  cpv_code: string | null;
  eu_funded: number | null;
  authority_id: string;
  authority_name: string;
  bidder_id: string;
  bidder_name: string;
  bidder_kind: EntityKind;
  procedure_type: string;
  signed_at: string | null;
  bids_received: number | null;
  amount_eur: number | null;
  value_flag: string;
  framework: number | null;
  signing_value_eur: number | null;
}

const SELECT = `
  SELECT c.id, COALESCE(NULLIF(c.contract_subject, ''), t.title) AS subject, t.source_id AS unp,
         t.cpv_code, c.eu_funded, t.authority_id, a.name AS authority_name,
         c.bidder_id, b.name AS bidder_name, b.kind AS bidder_kind,
         t.procedure_type, c.signed_at, c.bids_received, c.amount_eur, c.value_flag,
         c.framework, c.signing_value_eur`;
const JOINS = `
  JOIN tenders t ON t.id = c.tender_id
  JOIN authorities a ON a.id = t.authority_id
  JOIN bidders b ON b.id = c.bidder_id`;
const FROM = `
  FROM contracts c${JOINS}`;
// The same rows, reached from a candidate set `cand` of contract ids (see drivingFilter); CROSS JOIN keeps the
// candidates as the outer loop.
const FROM_CANDIDATES = `
  FROM cand CROSS JOIN contracts c ON c.id = cand.id${JOINS}`;

/**
 * Build the WHERE fragment (with a leading ' WHERE ') + params shared by list, summary and CSV.
 * Keep consumed filter keys in sync with CONTRACT_FILTER_KEYS and contractFilterSignature().
 */
function buildFilters(p: ContractListParams): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (p.years?.length) {
    // The "Неизвестна" bucket (sentinel) matches null/malformed dates — the complement of YEAR_KNOWN.
    const realYears = p.years.filter((y) => y !== YEAR_UNKNOWN);
    const wantUnknown = realYears.length !== p.years.length;
    const ors: string[] = [];
    if (realYears.length) {
      ors.push(`substr(c.signed_at, 1, 4) IN (${qs(realYears.length)})`);
      params.push(...realYears);
    }
    // `NOT (GLOB)` is NULL (falsy) for a NULL signed_at, so spell out the NULL case to match the facet.
    if (wantUnknown) {
      ors.push(
        `(c.signed_at IS NULL OR NOT (${YEAR_KNOWN}) OR CAST(substr(c.signed_at, 1, 4) AS INTEGER) > ?)`,
      );
      params.push(new Date().getUTCFullYear());
    }
    if (ors.length) where.push(ors.length > 1 ? `(${ors.join(' OR ')})` : ors.join(''));
  }
  if (p.sectors?.length) {
    where.push(`substr(t.cpv_code, 1, 2) IN (${qs(p.sectors.length)})`);
    params.push(...p.sectors);
  }
  if (p.procedureGroups?.length) {
    const types = p.procedureGroups.flatMap(
      (k) => PROCEDURE_GROUPS.find((g) => g.key === k)?.types ?? [],
    );
    if (types.length) {
      where.push(`t.procedure_type IN (${qs(types.length)})`);
      params.push(...types);
    }
  }
  const bucket = p.valueBucket ? VALUE_BUCKETS[p.valueBucket] : undefined;
  if (bucket) {
    const [lo, hi] = bucket;
    where.push(hi == null ? `c.amount_eur >= ?` : `(c.amount_eur >= ? AND c.amount_eur < ?)`);
    params.push(lo);
    if (hi != null) params.push(hi);
  }
  if (p.eu === 'eu') where.push(`c.eu_funded = 1`);
  else if (p.eu === 'national') where.push(`(c.eu_funded IS NULL OR c.eu_funded = 0)`);
  if (p.bids === 'one') where.push(`c.bids_received = 1`);
  if (p.authority) {
    where.push(`t.authority_id = ?`);
    params.push('auth:' + p.authority);
  }
  if (p.bidder) {
    const id = bidderIdFromSlug(p.bidder);
    if (id) {
      where.push(`c.bidder_id = ?`);
      params.push(id);
    } else {
      where.push('1=0');
    }
  }
  const match = searchMatchQuery(p.q ?? '');
  if (match) {
    where.push(
      `c.id IN (SELECT ref FROM search_index WHERE kind = 'contract' AND search_index MATCH ?)`,
    );
    params.push(match);
  }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

function contractFilterSignature(p: ContractListParams): string {
  const bidder = p.bidder ? (bidderIdFromSlug(p.bidder) ?? `invalid:${p.bidder}`) : null;
  const filters = {
    years: p.years,
    sectors: p.sectors,
    procedureGroups: p.procedureGroups,
    valueBucket: p.valueBucket,
    eu: p.eu,
    authority: p.authority,
    bidder,
    q: searchMatchQuery(p.q ?? ''),
    bids: p.bids ?? null,
  } satisfies Record<(typeof CONTRACT_FILTER_KEYS)[number], unknown>;
  return filterSignature(filters);
}

// ── The headline from contract_rollup (migration 0024) ───────────────────────────────────────────
// The rollup holds the list's count, value and unconfirmed values for every combination of its rail filters,
// so the headline is a few primary-key reads instead of a sum over the corpus — which was most of what an
// uncached list page cost. Its dimensions are the list's own expressions (see the migration); a filter it
// does not hold is counted live, as before.

/** The rollup's value for a dimension the filter leaves open. */
const ROLLUP_ALL = '(all)';
const ROLLUP_KEY_DIMS = ['procedure_type', 'eu', 'sector', 'one_offer', 'value_bucket'] as const;

interface RollupSelection {
  /** Per dimension, the values the filter accepts; null when it is left open. */
  dims: Record<(typeof ROLLUP_KEY_DIMS)[number], string[] | null>;
  /** Four-digit years chosen, null when none is. */
  years: string[] | null;
  /** „Неизвестна" chosen: no four-digit year, or one after the current. */
  unknownYear: boolean;
}

/**
 * The rollup rows a filter set selects, or null when it sets a filter the rollup does not hold: an authority,
 * a bidder, a search, a year token that is not four digits (the list matches it against the start of the
 * date, the rollup holds only years and 'unknown'), or an empty sector (the rollup files no code under '').
 * Mirrors buildFilters, including what it ignores: an unknown procedure group, value bucket or EU mode.
 */
function rollupSelection(p: ContractListParams): RollupSelection | null {
  if (p.authority || p.bidder || searchMatchQuery(p.q ?? '')) return null;
  // Each value once: a repeated one would repeat its candidate range below.
  const years = [...new Set(p.years ?? [])].filter((y) => y !== YEAR_UNKNOWN);
  if (years.some((y) => !/^[0-9]{4}$/.test(y))) return null;
  const sectors = [...new Set(p.sectors ?? [])];
  if (sectors.some((s) => s === '')) return null;
  const types = (p.procedureGroups ?? []).flatMap(
    (k) => PROCEDURE_GROUPS.find((g) => g.key === k)?.types ?? [],
  );
  return {
    dims: {
      procedure_type: types.length ? types : null,
      eu: p.eu === 'eu' ? ['1'] : p.eu === 'national' ? ['0'] : null,
      sector: sectors.length ? sectors : null,
      one_offer: p.bids === 'one' ? ['1'] : null,
      value_bucket: p.valueBucket && VALUE_BUCKETS[p.valueBucket] ? [p.valueBucket] : null,
    },
    years: years.length ? years : null,
    unknownYear: (p.years?.length ?? 0) > years.length,
  };
}

const OPEN: RollupSelection = {
  dims: { procedure_type: null, eu: null, sector: null, one_offer: null, value_bucket: null },
  years: null,
  unknownYear: false,
};

/** WHERE over contract_rollup for a selection: an open dimension is its '(all)' row, never a sum of values. */
function rollupWhere(sel: RollupSelection): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const dim of ROLLUP_KEY_DIMS) {
    const values = sel.dims[dim];
    parts.push(values ? `${dim} IN (${qs(values.length)})` : `${dim} = '${ROLLUP_ALL}'`);
    if (values) params.push(...values);
  }
  const years: string[] = [];
  if (sel.years) {
    years.push(`year IN (${qs(sel.years.length)})`);
    params.push(...sel.years);
  }
  // „Неизвестна" is 'unknown' plus every year after the current one, the list's live definition. As text both
  // sort after the current year, and '(all)' before it.
  if (sel.unknownYear) {
    years.push('year > ?');
    params.push(String(new Date().getUTCFullYear()));
  }
  parts.push(years.length > 1 ? `(${years.join(' OR ')})` : (years[0] ?? `year = '${ROLLUP_ALL}'`));
  return { sql: parts.join(' AND '), params };
}

const ROLLUP_GRAND = `(SELECT contracts FROM contract_rollup WHERE ${rollupWhere(OPEN).sql})`;
const missingRollup = (e: unknown) => /no such table:?\s*contract_rollup/i.test(String(e));

type ContractsSummary = { total: number; valueEur: number; suspect: number };

/** The headline from the rollup; null when the filters need a live count or the rollup is not filled yet. */
async function rollupSummary(
  db: D1Database,
  p: ContractListParams,
): Promise<ContractsSummary | null> {
  const sel = rollupSelection(p);
  if (!sel) return null;
  const where = rollupWhere(sel);
  try {
    const row = await db
      .prepare(
        `SELECT ${ROLLUP_GRAND} AS grand, COALESCE(SUM(contracts), 0) AS total,
                COALESCE(SUM(value_eur), 0) AS eur, COALESCE(SUM(unverified), 0) AS suspect
         FROM contract_rollup WHERE ${where.sql}`,
      )
      .bind(...where.params)
      .first<{ grand: number | null; total: number; eur: number; suspect: number }>();
    // A rollup without its all-open row is one the refresh has not filled: count live.
    if (row?.grand == null) return null;
    return { total: row.total, valueEur: row.eur, suspect: row.suspect };
  } catch (e) {
    if (missingRollup(e)) return null;
    throw e;
  }
}

/**
 * A keyset page walks the sort index until it has pageSize + 1 matches. With matches spread evenly that is
 * about (pageSize + 1) × rows in range / matched, so a filter that matches a few hundred contracts reads most
 * of the index for every page. Past this many rows a page is read from candidates instead (drivingFilter).
 */
const WALK_BUDGET = 4000;

/** The successor of a code's last character: [code, next) holds exactly the strings that start with it. */
const prefixEnd = (code: string) =>
  code.slice(0, -1) + String.fromCharCode(code.charCodeAt(code.length - 1) + 1);

interface SortBound {
  lo: string | number;
  hi: string | number | null;
  /** The bound's own filter, for its count in the rollup. */
  only: RollupSelection;
}

/**
 * A range on the sort column that the filters already imply: the chosen signing years under a date sort, the
 * value bucket under a value sort. It removes no row the filters keep, so the page is the same; but the walk
 * starts and stops inside the range instead of first crossing every later year, or every larger amount.
 */
function sortBound(p: ContractListParams, sort: ContractSort): SortBound | null {
  if (sort === 'date-desc' || sort === 'date-asc') {
    const years = p.years ?? [];
    // A matching contract has a signing date that starts with one of the years: never NULL, so either
    // sort expression is the date itself. „Неизвестна" (or any other token) has no such range.
    if (!years.length || !years.every((y) => /^[0-9]{4}$/.test(y))) return null;
    const sorted = [...years].sort();
    return { lo: sorted[0]!, hi: prefixEnd(sorted[sorted.length - 1]!), only: { ...OPEN, years } };
  }
  const bucket = p.valueBucket ? VALUE_BUCKETS[p.valueBucket] : undefined;
  if (!bucket) return null;
  // A matching contract has an amount in [lo, hi), never NULL, so the expression is the amount itself.
  return {
    lo: bucket[0],
    hi: bucket[1],
    only: { ...OPEN, dims: { ...OPEN.dims, value_bucket: [p.valueBucket!] } },
  };
}

/**
 * The ids a sparse filter's page should be read from, or null to walk the sort index as usual. One indexed
 * filter — the signing years as date ranges, the sectors as CPV ranges, the value bucket as an amount range —
 * finds its contracts by its index (INDEXED BY: the cost below assumes that path), and every other filter is
 * applied right there, so only the matches are looked up again. Used when the rollup counts that filter's
 * contracts below the walk. The page query still applies every filter and the same order, so the rows are the
 * same either way; only how they are reached changes.
 */
async function drivingFilter(
  db: D1Database,
  p: ContractListParams,
  filters: { sql: string; params: unknown[] },
  bound: SortBound | null,
  matched: number,
  pageSize: number,
): Promise<{ sql: string; params: unknown[] } | null> {
  const sel = rollupSelection(p);
  if (!sel) return null;
  const rest = filters.sql ? ` AND ${filters.sql.slice(7)}` : '';
  const options: { only: RollupSelection; sql: string; params: unknown[] }[] = [];
  if (sel.years && !sel.unknownYear) {
    options.push({
      only: { ...OPEN, years: sel.years },
      sql: `SELECT c.id FROM contracts c INDEXED BY idx_contracts_signed JOIN tenders t ON t.id = c.tender_id
            WHERE (${sel.years.map(() => '(c.signed_at >= ? AND c.signed_at < ?)').join(' OR ')})${rest}`,
      params: [...sel.years.flatMap((y) => [y, prefixEnd(y)]), ...filters.params],
    });
  }
  const sectors = sel.dims.sector;
  if (sectors?.every((s) => /^[0-9]{2}$/.test(s))) {
    options.push({
      only: { ...OPEN, dims: { ...OPEN.dims, sector: sectors } },
      sql: `SELECT c.id FROM tenders t INDEXED BY idx_tenders_cpv CROSS JOIN contracts c ON c.tender_id = t.id
            WHERE (${sectors.map(() => '(t.cpv_code >= ? AND t.cpv_code < ?)').join(' OR ')})${rest}`,
      params: [...sectors.flatMap((s) => [s, prefixEnd(s)]), ...filters.params],
    });
  }
  const bucket = sel.dims.value_bucket && VALUE_BUCKETS[sel.dims.value_bucket[0]!];
  if (sel.dims.value_bucket && bucket) {
    const [lo, hi] = bucket;
    options.push({
      only: { ...OPEN, dims: { ...OPEN.dims, value_bucket: sel.dims.value_bucket } },
      sql: `SELECT c.id FROM contracts c INDEXED BY idx_contracts_amount_eur JOIN tenders t ON t.id = c.tender_id
            WHERE c.amount_eur >= ?${hi == null ? '' : ' AND c.amount_eur < ?'}${rest}`,
      params: [...(hi == null ? [lo] : [lo, hi]), ...filters.params],
    });
  }
  if (!options.length) return null;
  // The walk's range: the bound's own contracts when the sort is bounded, else every listed one.
  const counts = [rollupWhere(bound?.only ?? OPEN), ...options.map((o) => rollupWhere(o.only))];
  // `grand` is NULL until the refresh fills the rollup; every m<i> is a COALESCEd count, never NULL.
  let row: ({ grand: number | null } & Record<`m${number}`, number>) | null;
  try {
    row = await db
      .prepare(
        `SELECT ${ROLLUP_GRAND} AS grand, ${counts
          .map(
            (w, i) =>
              `(SELECT COALESCE(SUM(contracts), 0) FROM contract_rollup WHERE ${w.sql}) AS m${i}`,
          )
          .join(', ')}`,
      )
      .bind(...counts.flatMap((w) => w.params))
      .first<{ grand: number | null } & Record<`m${number}`, number>>();
  } catch (e) {
    if (missingRollup(e)) return null;
    throw e;
  }
  if (row?.grand == null) return null;
  const range = row.m0!;
  const walk = Math.min(range, ((pageSize + 1) * range) / matched);
  if (walk <= WALK_BUDGET) return null;
  let best: { sql: string; params: unknown[] } | null = null;
  let bestCount = walk;
  for (const [i, o] of options.entries()) {
    const n = row[`m${i + 1}`]!;
    if (n < bestCount) [best, bestCount] = [{ sql: o.sql, params: o.params }, n];
  }
  return best;
}

function toItem(r: ContractRow): ContractListItem {
  const authorityName = cleanName(r.authority_name);
  const bidderName = cleanName(r.bidder_name);
  return {
    id: contractSlug(r.id),
    subject: r.subject,
    unp: r.unp,
    sectorCode: r.cpv_code ? r.cpv_code.slice(0, 2) : null,
    euFunded: r.eu_funded === 1,
    isConsortium: r.bidder_kind === 'consortium',
    authoritySlug: authoritySlug(r.authority_id),
    authorityName,
    bidderSlug: companySlug(r.bidder_id),
    bidderName,
    bidderDisplayName: entityName(bidderName, r.bidder_kind),
    bidderKind: r.bidder_kind,
    procedureLabel: procedureGroup(r.procedure_type).label,
    signedAt: r.signed_at,
    bidsReceived: r.bids_received,
    valueEur: r.amount_eur,
    // A `value_low` row HAS a value and is summed, so without this the list renders it exactly like a
    // trustworthy figure — the headline counts them („N с непотвърдена стойност") while the rows stay
    // silent about which ones. The other verdicts either blank the value (handled by valueEur === null)
    // or are repaired upstream, so this single boolean covers what the list can usefully say.
    valueUnverified: r.value_flag === 'value_low',
    frameworkAgreement: r.framework === FRAMEWORK_AGREEMENT,
    frameworkCeilingEur: r.framework === FRAMEWORK_AGREEMENT ? r.signing_value_eur : null,
  };
}

/**
 * Single-offer contracts (`bids_received = 1`) with a known canonical EUR value — for the homepage
 * section. `mode` picks recency vs highest value. Reuses the shared SELECT/FROM and row mapper.
 */
export async function listSingleOfferContracts(
  db: D1Database,
  mode: 'recent' | 'value',
  limit = 10,
): Promise<ContractListItem[]> {
  const order =
    mode === 'value'
      ? 'ORDER BY c.amount_eur DESC'
      : 'ORDER BY COALESCE(c.signed_at, c.published_at) DESC';
  const rows = await db
    .prepare(
      `${SELECT} ${FROM} WHERE c.bids_received = 1 AND c.amount_eur IS NOT NULL ${order}, c.id LIMIT ?`,
    )
    .bind(limit)
    .all<ContractRow>();
  return rows.results.map(toItem);
}

export interface ContractListResult extends Page<ContractListItem> {
  valueEur: number;
  suspect: number;
}

export async function listContracts(
  db: D1Database,
  p: ContractListParams,
  // The caller may inject a (cached) summary to skip the COUNT/SUM scan — see apps/web KV caching.
  summaryOverride?: { total: number; valueEur: number; suspect: number },
): Promise<ContractListResult> {
  const sortKey = normalizeContractSort(p.sort);
  const sort = SORTS[sortKey];
  const pageSize = p.pageSize ?? 15;
  const filters = buildFilters(p);
  const signature = contractFilterSignature(p);
  const ks = keyset({
    sortCol: sort.expr,
    idCol: 'c.id',
    dir: sort.dir,
    cursor: p.cursor,
    filterSignature: signature,
    allowedSortCols: Object.values(SORTS).map((s) => s.expr),
  });

  const summary = summaryOverride ?? (await contractsSummary(db, p));
  const bound = sortBound(p, sortKey);
  const boundSql = bound
    ? `${sort.expr} >= ?${bound.hi == null ? '' : ` AND ${sort.expr} < ?`}`
    : '';
  const boundParams = bound ? (bound.hi == null ? [bound.lo] : [bound.lo, bound.hi]) : [];
  const conds = [filters.sql ? filters.sql.slice(7) : '', boundSql, ks.whereSql]
    .filter(Boolean)
    .join(' AND ');
  // A filter nothing matches has no page to read: walking the sort index for it reads all of it.
  let results: (ContractRow & { sort_value: string | number })[] = [];
  if (summary.total > 0) {
    const driver = await drivingFilter(db, p, filters, bound, summary.total, pageSize);
    const sql = `${driver ? `WITH cand AS MATERIALIZED (${driver.sql})` : ''}${SELECT}, ${sort.expr} AS sort_value ${driver ? FROM_CANDIDATES : FROM}${conds ? ' WHERE ' + conds : ''} ${ks.orderSql} LIMIT ?`;
    ({ results } = await db
      .prepare(sql)
      .bind(
        ...(driver?.params ?? []),
        ...filters.params,
        ...boundParams,
        ...ks.params,
        pageSize + 1,
      )
      .all<ContractRow & { sort_value: string | number }>());
  }

  const hasMore = results.length > pageSize;
  let rows = results.slice(0, pageSize);
  if (ks.reverse) rows = rows.reverse();

  const cursors = pageCursors({
    rows: rows.map((r) => ({ sortValue: r.sort_value, id: r.id })),
    hasMore,
    incomingCursor: p.cursor,
    cursor: ks.cursor,
    sortToken: ks.cursorToken,
  });

  return {
    items: rows.map(toItem),
    total: summary.total,
    valueEur: summary.valueEur,
    suspect: summary.suspect,
    nextCursor: cursors.nextCursor,
    prevCursor: cursors.prevCursor,
  };
}

/**
 * Total rows, canonical-EUR sum and suspect tally for the current filter (the list headline): from the
 * rollup when the filters are ones it holds, counted live otherwise.
 */
export async function contractsSummary(
  db: D1Database,
  p: ContractListParams,
): Promise<ContractsSummary> {
  return (await rollupSummary(db, p)) ?? liveSummary(db, p);
}

async function liveSummary(db: D1Database, p: ContractListParams): Promise<ContractsSummary> {
  const filters = buildFilters(p);
  // The money sum follows the site-wide value base: every non-NULL amount_eur, regardless of flag.
  // The badge is a separate data-quality metric: NULL values plus value_low rows, which are summed
  // when amount_eur is populated but remain labelled „непотвърдена стойност". A framework agreement's
  // own record is NULL on purpose (its ceiling is not spending), not unconfirmed.
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(c.amount_eur), 0) AS eur,
              SUM(CASE WHEN (c.amount_eur IS NULL AND c.framework IS NOT ${FRAMEWORK_AGREEMENT})
                        OR c.value_flag = 'value_low' THEN 1 ELSE 0 END) AS suspect ${FROM}${filters.sql}`,
    )
    .bind(...filters.params)
    .first<{ total: number; eur: number; suspect: number }>();
  return { total: row?.total ?? 0, valueEur: row?.eur ?? 0, suspect: row?.suspect ?? 0 };
}

export interface ContractFacets {
  years: FacetCount[];
  procedures: FacetCount[]; // folded into the 7 @sigma/config groups
  sectors: FacetCount[]; // present sectors, by contract count
  eu: { all: number; eu: number; national: number };
}

/**
 * Rail facets for the contracts list, read from the precomputed `facet_counts` (precompute.sql and every
 * refresh). Sector and year used to be counted live, by two full scans on every uncached list page: they
 * were the bulk of the rows D1 read, and a crawler walking the list's pages overloaded the database with
 * them. The year buckets keep the live semantics — every real year plus „Неизвестна" for a null or
 * malformed date, so they reconcile with the contracts total. A database the refresh has not yet filled
 * with the sector or year rows is counted live, as before.
 */
export async function getContractFacets(db: D1Database): Promise<ContractFacets> {
  const facetRows = await db
    .prepare(`SELECT facet, key, contracts FROM facet_counts`)
    .all<{ facet: string; key: string; contracts: number }>();
  const rows = facetRows.results;
  const precomputed = (facet: string) => rows.filter((r) => r.facet === facet);
  const sectorRows = precomputed('sector').length
    ? precomputed('sector').map((r) => ({ division: r.key, contracts: r.contracts }))
    : (
        await db
          .prepare(
            `SELECT substr(t.cpv_code, 1, 2) AS division, COUNT(*) AS contracts
             FROM contracts c JOIN tenders t ON t.id = c.tender_id
             GROUP BY division`,
          )
          .all<{ division: string; contracts: number }>()
      ).results;
  const yearRows = precomputed('year').length
    ? precomputed('year').map((r) => ({ key: r.key, contracts: r.contracts }))
    : (
        await db
          .prepare(
            `SELECT CASE WHEN ${YEAR_KNOWN} THEN substr(c.signed_at, 1, 4) ELSE '${YEAR_UNKNOWN}' END AS key,
                    COUNT(*) AS contracts
             FROM contracts c GROUP BY key`,
          )
          .all<{ key: string; contracts: number }>()
      ).results;

  const currentYear = new Date().getUTCFullYear();
  const yearBuckets = new Map<string, number>();
  for (const r of yearRows) {
    const year = Number(r.key);
    const key = r.key === YEAR_UNKNOWN || year > currentYear ? YEAR_UNKNOWN : r.key;
    yearBuckets.set(key, (yearBuckets.get(key) ?? 0) + r.contracts);
  }

  const years = Array.from(yearBuckets, ([key, contracts]) => ({ key, contracts }))
    // Real years descend (newest first); the "Неизвестна" bucket sinks to the bottom of the list.
    .sort((a, b) =>
      a.key === YEAR_UNKNOWN ? 1 : b.key === YEAR_UNKNOWN ? -1 : b.key.localeCompare(a.key),
    )
    .map((r) => ({
      value: r.key,
      label: r.key === YEAR_UNKNOWN ? 'Неизвестна' : r.key,
      count: r.contracts,
    }));

  const procByGroup = new Map<string, number>();
  for (const r of rows.filter((r) => r.facet === 'procedure')) {
    const g = procedureGroup(r.key).key;
    procByGroup.set(g, (procByGroup.get(g) ?? 0) + r.contracts);
  }
  const procedures = PROCEDURE_GROUPS.map((g) => ({
    value: g.key,
    label: g.label,
    count: procByGroup.get(g.key) ?? 0,
  })).filter((f) => f.count > 0);

  const sectorByCode = new Map(sectorRows.map((r) => [r.division, r.contracts]));
  const sectors = CPV_SECTORS.map((s) => ({
    value: s.code,
    label: s.short ?? s.label,
    count: sectorByCode.get(s.code) ?? 0,
  }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count);

  const euRows = rows.filter((r) => r.facet === 'eu');
  const euYes = euRows.find((r) => r.key === '1')?.contracts ?? 0;
  const euNo = euRows.find((r) => r.key === '0')?.contracts ?? 0;

  return { years, procedures, sectors, eu: { all: euYes + euNo, eu: euYes, national: euNo } };
}

// ── CSV export — streamed (never buffered): keyset-walks the filtered set in 1k-row chunks ─────────

const CSV_COLUMNS = [
  'id',
  'unp',
  'subject',
  'authority',
  'authority_eik',
  'contractor',
  'contractor_eik',
  'kind',
  'sector_code',
  'procedure',
  'signed_at',
  'value_eur',
  'eu_funded',
  'bids_received',
  // The record of a framework agreement has an empty value_eur on purpose: this is its ceiling instead.
  'framework_ceiling_eur',
] as const;

interface CsvRow extends ContractRow {
  rowid: number;
  authority_eik: string;
  contractor_eik: string | null;
}

/** A streamed text/csv Response honouring the same filters; a 190k-row export never materialises. */
export function streamContractsCsv(db: D1Database, p: ContractListParams): Response {
  const filters = buildFilters(p);
  const CHUNK = 1000;
  let afterRowid = 0;
  const where = filters.sql ? filters.sql + ' AND c.rowid > ?' : ' WHERE c.rowid > ?';
  const sql = `${SELECT}, c.rowid AS rowid, a.bulstat AS authority_eik, b.eik_normalized AS contractor_eik
        ${FROM}${where} ORDER BY c.rowid LIMIT ?`;
  return csvResponse(
    CSV_COLUMNS,
    CHUNK,
    async () => {
      const { results } = await db
        .prepare(sql)
        .bind(...filters.params, afterRowid, CHUNK)
        .all<CsvRow>();
      if (results.length) afterRowid = results[results.length - 1]!.rowid;
      return results;
    },
    (r) => [
      // CSV carries the RAW id (no URL escaping): literal `/`, `%`, … — not the `%2F`/`%25`
      // path-safe slug (contractSlug), which exists only for hrefs. A data export wants the true
      // id for joins/lookups, so this is deliberately NOT the URL form (#221 review).
      bareContractId(r.id),
      r.unp,
      r.subject,
      cleanName(r.authority_name),
      r.authority_eik,
      entityName(cleanName(r.bidder_name), r.bidder_kind),
      r.contractor_eik,
      r.bidder_kind,
      r.cpv_code ? r.cpv_code.slice(0, 2) : '',
      procedureGroup(r.procedure_type).label,
      r.signed_at,
      r.amount_eur,
      r.eu_funded === 1 ? '1' : '0',
      r.bids_received,
      r.framework === FRAMEWORK_AGREEMENT ? r.signing_value_eur : null,
    ],
    'sigma-contracts.csv',
  );
}
